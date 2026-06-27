#include <fstream>
#include <iterator>
#include <deque>
#include <map>
#include <cstring>
#include <cerrno>

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>

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
const int STOP_TIMEOUT_MS     = 5000;   // SIGTERM grace before SIGKILL
const size_t MAX_LOG_LINES    = 200;    // per-container ring buffer size

enum desired_t { DOWN, UP };

struct Container {
	std::string name;
	std::string bundle;
	desired_t desired = DOWN;
	pid_t pid = 0;                      // running ujail pid, 0 if not running
	struct uloop_process proc;         // exit supervision (stable address required)
	struct uloop_fd lfd;               // stdout/stderr pipe read end
	bool lfd_active = false;
	std::string log_partial;           // incomplete trailing line
	std::deque<std::string> log_ring;  // last MAX_LOG_LINES lines
};

// std::map keeps node addresses stable, so &Container::proc / &Container::lfd
// stay valid while linked into uloop's lists.
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

// ---- registry ----------------------------------------------------------------
std::string read_bundle(const std::string& name) {
	std::ifstream f(UXC_DIR + name + ".json");
	if ( !f )
		return "";
	std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	try {
		JSON j = JSON::parse(s);
		return j.contains("path") ? j["path"].to_string() : "";
	} catch ( ... ) {
		return "";
	}
}

Container& ensure(const std::string& name) {
	auto it = containers.find(name);
	if ( it != containers.end())
		return it -> second;
	Container c;
	c.name = name;
	c.bundle = read_bundle(name);
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
	if ( !c.log_partial.empty()) {   // flush any unterminated last line
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
		if ( n > 0 ) {
			log_append(*c, buf, (size_t)n);
		} else if ( n == 0 ) {       // EOF: container's stdout closed
			log_close(*c);
			return;
		} else {
			if ( errno == EINTR ) continue;
			if ( errno == EAGAIN || errno == EWOULDBLOCK ) return;
			log_close(*c);
			return;
		}
	}
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

		if ( c.desired == UP ) {
			logger::info << "uxcd: " << c.name << " is wanted up, restarting in "
			             << ( RESTART_DELAY_MS / 1000 ) << "s" << std::endl;
			std::string name = c.name;
			uloop::task::add([name]() -> int {
				auto it = containers.find(name);
				if ( it != containers.end() && it -> second.desired == UP && it -> second.pid == 0 )
					launch(it -> second);
				return 0;   // one-shot
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

	log_close(c);   // defensive: drop any stale pipe before relaunch

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
		// child: ujail becomes the container runtime; its stdio is captured.
		close(pfd[0]);
		dup2(pfd[1], STDOUT_FILENO);
		dup2(pfd[1], STDERR_FILENO);
		if ( pfd[1] > STDERR_FILENO )
			close(pfd[1]);
		execlp("ujail", "ujail", "-n", c.name.c_str(), "-J", c.bundle.c_str(), "-i", (char*)nullptr);
		_exit(127);
	}

	close(pfd[1]);                              // parent keeps only the read end
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

	logger::info << "uxcd: started container " << c.name << " (pid " << pid << ")" << std::endl;
}

} // namespace

namespace uxcd {

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
		c["bundle"] = read_bundle(name);

		auto it = containers.find(name);
		bool running = ( it != containers.end() && it -> second.pid != 0 );
		c["running"] = running;
		if ( running )
			c["pid"] = (long long)it -> second.pid;
		c["desired"] = ( it != containers.end() && it -> second.desired == UP ) ? "up" : "down";

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
		return true;   // already stopped (idempotent)
	}

	it -> second.desired = DOWN;
	pid_t target = it -> second.pid;
	kill(target, SIGTERM);

	// graceful stop with a SIGKILL fallback, like procd's term_timeout: if the
	// same process is still running after the grace period, force-kill it.
	uloop::task::add([name, target]() -> int {
		auto it = containers.find(name);
		if ( it != containers.end() && it -> second.pid == target ) {
			logger::info << "uxcd: " << name << " did not stop on SIGTERM, sending SIGKILL" << std::endl;
			kill(target, SIGKILL);
		}
		return 0;   // one-shot
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
		kill(c.pid, SIGTERM);   // exit handler relaunches it (desired == UP)
	else
		launch(c);
	return true;
}

} // namespace uxcd
