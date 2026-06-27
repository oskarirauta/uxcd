#include <fstream>
#include <iterator>
#include <deque>
#include <vector>
#include <map>
#include <cstring>
#include <cerrno>
#include <ctime>

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <poll.h>

extern "C" {
#include <libubox/uloop.h>
}

#include "logger.hpp"
#include "uloop.hpp"
#include "container.hpp"

namespace {

const std::string UXC_DIR     = "/etc/uxc/";
const std::string CGROUP_BASE = "/sys/fs/cgroup/containers/";
const int RESTART_DELAY_MS    = 2000;
const int STOP_TIMEOUT_MS     = 5000;    // SIGTERM grace before SIGKILL
const size_t MAX_LOG_LINES    = 200;     // per-container ring buffer size
const int PROBE_TIMEOUT_MS    = 1500;    // tcp/http connect timeout

enum desired_t { DOWN, UP };

struct HealthCheck {
	std::string type;                       // "tcp" | "http" | "resource"
	std::string host;
	int port = 0;
	std::string path = "/";                 // http
	unsigned long long memory_max = 0;      // bytes, 0 = no memory check
	int cpu_max = 0;                        // percent (of one core), 0 = no cpu check
};

struct Container {
	std::string name;
	std::string bundle;
	desired_t desired = DOWN;
	pid_t pid = 0;                      // running ujail pid, 0 if not running
	struct uloop_process proc;         // exit supervision (stable address required)
	struct uloop_fd lfd;               // stdout/stderr pipe read end
	bool lfd_active = false;
	std::string log_partial;
	std::deque<std::string> log_ring;

	// healthcheck (reporting only for now)
	int hc_interval = 0;               // seconds, 0 = no healthcheck
	int hc_retries = 3;
	std::vector<HealthCheck> hc_checks;
	int hc_fails = 0;                  // consecutive failed cycles
	std::string health = "unknown";   // unknown | healthy | unhealthy
	bool hc_restart = false;          // restart the container when it goes unhealthy
	bool hc_scheduled = false;
	unsigned long long hc_last_cpu = 0; // last cpu_usec sample (for cpu%)
};

std::map<std::string, Container> containers;

// ---- cgroup helpers ----------------------------------------------------------
unsigned long long read_u64(const std::string& path) {
	std::ifstream f(path);
	unsigned long long v = 0;
	if ( f ) f >> v;
	return v;
}

unsigned long long read_cpu_usec(const std::string& cgdir) {
	std::ifstream f(cgdir + "cpu.stat");
	std::string key;
	unsigned long long v;
	while ( f >> key >> v )
		if ( key == "usage_usec" )
			return v;
	return 0;
}

// ---- registry / config -------------------------------------------------------
JSON read_config(const std::string& name) {
	std::ifstream f(UXC_DIR + name + ".json");
	if ( !f )
		return JSON::Object();
	std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	try { return JSON::parse(s); } catch ( ... ) { return JSON::Object(); }
}

void parse_target(const std::string& target, std::string& host, int& port, std::string& path) {
	// host:port[/path]
	std::string t = target;
	size_t slash = t.find('/');
	if ( slash != std::string::npos ) { path = t.substr(slash); t = t.substr(0, slash); }
	size_t colon = t.rfind(':');
	if ( colon != std::string::npos ) { host = t.substr(0, colon); port = atoi(t.substr(colon + 1).c_str()); }
	else host = t;
}

void load_health(Container& c, const JSON& cfg) {
	c.hc_checks.clear();
	c.hc_interval = 0;
	if ( !cfg.contains("healthcheck"))
		return;
	JSON hc = cfg["healthcheck"];
	c.hc_interval = hc.contains("interval") ? (int)hc["interval"].to_number() : 30;
	c.hc_retries  = hc.contains("retries")  ? (int)hc["retries"].to_number()  : 3;
	c.hc_restart  = hc.contains("on_unhealthy") && hc["on_unhealthy"].to_string() == "restart";
	if ( !hc.contains("checks"))
		return;
	JSON checks = hc["checks"];
	for ( auto it = checks.begin(); it != checks.end(); ++it ) {
		JSON ck = *it.value();
		HealthCheck h;
		h.type = ck.contains("type") ? ck["type"].to_string() : "";
		if ( ck.contains("target"))
			parse_target(ck["target"].to_string(), h.host, h.port, h.path);
		if ( ck.contains("memory_max")) h.memory_max = (unsigned long long)ck["memory_max"].to_number();
		if ( ck.contains("cpu_max"))    h.cpu_max = (int)ck["cpu_max"].to_number();
		c.hc_checks.push_back(h);
	}
}

Container& ensure(const std::string& name) {
	auto it = containers.find(name);
	if ( it != containers.end())
		return it -> second;
	Container c;
	c.name = name;
	JSON cfg = read_config(name);
	c.bundle = cfg.contains("path") ? cfg["path"].to_string() : "";
	load_health(c, cfg);
	memset(&c.proc, 0, sizeof(c.proc));
	memset(&c.lfd, 0, sizeof(c.lfd));
	return containers.emplace(name, std::move(c)).first -> second;
}

// ---- log capture -------------------------------------------------------------
void ring_push(Container& c, const std::string& line) {
	c.log_ring.push_back(line);
	while ( c.log_ring.size() > MAX_LOG_LINES )
		c.log_ring.pop_front();
}

void log_append(Container& c, const char* data, size_t len) {
	c.log_partial.append(data, len);
	size_t pos;
	while (( pos = c.log_partial.find('\n')) != std::string::npos ) {
		ring_push(c, c.log_partial.substr(0, pos));
		c.log_partial.erase(0, pos + 1);
	}
}

void log_close(Container& c) {
	if ( !c.lfd_active )
		return;
	uloop_fd_delete(&c.lfd);
	close(c.lfd.fd);
	c.lfd_active = false;
	if ( !c.log_partial.empty()) {
		ring_push(c, c.log_partial);
		c.log_partial.clear();
	}
}

void log_fd_cb(struct uloop_fd* u, unsigned int events) {
	(void)events;
	Container* c = nullptr;
	for ( auto& kv : containers )
		if ( &kv.second.lfd == u ) { c = &kv.second; break; }
	if ( !c )
		return;
	char buf[4096];
	while ( true ) {
		ssize_t n = read(u -> fd, buf, sizeof(buf));
		if ( n > 0 ) log_append(*c, buf, (size_t)n);
		else if ( n == 0 ) { log_close(*c); return; }
		else {
			if ( errno == EINTR ) continue;
			if ( errno == EAGAIN || errno == EWOULDBLOCK ) return;
			log_close(*c); return;
		}
	}
}

// ---- healthcheck probes ------------------------------------------------------
// Connect to host:port with a bounded timeout. Returns the connected fd (>=0) or
// -1. NOTE: synchronous (blocks the loop up to PROBE_TIMEOUT_MS); fine for the
// reporting phase, will move to async probes later.
int connect_timeout(const std::string& host, int port) {
	struct addrinfo hints; memset(&hints, 0, sizeof(hints));
	hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
	struct addrinfo* ai = nullptr;
	if ( getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &ai) != 0 || !ai )
		return -1;

	int fd = socket(ai -> ai_family, ai -> ai_socktype, ai -> ai_protocol);
	if ( fd < 0 ) { freeaddrinfo(ai); return -1; }
	fcntl(fd, F_SETFL, O_NONBLOCK);

	int r = connect(fd, ai -> ai_addr, ai -> ai_addrlen);
	freeaddrinfo(ai);
	if ( r == 0 )
		return fd;
	if ( errno != EINPROGRESS ) { close(fd); return -1; }

	struct pollfd pfd = { fd, POLLOUT, 0 };
	if ( poll(&pfd, 1, PROBE_TIMEOUT_MS) <= 0 ) { close(fd); return -1; }
	int err = 0; socklen_t len = sizeof(err);
	if ( getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) < 0 || err != 0 ) { close(fd); return -1; }
	return fd;
}

bool tcp_probe(const HealthCheck& h) {
	int fd = connect_timeout(h.host, h.port);
	if ( fd < 0 ) return false;
	close(fd);
	return true;
}

bool http_probe(const HealthCheck& h) {
	int fd = connect_timeout(h.host, h.port);
	if ( fd < 0 ) return false;
	std::string req = "GET " + h.path + " HTTP/1.0\r\nHost: " + h.host + "\r\nConnection: close\r\n\r\n";
	bool ok = false;
	if ( write(fd, req.data(), req.size()) == (ssize_t)req.size()) {
		char buf[256]; ssize_t n;
		struct pollfd pfd = { fd, POLLIN, 0 };
		if ( poll(&pfd, 1, PROBE_TIMEOUT_MS) > 0 && ( n = read(fd, buf, sizeof(buf) - 1)) > 0 ) {
			buf[n] = 0;
			// expect "HTTP/1.x 2xx"
			char* sp = strchr(buf, ' ');
			if ( sp && ( sp[1] == '2' ))
				ok = true;
		}
	}
	close(fd);
	return ok;
}

bool resource_probe(Container& c, const HealthCheck& h) {
	std::string cg = CGROUP_BASE + c.name + "/";
	bool ok = true;
	if ( h.memory_max > 0 && read_u64(cg + "memory.current") > h.memory_max )
		ok = false;
	if ( h.cpu_max > 0 ) {
		unsigned long long now = read_cpu_usec(cg);
		if ( c.hc_last_cpu > 0 && now >= c.hc_last_cpu && c.hc_interval > 0 ) {
			double pct = (double)(now - c.hc_last_cpu) / ((double)c.hc_interval * 10000.0);
			if ( pct > h.cpu_max )
				ok = false;
		}
		c.hc_last_cpu = now;
	}
	return ok;
}

void run_health_check(Container& c) {
	if ( c.pid == 0 ) { c.health = "unknown"; c.hc_fails = 0; return; }

	bool all_ok = true;
	for ( auto& h : c.hc_checks ) {
		bool ok = true;
		if ( h.type == "tcp" )           ok = tcp_probe(h);
		else if ( h.type == "http" )     ok = http_probe(h);
		else if ( h.type == "resource" ) ok = resource_probe(c, h);
		if ( !ok ) all_ok = false;
	}

	if ( all_ok ) {
		if ( c.health != "healthy" )
			logger::info << "uxcd: " << c.name << " is healthy" << std::endl;
		c.health = "healthy";
		c.hc_fails = 0;
	} else if ( ++c.hc_fails >= c.hc_retries ) {
		if ( c.health != "unhealthy" )
			logger::info << "uxcd: " << c.name << " is unhealthy (" << c.hc_fails << " failed checks)" << std::endl;
		c.health = "unhealthy";

		if ( c.hc_restart && c.pid != 0 ) {
			// auto-recover: SIGTERM (desired stays UP -> exit handler relaunches).
			// reset health/fails so the fresh instance gets a clean window, which
			// also paces restarts to at most one per (interval * retries).
			logger::info << "uxcd: restarting unhealthy container " << c.name << std::endl;
			c.health = "unknown";
			c.hc_fails = 0;
			kill(c.pid, SIGTERM);
		}
	}
}

void schedule_health(const std::string& name) {
	auto it = containers.find(name);
	if ( it == containers.end() || it -> second.hc_interval <= 0 || it -> second.hc_scheduled )
		return;
	it -> second.hc_scheduled = true;
	int delay = it -> second.hc_interval * 1000;
	uloop::task::add([name]() -> int {
		auto it = containers.find(name);
		if ( it == containers.end() || it -> second.hc_interval <= 0 ) {
			if ( it != containers.end()) it -> second.hc_scheduled = false;
			return 0;   // stop
		}
		run_health_check(it -> second);
		return it -> second.hc_interval * 1000;   // re-arm
	}, delay);
}

// ---- lifecycle ---------------------------------------------------------------
void launch(Container& c);

void proc_exit_cb(struct uloop_process* p, int ret) {
	for ( auto& kv : containers ) {
		Container& c = kv.second;
		if ( &c.proc != p )
			continue;

		if ( WIFSIGNALED(ret))
			logger::info << "uxcd: container " << c.name << " killed by signal " << WTERMSIG(ret) << std::endl;
		else
			logger::info << "uxcd: container " << c.name << " exited (status " << WEXITSTATUS(ret) << ")" << std::endl;

		c.pid = 0;
		c.health = "unknown";

		if ( c.desired == UP ) {
			logger::info << "uxcd: " << c.name << " is wanted up, restarting in "
			             << ( RESTART_DELAY_MS / 1000 ) << "s" << std::endl;
			std::string name = c.name;
			uloop::task::add([name]() -> int {
				auto it = containers.find(name);
				if ( it != containers.end() && it -> second.desired == UP && it -> second.pid == 0 )
					launch(it -> second);
				return 0;
			}, RESTART_DELAY_MS);
		}
		return;
	}
}

void launch(Container& c) {

	if ( c.bundle.empty()) {
		logger::error << "uxcd: cannot start " << c.name << ": no bundle registered" << std::endl;
		return;
	}

	log_close(c);

	int pfd[2];
	if ( pipe(pfd) < 0 ) {
		logger::error << "uxcd: pipe failed for " << c.name << std::endl;
		return;
	}

	pid_t pid = fork();
	if ( pid < 0 ) {
		logger::error << "uxcd: fork failed for " << c.name << std::endl;
		close(pfd[0]); close(pfd[1]);
		return;
	}

	if ( pid == 0 ) {
		close(pfd[0]);
		dup2(pfd[1], STDOUT_FILENO);
		dup2(pfd[1], STDERR_FILENO);
		if ( pfd[1] > STDERR_FILENO )
			close(pfd[1]);
		execlp("ujail", "ujail", "-n", c.name.c_str(), "-J", c.bundle.c_str(), "-i", (char*)nullptr);
		_exit(127);
	}

	close(pfd[1]);
	fcntl(pfd[0], F_SETFL, O_NONBLOCK);

	c.pid = pid;
	memset(&c.proc, 0, sizeof(c.proc));
	c.proc.pid = pid;
	c.proc.cb = proc_exit_cb;
	uloop_process_add(&c.proc);

	memset(&c.lfd, 0, sizeof(c.lfd));
	c.lfd.fd = pfd[0];
	c.lfd.cb = log_fd_cb;
	uloop_fd_add(&c.lfd, ULOOP_READ);
	c.lfd_active = true;

	c.hc_last_cpu = 0;
	schedule_health(c.name);

	logger::info << "uxcd: started container " << c.name << " (pid " << pid << ")" << std::endl;
}

} // namespace

namespace uxcd {

void init() {
	// learn the registry up front, then autostart containers flagged
	// "autostart": true in /etc/uxc/<name>.json. (procd's own "uxc boot" should
	// be disabled so uxcd is the sole autostarter - see the README.)
	std::vector<std::string> names;
	DIR* d = opendir(UXC_DIR.c_str());
	if ( d ) {
		struct dirent* e;
		while (( e = readdir(d))) {
			std::string fn = e -> d_name;
			if ( fn.size() <= 5 || fn.substr(fn.size() - 5) != ".json" )
				continue;
			names.push_back(fn.substr(0, fn.size() - 5));
		}
		closedir(d);
	}

	for ( const std::string& name : names ) {
		ensure(name);
		JSON cfg = read_config(name);
		if ( cfg.contains("autostart") && cfg["autostart"].to_bool()) {
			logger::info << "uxcd: autostarting " << name << std::endl;
			std::string err;
			if ( !start(name, err))
				logger::error << "uxcd: autostart of " << name << " failed: " << err << std::endl;
		}
	}
}

JSON list() {

	JSON res = JSON::Object();

	DIR* d = opendir(UXC_DIR.c_str());
	if ( !d )
		return res;

	struct dirent* e;
	while (( e = readdir(d))) {

		std::string fn = e -> d_name;
		if ( fn.size() <= 5 || fn.substr(fn.size() - 5) != ".json" )
			continue;
		std::string name = fn.substr(0, fn.size() - 5);

		JSON c = JSON::Object();
		JSON cfg = read_config(name);
		c["bundle"] = cfg.contains("path") ? cfg["path"].to_string() : "";

		auto it = containers.find(name);
		bool running = ( it != containers.end() && it -> second.pid != 0 );
		c["running"] = running;
		if ( running )
			c["pid"] = (long long)it -> second.pid;
		c["desired"] = ( it != containers.end() && it -> second.desired == UP ) ? "up" : "down";
		c["health"]  = ( it != containers.end()) ? it -> second.health : std::string("unknown");

		std::string cg = CGROUP_BASE + name + "/";
		c["memory"]      = (long long)read_u64(cg + "memory.current");
		c["memory_peak"] = (long long)read_u64(cg + "memory.peak");
		c["pids"]        = (long long)read_u64(cg + "pids.current");
		c["cpu_usec"]    = (long long)read_cpu_usec(cg);

		res[name] = c;
	}
	closedir(d);

	return res;
}

JSON logs(const std::string& name, int lines) {
	JSON res = JSON::Object();
	JSON arr = JSON::Array();
	auto it = containers.find(name);
	if ( it != containers.end()) {
		const auto& ring = it -> second.log_ring;
		size_t start = 0;
		if ( lines > 0 && (size_t)lines < ring.size())
			start = ring.size() - (size_t)lines;
		for ( size_t i = start; i < ring.size(); i++ )
			arr.append(JSON(ring[i]));
	}
	res["lines"] = arr;
	return res;
}

bool start(const std::string& name, std::string& err) {
	Container& c = ensure(name);
	if ( c.bundle.empty()) {
		err = "no bundle registered for '" + name + "'";
		return false;
	}
	c.desired = UP;
	if ( c.pid == 0 )
		launch(c);
	return true;
}

bool stop(const std::string& name, std::string& err) {
	(void)err;
	auto it = containers.find(name);
	if ( it == containers.end() || it -> second.pid == 0 ) {
		if ( it != containers.end())
			it -> second.desired = DOWN;
		return true;
	}

	it -> second.desired = DOWN;
	pid_t target = it -> second.pid;
	kill(target, SIGTERM);

	uloop::task::add([name, target]() -> int {
		auto it = containers.find(name);
		if ( it != containers.end() && it -> second.pid == target ) {
			logger::info << "uxcd: " << name << " did not stop on SIGTERM, sending SIGKILL" << std::endl;
			kill(target, SIGKILL);
		}
		return 0;
	}, STOP_TIMEOUT_MS);

	return true;
}

bool restart(const std::string& name, std::string& err) {
	Container& c = ensure(name);
	if ( c.bundle.empty()) {
		err = "no bundle registered for '" + name + "'";
		return false;
	}
	c.desired = UP;
	if ( c.pid != 0 )
		kill(c.pid, SIGTERM);
	else
		launch(c);
	return true;
}

} // namespace uxcd
