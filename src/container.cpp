#include <fstream>
#include <iterator>
#include <deque>
#include <vector>
#include <map>
#include <set>
#include <functional>
#include <algorithm>
#include <cstring>
#include <cerrno>
#include <ctime>
#include <memory>

#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <signal.h>
#include <sched.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/sysmacros.h>
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
#include "config.hpp"
#include "container.hpp"

namespace {

const std::string UXC_DIR     = "/etc/uxc/";
const std::string CGROUP_BASE = "/sys/fs/cgroup/containers/";
const std::string NETNS_DIR   = "/var/run/netns/";   // named netns (infra) live here
const std::string SHADOW_DIR  = "/var/run/uxcd/";    // generated per-launch OCI bundles
const std::string LOG_DIR     = "/var/log/uxcd/";    // persistent per-container logs
const std::string JOB_LOG_DIR = "/var/log/uxcd/jobs/"; // pull/build (docker2uxcd) job output
const int INFRA_WAIT_MS       = 8000;    // max wait for an infra netns to come up
const int INFRA_POLL_MS       = 100;     // poll step while waiting for the netns
const int ADOPT_POLL_MS       = 3000;    // liveness poll for re-adopted containers
const int STABLE_SECS         = 10;      // uptime over this resets the crash-backoff

// configurable via /etc/config/uxcd (uxcd::settings); set in init() from there.
int RESTART_DELAY_MS     = 2000;
int RESTART_MAX_DELAY_MS = 60000;        // cap for exponential crash backoff
int STOP_TIMEOUT_MS      = 5000;         // SIGTERM grace before SIGKILL
size_t MAX_LOG_LINES    = 200;           // default lines returned by logs()
int LOG_SIZE_BYTES      = 65536;         // per-container log file size before rotation
int PROBE_TIMEOUT_MS    = 1500;          // tcp/http connect timeout
int INFRA_WATCH_MS      = 5000;          // watchdog interval for in-use infra netns

enum desired_t { DOWN, UP };

struct HealthCheck {
	std::string type;                       // "tcp" | "http" | "resource" | "exec"
	std::string host;
	int port = 0;
	std::string path = "/";                 // http
	unsigned long long memory_max = 0;      // bytes, 0 = no memory check
	int cpu_max = 0;                        // percent (of one core), 0 = no cpu check
	std::vector<std::string> command;       // exec: command to run inside the container
	int timeout_ms = 0;                     // exec: kill after this (0 = PROBE_TIMEOUT_MS)
};

struct Container {
	std::string name;
	std::string bundle;
	std::string infra;                  // shared netns name to join, empty = none
	desired_t desired = DOWN;
	pid_t pid = 0;                      // running ujail pid, 0 if not running
	bool adopted = false;               // re-adopted across uxcd restart (poll-supervised, no log pipe)
	time_t started = 0;                 // launch time (for uptime), 0 if not running
	time_t cfg_mtime = 0;               // registry-file mtime at launch (config-changed badge)
	int restarts = 0;                   // times auto-restarted since uxcd start
	int crash_count = 0;                // consecutive rapid crashes (for backoff)
	bool respawn = true;                // auto-restart when it exits while wanted up
	std::string overlay_path;           // ujail -O <dir>: persistent r/w overlay
	std::string overlay_size;           // ujail -T <size>: tmpfs r/w overlay
	std::vector<std::string> req_mounts;// require these mountpoints before launch
	std::vector<std::string> volumes;   // "src:dst[:ro]" -> OCI bind mounts
	std::vector<std::string> env;       // "KEY=VAL" -> OCI process.env
	std::vector<std::string> devices;   // device node paths -> OCI devices + cgroup allow
	std::vector<std::string> depends_on;// other containers that must run first
	time_t dep_wait_since = 0;          // when we began waiting for depends_on (0 = not); drives the start_timeout fail-open
	JSON resources;                     // OCI linux.resources to merge (overrides bundle)
	std::vector<std::string> cap_add;   // OCI capabilities to add (over base/default)
	std::vector<std::string> cap_drop;  // OCI capabilities to drop ("ALL" = drop all first)
	std::string seccomp;                // OCI seccomp profile path, or "unconfined"; empty = leave bundle's
	struct uloop_process proc;         // exit supervision (stable address required)
	struct uloop_fd lfd;               // stdout/stderr pipe read end
	bool lfd_active = false;
	std::string log_partial;            // buffer for an incomplete trailing line
	int log_wfd = -1;                   // append fd to /var/log/uxcd/<name>.log

	// healthcheck (reporting only for now)
	int hc_interval = 0;               // seconds, 0 = no healthcheck
	int hc_retries = 3;
	std::vector<HealthCheck> hc_checks;
	int hc_fails = 0;                  // consecutive failed cycles
	std::string health = "unknown";   // unknown | healthy | unhealthy
	bool hc_restart = false;          // restart the container when it goes unhealthy
	bool hc_scheduled = false;
	unsigned long long hc_last_cpu = 0; // last cpu_usec sample (for cpu%)
	std::string last_update;           // last safe-update result: "" | "verified" | "rolled_back" | "rollback_failed"
};

std::map<std::string, Container> containers;

// ---- background jobs (pull/build via docker2uxcd) ----------------------------
// Pull/build are long-running (network, layer extraction, chroot RUN), so they
// run as a child process with stdout/stderr captured to a log file; the UI polls
// job_status/job_log. The daemon never blocks on them (uloop reaps the child).
struct Job {
	std::string id;
	std::string kind;                  // "pull" | "build"
	std::string label;                 // image ref or dockerfile (for display)
	std::string name;                  // target container name (may be empty)
	pid_t pid = 0;
	bool running = true;
	int exit_code = -1;
	time_t started = 0;
	std::string log_path;
	std::string restart_after;          // container to restart when the job exits 0 (upgrade)
	bool safe_update = false;           // health-gate the post-upgrade restart; auto-rollback to .prev on failure
	struct uloop_process proc;         // exit supervision (stable address required)
};
std::map<std::string, Job> jobs;
int job_seq = 0;

// ---- update check (which registered containers have a newer image) ----------
// check_updates() runs `docker2uxcd --check-updates` as one child (non-blocking)
// and caches the result here; list()/info() report it. On-demand only.
struct UpdateInfo { bool available = false; std::string digest; };
std::map<std::string, UpdateInfo> updates;     // name -> latest check result
bool update_check_running = false;
time_t updates_checked = 0;
struct uloop_process update_proc;              // stable address for uloop

// ---- disk helpers (image/bundle listing + prune) -----------------------------
// docker2uxc's blob cache (downloaded layers; on OpenWrt /tmp is tmpfs, so this
// is RAM) - same default + env var as the converter.
std::string cache_dir() {
	const char* e = getenv("DOCKER2UXC_CACHE");
	return ( e && *e ) ? std::string(e) : std::string("/tmp/docker2uxc-cache");
}

// mkdir -p: create every component of `path`, ignoring already-exists. Used to
// pre-create the bundle dir before a pull/build chdir()s into it.
void mkdir_p(const std::string& path, mode_t mode) {
	std::string acc;
	for ( size_t i = 0; i < path.size(); ++i ) {
		acc += path[i];
		if ( path[i] == '/' && acc.size() > 1 )
			mkdir(acc.c_str(), mode);
	}
	if ( !path.empty() && path.back() != '/' )
		mkdir(path.c_str(), mode);
}

// recursive apparent size of a file or directory tree (lstat: don't follow links)
unsigned long long dir_size(const std::string& path) {
	struct stat st;
	if ( lstat(path.c_str(), &st) != 0 )
		return 0;
	if ( !S_ISDIR(st.st_mode))
		return (unsigned long long)st.st_size;
	unsigned long long total = 0;
	DIR* d = opendir(path.c_str());
	if ( !d )
		return 0;
	struct dirent* e;
	while (( e = readdir(d))) {
		std::string n = e -> d_name;
		if ( n == "." || n == ".." )
			continue;
		total += dir_size(path + "/" + n);
	}
	closedir(d);
	return total;
}

// recursive delete. Callers MUST pass only derived paths (the blob cache or a
// <bundle>.prev) - never arbitrary input; the guard just blocks obvious feet.
bool rm_rf(const std::string& path) {
	if ( path.empty() || path == "/" )
		return false;
	struct stat st;
	if ( lstat(path.c_str(), &st) != 0 )
		return true;                       // already gone
	if ( S_ISDIR(st.st_mode)) {
		DIR* d = opendir(path.c_str());
		if ( d ) {
			struct dirent* e;
			while (( e = readdir(d))) {
				std::string n = e -> d_name;
				if ( n == "." || n == ".." )
					continue;
				rm_rf(path + "/" + n);
			}
			closedir(d);
		}
		return rmdir(path.c_str()) == 0;
	}
	return unlink(path.c_str()) == 0;
}

// ---- events ------------------------------------------------------------------
// main wires this to ubus send_event; container.cpp stays ubus-agnostic.
std::function<void(const std::string&, const JSON&)> g_event_sink;

void emit(const std::string& name, const std::string& event) {
	if ( !g_event_sink )
		return;
	JSON d = JSON::Object();
	d["name"] = name;
	d["event"] = event;
	auto it = containers.find(name);
	if ( it != containers.end()) {
		d["running"] = it -> second.pid != 0;
		d["health"]  = it -> second.health;
	}
	g_event_sink("uxcd.container", d);
}

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

// True if the container's cgroup currently has any processes (pids.current
// aggregates the nested leaf cgroup) - a robust liveness signal that does not
// depend on a pid we own.
bool cgroup_alive(const std::string& name) {
	return read_u64(CGROUP_BASE + name + "/pids.current") > 0;
}

// Kill the whole container cgroup (cgroup v2 cgroup.kill): the reliable
// SIGKILL fallback - nothing escapes (double-forked procs, adopted containers).
void cgroup_kill(const std::string& name) {
	std::ofstream f(CGROUP_BASE + name + "/cgroup.kill");
	if ( f ) f << "1";
}

// Find a running `ujail ... -n <name> ...` process. After a uxcd restart its
// ujail children are orphaned (reparented to init) but still running and still
// the parent of the container init, so we can re-adopt them by name.
pid_t find_jail_pid(const std::string& name) {
	DIR* d = opendir("/proc");
	if ( !d )
		return 0;
	pid_t found = 0;
	struct dirent* e;
	while (( e = readdir(d))) {
		if ( e -> d_name[0] < '0' || e -> d_name[0] > '9' )
			continue;
		std::ifstream f(std::string("/proc/") + e -> d_name + "/cmdline", std::ios::binary);
		if ( !f )
			continue;
		std::vector<std::string> av;
		std::string tok;
		char c;
		while ( f.get(c)) {
			if ( c == '\0' ) { av.push_back(tok); tok.clear(); }
			else tok += c;
		}
		if ( !tok.empty()) av.push_back(tok);
		if ( av.empty())
			continue;
		std::string a0 = av[0];
		size_t sl = a0.rfind('/');
		if ( sl != std::string::npos ) a0 = a0.substr(sl + 1);
		if ( a0 != "ujail" )
			continue;
		for ( size_t i = 1; i + 1 < av.size(); i++ )
			if ( av[i] == "-n" && av[i + 1] == name ) { found = atoi(e -> d_name); break; }
		if ( found )
			break;
	}
	closedir(d);
	return found;
}

// ---- registry / config -------------------------------------------------------
// A registry name becomes a single path component (/etc/uxc/<name>.json, the
// shadow bundle dir, log files), so reject anything that could traverse or
// produce odd files: non-empty, <=128 chars, [A-Za-z0-9._-], no leading dot
// (blocks "." / ".." / hidden files; with no '/' allowed there is no traversal).
bool valid_name(const std::string& name) {
	if ( name.empty() || name.size() > 128 || name[0] == '.' )
		return false;
	for ( char c : name ) {
		bool ok = ( c >= 'a' && c <= 'z' ) || ( c >= 'A' && c <= 'Z' ) ||
		          ( c >= '0' && c <= '9' ) || c == '_' || c == '-' || c == '.';
		if ( !ok )
			return false;
	}
	return true;
}

// True if a running container's registry file changed since it was launched
// (drives a "restart to apply" badge). mtime-based - good enough for a hint.
bool cfg_changed(const Container& c) {
	if ( c.pid == 0 || c.cfg_mtime == 0 )
		return false;
	struct stat st;
	if ( stat(( UXC_DIR + c.name + ".json" ).c_str(), &st) != 0 )
		return false;
	return st.st_mtime > c.cfg_mtime;
}

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
		if ( ck.contains("command")) {
			JSON cmd = ck["command"];
			for ( auto a = cmd.begin(); a != cmd.end(); ++a )
				h.command.push_back(( *a.value()).to_string());
		}
		if ( ck.contains("timeout")) h.timeout_ms = (int)ck["timeout"].to_number() * 1000;
		c.hc_checks.push_back(h);
	}
}

void apply_config(Container& c, const JSON& cfg) {
	c.bundle        = cfg.contains("path")  ? cfg["path"].to_string()  : "";
	c.infra         = cfg.contains("infra") ? cfg["infra"].to_string() : "";
	c.respawn       = !cfg.contains("respawn") || cfg["respawn"].to_bool();
	c.overlay_path  = cfg.contains("write_overlay_path") ? cfg["write_overlay_path"].to_string() : "";
	c.overlay_size  = cfg.contains("temp_overlay_size")  ? cfg["temp_overlay_size"].to_string()  : "";
	auto load_strs = [&](const char* key, std::vector<std::string>& out) {
		out.clear();
		if ( cfg.contains(key)) {
			JSON a = cfg[key];
			for ( auto it = a.begin(); it != a.end(); ++it )
				out.push_back(( *it.value()).to_string());
		}
	};
	load_strs("mounts",     c.req_mounts);
	load_strs("volumes",    c.volumes);
	load_strs("env",        c.env);
	load_strs("devices",    c.devices);
	load_strs("depends_on", c.depends_on);
	load_strs("cap_add",    c.cap_add);
	load_strs("cap_drop",   c.cap_drop);
	c.seccomp       = cfg.contains("seccomp") ? cfg["seccomp"].to_string() : "";
	c.resources = cfg.contains("resources") ? cfg["resources"] : JSON();
	load_health(c, cfg);
}

void refresh_config(Container& c) {
	apply_config(c, read_config(c.name));
}

Container& ensure(const std::string& name) {
	auto it = containers.find(name);
	if ( it != containers.end())
		return it -> second;
	Container c;
	c.name = name;
	apply_config(c, read_config(name));
	memset(&c.proc, 0, sizeof(c.proc));
	memset(&c.lfd, 0, sizeof(c.lfd));
	return containers.emplace(name, std::move(c)).first -> second;
}

// ---- log capture (persistent, file-backed) -----------------------------------
void log_open(Container& c) {
	mkdir(LOG_DIR.c_str(), 0755);
	if ( c.log_wfd < 0 )
		c.log_wfd = open(( LOG_DIR + c.name + ".log" ).c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
}

// Rotate <name>.log -> <name>.log.1 (keeping one previous file) once it grows
// past LOG_SIZE_BYTES, so logs are bounded but survive a uxcd restart.
void log_rotate(Container& c) {
	if ( c.log_wfd < 0 )
		return;
	struct stat st;
	if ( fstat(c.log_wfd, &st) != 0 || st.st_size < LOG_SIZE_BYTES )
		return;
	close(c.log_wfd);
	c.log_wfd = -1;
	std::string p = LOG_DIR + c.name + ".log";
	rename(p.c_str(), ( p + ".1" ).c_str());
	c.log_wfd = open(p.c_str(), O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0644);
}

void log_write(Container& c, const std::string& line) {
	if ( c.log_wfd < 0 )
		return;
	std::string l = line + "\n";
	if ( write(c.log_wfd, l.data(), l.size()) < 0 ) {}
	log_rotate(c);
}

void log_append(Container& c, const char* data, size_t len) {
	c.log_partial.append(data, len);
	size_t pos;
	while (( pos = c.log_partial.find('\n')) != std::string::npos ) {
		log_write(c, c.log_partial.substr(0, pos));
		c.log_partial.erase(0, pos + 1);
	}
}

void log_close(Container& c) {
	if ( c.lfd_active ) {
		uloop_fd_delete(&c.lfd);
		close(c.lfd.fd);
		c.lfd_active = false;
	}
	if ( !c.log_partial.empty()) {
		log_write(c, c.log_partial);
		c.log_partial.clear();
	}
	if ( c.log_wfd >= 0 ) {
		close(c.log_wfd);
		c.log_wfd = -1;
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

pid_t container_init_pid(pid_t parent);   // defined in the infra section below

// Run a command inside the container (joining the init child's namespaces, like
// uxe) and return its exit code; -1 on failure or timeout. Used by the "exec"
// healthcheck. Blocks up to timeout_ms (the health cycle is already synchronous).
int exec_in_container(Container& c, const std::vector<std::string>& cmd, int timeout_ms) {

	pid_t init = container_init_pid(c.pid);
	if ( init <= 0 || cmd.empty())
		return -1;

	pid_t pid = fork();
	if ( pid < 0 )
		return -1;

	if ( pid == 0 ) {
		static const struct { const char* name; int flag; } NS[] = {
			{ "ipc", CLONE_NEWIPC }, { "uts", CLONE_NEWUTS }, { "net", CLONE_NEWNET },
			{ "pid", CLONE_NEWPID }, { "mnt", CLONE_NEWNS },
		};
		for ( const auto& ns : NS ) {
			char tp[64], sp[64];
			snprintf(tp, sizeof tp, "/proc/%d/ns/%s", init, ns.name);
			snprintf(sp, sizeof sp, "/proc/self/ns/%s", ns.name);
			struct stat ts, ss;
			if ( stat(tp, &ts) != 0 )
				continue;
			if ( stat(sp, &ss) == 0 && ts.st_ino == ss.st_ino && ts.st_dev == ss.st_dev )
				continue;
			int fd = open(tp, O_RDONLY | O_CLOEXEC);
			if ( fd < 0 || setns(fd, ns.flag) != 0 ) { if ( fd >= 0 ) close(fd); _exit(127); }
			close(fd);
		}
		int devnull = open("/dev/null", O_RDWR);
		if ( devnull >= 0 ) { dup2(devnull, 0); dup2(devnull, 1); dup2(devnull, 2); if ( devnull > 2 ) close(devnull); }
		if ( chdir("/") != 0 ) {}
		std::vector<char*> av;
		for ( const std::string& s : cmd )
			av.push_back(const_cast<char*>(s.c_str()));
		av.push_back(nullptr);
		execvp(av[0], av.data());
		_exit(127);
	}

	int tmo = timeout_ms > 0 ? timeout_ms : PROBE_TIMEOUT_MS;
	int waited = 0, step = 50, status = 0;
	for (;;) {
		pid_t r = waitpid(pid, &status, WNOHANG);
		if ( r == pid )
			return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
		if ( r < 0 )
			return -1;
		if ( waited >= tmo ) { kill(pid, SIGKILL); waitpid(pid, &status, 0); return -1; }
		struct timespec ts = { step / 1000, ( step % 1000 ) * 1000000L };
		nanosleep(&ts, nullptr);
		waited += step;
	}
}

void run_health_check(Container& c) {
	if ( c.pid == 0 ) { c.health = "unknown"; c.hc_fails = 0; return; }

	bool all_ok = true;
	for ( auto& h : c.hc_checks ) {
		bool ok = true;
		if ( h.type == "tcp" )           ok = tcp_probe(h);
		else if ( h.type == "http" )     ok = http_probe(h);
		else if ( h.type == "resource" ) ok = resource_probe(c, h);
		else if ( h.type == "exec" )     ok = exec_in_container(c, h.command, h.timeout_ms) == 0;
		if ( !ok ) all_ok = false;
	}

	if ( all_ok ) {
		if ( c.health != "healthy" ) {
			logger::info << "uxcd: " << c.name << " is healthy" << std::endl;
			c.health = "healthy";
			emit(c.name, "healthy");
		}
		c.health = "healthy";
		c.hc_fails = 0;
	} else if ( ++c.hc_fails >= c.hc_retries ) {
		if ( c.health != "unhealthy" ) {
			logger::info << "uxcd: " << c.name << " is unhealthy (" << c.hc_fails << " failed checks)" << std::endl;
			c.health = "unhealthy";
			emit(c.name, "unhealthy");
		}
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

// True if `path` is currently a mountpoint (2nd field in /proc/self/mounts).
bool is_mounted(const std::string& path) {
	std::ifstream f("/proc/self/mounts");
	std::string line;
	while ( std::getline(f, line)) {
		size_t a = line.find(' ');
		if ( a == std::string::npos ) continue;
		size_t b = line.find(' ', a + 1);
		if ( b == std::string::npos ) continue;
		if ( line.substr(a + 1, b - a - 1) == path )
			return true;
	}
	return false;
}

// ---- infra (shared netns) ----------------------------------------------------

// True once the named netns file exists (the netifd `netns` proto creates it).
bool netns_exists(const std::string& infra) {
	struct stat st;
	return stat(( NETNS_DIR + infra ).c_str(), &st) == 0;
}

// The container's init process is ujail's child: ujail (the pid uxcd tracks)
// stays in the host netns and supervises, while the actual container runs in a
// child with the joined/created namespaces. Find that child so we can inspect
// the namespace the container really lives in.
pid_t container_init_pid(pid_t parent) {
	DIR* d = opendir("/proc");
	if ( !d )
		return 0;
	pid_t found = 0;
	struct dirent* e;
	while (( e = readdir(d))) {
		if ( e -> d_name[0] < '0' || e -> d_name[0] > '9' )
			continue;
		std::ifstream f(std::string("/proc/") + e -> d_name + "/status");
		std::string line;
		while ( std::getline(f, line)) {
			if ( line.rfind("PPid:", 0) == 0 ) {
				if ( atoi(line.c_str() + 5) == parent )
					found = atoi(e -> d_name);
				break;
			}
		}
		if ( found )
			break;
	}
	closedir(d);
	return found;
}

// List the IPv4 addresses present in a network namespace. nsfd is a fd to the
// target net ns (a named netns file or /proc/<pid>/ns/net); it is consumed
// (closed) here. We setns() into it in a child and parse `ip -json addr`, so the
// query never disturbs uxcd's own namespace. Loopback is skipped.
std::vector<std::string> netns_addrs(int nsfd) {

	std::vector<std::string> out;
	if ( nsfd < 0 )
		return out;

	int pfd[2];
	if ( pipe(pfd) < 0 ) { close(nsfd); return out; }

	pid_t pid = fork();
	if ( pid == 0 ) {
		close(pfd[0]);
		dup2(pfd[1], STDOUT_FILENO);
		if ( pfd[1] > STDOUT_FILENO )
			close(pfd[1]);
		if ( setns(nsfd, CLONE_NEWNET) == 0 )
			execlp("ip", "ip", "-json", "-4", "addr", "show", (char*)nullptr);
		_exit(127);
	}

	close(pfd[1]);
	close(nsfd);
	if ( pid < 0 ) { close(pfd[0]); return out; }

	std::string buf;
	char tmp[1024];
	ssize_t n;
	while (( n = read(pfd[0], tmp, sizeof(tmp))) > 0 )
		buf.append(tmp, (size_t)n);
	close(pfd[0]);
	waitpid(pid, nullptr, 0);

	try {
		JSON j = JSON::parse(buf);
		for ( auto it = j.begin(); it != j.end(); ++it ) {
			JSON iface = *it.value();
			if ( iface.contains("ifname") && iface["ifname"].to_string() == "lo" )
				continue;
			if ( !iface.contains("addr_info"))
				continue;
			JSON ai = iface["addr_info"];
			for ( auto a = ai.begin(); a != ai.end(); ++a ) {
				JSON addr = *a.value();
				if ( addr.contains("local"))
					out.push_back(addr["local"].to_string());
			}
		}
	} catch ( ... ) {}

	return out;
}

// Make sure the infra netns is up before a member container is launched. If it
// is missing, ask netifd to bring up the matching interface (by convention the
// netns name equals the /etc/config/network interface name) and wait briefly.
// uxcd never creates the netns itself - netifd owns its lifecycle and network.
bool ensure_infra(const std::string& infra) {

	if ( netns_exists(infra))
		return true;

	logger::info << "uxcd: infra netns '" << infra << "' not up, bringing it up (ifup)" << std::endl;

	pid_t pid = fork();
	if ( pid == 0 ) {
		execlp("ifup", "ifup", infra.c_str(), (char*)nullptr);
		_exit(127);
	}
	if ( pid > 0 )
		waitpid(pid, nullptr, 0);

	for ( int waited = 0; waited < INFRA_WAIT_MS; waited += INFRA_POLL_MS ) {
		if ( netns_exists(infra))
			return true;
		struct timespec ts = { INFRA_POLL_MS / 1000, ( INFRA_POLL_MS % 1000 ) * 1000000L };
		nanosleep(&ts, nullptr);
	}

	return netns_exists(infra);
}

// Build the OCI bundle directory to hand to ujail. Without infra this is just
// the registered bundle. With infra, write a shadow bundle under SHADOW_DIR that
// (a) makes root.path absolute (ujail resolves relative paths against the bundle
// dir, which the shadow dir is not) and (b) points the network namespace at
// /var/run/netns/<infra> so ujail setns()es into the shared netns instead of
// creating its own.
// Generate a shadow OCI bundle that merges the container's registry overrides
// (infra netns, volumes, devices, env, resources) onto the image's config.json.
// Keeping overrides in the registry (not the bundle) means they survive an image
// update/re-pull. Only called when the container actually has overrides.
bool make_launch_bundle(Container& c, std::string& out_bundle, std::string& err) {

	std::ifstream f(c.bundle + "/config.json");
	if ( !f ) { err = "cannot read " + c.bundle + "/config.json"; return false; }
	std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	JSON cfg;
	try { cfg = JSON::parse(s); } catch ( ... ) { err = "invalid config.json in bundle"; return false; }

	// root.path -> absolute (the shadow dir is not the bundle dir)
	if ( cfg.contains("root") && cfg["root"].contains("path")) {
		std::string rp = cfg["root"]["path"].to_string();
		if ( !rp.empty() && rp[0] != '/' )
			cfg["root"]["path"] = c.bundle + "/" + rp;
	}
	if ( !cfg.contains("linux"))
		cfg["linux"] = JSON::Object();

	// ---- infra: join the shared netns + its resolver --------------------------
	if ( !c.infra.empty()) {
		const std::string nspath = NETNS_DIR + c.infra;
		JSON nsarr = JSON::Array();
		bool net_done = false;
		if ( cfg["linux"].contains("namespaces")) {
			JSON old = cfg["linux"]["namespaces"];
			for ( auto it = old.begin(); it != old.end(); ++it ) {
				JSON e = *it.value();
				if ( e.contains("type") && e["type"].to_string() == "network" ) {
					JSON ne = JSON::Object(); ne["type"] = "network"; ne["path"] = nspath;
					nsarr.append(ne); net_done = true;
				} else nsarr.append(e);
			}
		}
		if ( !net_done ) { JSON ne = JSON::Object(); ne["type"] = "network"; ne["path"] = nspath; nsarr.append(ne); }
		cfg["linux"]["namespaces"] = nsarr;

		// override resolv.conf (ujail would otherwise bind the host resolver,
		// unreachable from the netns). add_mount dedups by destination and OCI
		// mounts are applied before ujail's defaults, so this bind wins.
		std::string resolv = "/etc/netns/" + c.infra + "/resolv.conf";
		struct stat rst;
		if ( stat(resolv.c_str(), &rst) == 0 ) {
			JSON m = JSON::Object();
			m["destination"] = "/etc/resolv.conf"; m["type"] = "bind"; m["source"] = resolv;
			JSON mo = JSON::Array(); mo.append(JSON("bind")); mo.append(JSON("ro")); m["options"] = mo;
			if ( !cfg.contains("mounts")) cfg["mounts"] = JSON::Array();
			cfg["mounts"].append(m);
		}
	}

	// ---- volumes -> bind mounts (src:dst[:ro]) --------------------------------
	if ( !c.volumes.empty() && !cfg.contains("mounts")) cfg["mounts"] = JSON::Array();
	for ( const std::string& v : c.volumes ) {
		size_t a = v.find(':');
		if ( a == std::string::npos ) continue;
		std::string src = v.substr(0, a), rest = v.substr(a + 1);
		size_t b = rest.find(':');
		std::string dst = b == std::string::npos ? rest : rest.substr(0, b);
		std::string opt = b == std::string::npos ? "" : rest.substr(b + 1);
		JSON m = JSON::Object();
		m["destination"] = dst; m["source"] = src; m["type"] = "bind";
		JSON mo = JSON::Array(); mo.append(JSON("bind")); mo.append(JSON( opt == "ro" ? "ro" : "rw" ));
		m["options"] = mo;
		cfg["mounts"].append(m);
	}

	// ---- resources: merge OCI linux.resources (overrides the bundle) ----------
	if ( !c.resources.empty()) {
		if ( !cfg["linux"].contains("resources")) cfg["linux"]["resources"] = JSON::Object();
		for ( auto it = c.resources.begin(); it != c.resources.end(); ++it )
			cfg["linux"]["resources"][it.key()] = *it.value();
	}

	// ---- devices -> node (linux.devices) + cgroup allow (resources.devices) ---
	if ( !c.devices.empty()) {
		if ( !cfg["linux"].contains("devices")) cfg["linux"]["devices"] = JSON::Array();
		if ( !cfg["linux"].contains("resources")) cfg["linux"]["resources"] = JSON::Object();
		if ( !cfg["linux"]["resources"].contains("devices")) cfg["linux"]["resources"]["devices"] = JSON::Array();

		std::function<void(const std::string&)> add_dev = [&](const std::string& path) {
			struct stat st;
			if ( stat(path.c_str(), &st) != 0 ) return;
			if ( !S_ISCHR(st.st_mode) && !S_ISBLK(st.st_mode)) return;
			std::string type = S_ISBLK(st.st_mode) ? "b" : "c";
			int maj = (int)major(st.st_rdev), mino = (int)minor(st.st_rdev);
			JSON dev = JSON::Object();
			dev["type"] = type; dev["path"] = path; dev["major"] = maj; dev["minor"] = mino;
			dev["fileMode"] = (int)( st.st_mode & 0777 ); dev["uid"] = 0; dev["gid"] = 0;
			cfg["linux"]["devices"].append(dev);
			JSON al = JSON::Object();
			al["allow"] = true; al["type"] = type; al["major"] = maj; al["minor"] = mino; al["access"] = "rwm";
			cfg["linux"]["resources"]["devices"].append(al);
		};
		for ( const std::string& d : c.devices ) {
			struct stat st;
			if ( stat(d.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
				DIR* dd = opendir(d.c_str());
				if ( dd ) {
					struct dirent* e;
					while (( e = readdir(dd))) { if ( e -> d_name[0] == '.' ) continue; add_dev(d + "/" + e -> d_name); }
					closedir(dd);
				}
			} else add_dev(d);
		}
	}

	// ---- env -> process.env ---------------------------------------------------
	if ( !c.env.empty()) {
		if ( !cfg.contains("process")) cfg["process"] = JSON::Object();
		if ( !cfg["process"].contains("env")) cfg["process"]["env"] = JSON::Array();
		for ( const std::string& e : c.env )
			cfg["process"]["env"].append(JSON(e));
	}

	// ---- capabilities: cap_add / cap_drop -> OCI process.capabilities ---------
	// ujail treats an ABSENT capability set as "all allowed", so to drop anything
	// we must emit explicit sets. Base = the bundle's 'bounding' caps if it has
	// them, else a sane default (Docker's default set); then drop, then add.
	if ( !c.cap_add.empty() || !c.cap_drop.empty()) {
		static const char* const DEFAULT_CAPS[] = {
			"CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD",
			"CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP",
			"CAP_NET_BIND_SERVICE", "CAP_SYS_CHROOT", "CAP_KILL", "CAP_AUDIT_WRITE",
		};
		std::vector<std::string> caps;
		if ( cfg.contains("process") && cfg["process"].contains("capabilities") &&
		     cfg["process"]["capabilities"].contains("bounding")) {
			JSON b = cfg["process"]["capabilities"]["bounding"];
			for ( auto it = b.begin(); it != b.end(); ++it )
				caps.push_back(( *it.value()).to_string());
		} else
			for ( const char* d : DEFAULT_CAPS )
				caps.push_back(d);

		bool drop_all = false;
		for ( const std::string& d : c.cap_drop )
			if ( d == "ALL" || d == "all" ) { drop_all = true; break; }
		if ( drop_all )
			caps.clear();
		else
			for ( const std::string& d : c.cap_drop )
				caps.erase(std::remove(caps.begin(), caps.end(), d), caps.end());

		for ( const std::string& a : c.cap_add )
			if ( std::find(caps.begin(), caps.end(), a) == caps.end())
				caps.push_back(a);

		JSON arr = JSON::Array();
		for ( const std::string& cp : caps )
			arr.append(JSON(cp));
		if ( !cfg.contains("process")) cfg["process"] = JSON::Object();
		JSON capset = JSON::Object();
		capset["bounding"]    = arr;
		capset["effective"]   = arr;
		capset["inheritable"] = arr;
		capset["permitted"]   = arr;
		capset["ambient"]     = JSON::Array();
		cfg["process"]["capabilities"] = capset;
	}

	// ---- seccomp: profile path, or "unconfined" -> OCI linux.seccomp ----------
	if ( !c.seccomp.empty()) {
		if ( c.seccomp == "unconfined" || c.seccomp == "none" ) {
			if ( cfg.contains("linux") && cfg["linux"].contains("seccomp"))
				cfg["linux"].erase("seccomp");        // no filter present = unconfined
		} else {
			std::ifstream sf(c.seccomp);
			if ( !sf ) { err = "seccomp profile not found: " + c.seccomp; return false; }
			std::string s(( std::istreambuf_iterator<char>(sf)), std::istreambuf_iterator<char>());
			try {
				JSON prof = JSON::parse(s);
				// ujail's parseOCIlinuxseccomp needs a defaultAction; without it the
				// container would crash-loop with no clear cause. Fail loudly instead.
				if ( prof.type() != JSON::TYPE::OBJECT || !prof.contains("defaultAction")) {
					err = "seccomp profile missing 'defaultAction' (not a valid OCI profile): " + c.seccomp;
					return false;
				}
				if ( !cfg.contains("linux")) cfg["linux"] = JSON::Object();
				cfg["linux"]["seccomp"] = prof;
			} catch ( ... ) {
				err = "invalid seccomp profile (not JSON): " + c.seccomp;
				return false;
			}
		}
	}

	// 0700 dirs + 0600 config: the shadow config embeds process.env, which may
	// hold secrets (e.g. RTSP/API passwords); keep it off world-readable paths.
	mkdir(SHADOW_DIR.c_str(), 0700);
	chmod(SHADOW_DIR.c_str(), 0700);                 // tighten if it predates this
	std::string dir = SHADOW_DIR + c.name;
	mkdir(dir.c_str(), 0700);
	chmod(dir.c_str(), 0700);
	std::string cfgpath = dir + "/config.json";
	std::ofstream of(cfgpath);
	if ( !of ) { err = "cannot write shadow config for " + c.name; return false; }
	of << cfg.dump(true) << "\n";
	if ( !of ) { err = "shadow config write failed for " + c.name; return false; }
	of.close();
	chmod(cfgpath.c_str(), 0600);

	out_bundle = dir;
	return true;
}

// ---- lifecycle ---------------------------------------------------------------
void launch(Container& c);

// Re-attempt a launch after a delay, as long as the container is still wanted up
// and not already running (used for crash restart and "infra not ready yet").
void schedule_relaunch(const std::string& name, int delay_ms) {
	uloop::task::add([name]() -> int {
		auto it = containers.find(name);
		if ( it != containers.end() && it -> second.desired == UP && it -> second.pid == 0 )
			launch(it -> second);
		return 0;
	}, delay_ms);
}

// Apply the restart policy after a container exits: reset the crash counter if it
// ran long enough, otherwise back off exponentially; give up after max_restarts
// rapid crashes. Called for both uloop-supervised and re-adopted containers.
void schedule_respawn(Container& c) {

	time_t up = c.started ? ( time(nullptr) - c.started ) : 0;
	c.started = 0;

	if ( c.desired != UP || !c.respawn ) {
		if ( c.desired == UP )
			logger::info << "uxcd: " << c.name << " exited; respawn disabled, leaving it down" << std::endl;
		return;
	}

	if ( up >= STABLE_SECS )
		c.crash_count = 0;        // ran long enough: not a crash loop
	else
		c.crash_count++;

	if ( uxcd::settings.max_restarts > 0 && c.crash_count > uxcd::settings.max_restarts ) {
		logger::error << "uxcd: " << c.name << " keeps crashing (" << c.crash_count
		              << " rapid restarts), giving up" << std::endl;
		c.desired = DOWN;
		return;
	}

	int shift = c.crash_count > 0 ? c.crash_count - 1 : 0;
	if ( shift > 5 ) shift = 5;   // cap the exponent (2^5 = 32x base)
	int delay = RESTART_DELAY_MS << shift;
	if ( delay > RESTART_MAX_DELAY_MS ) delay = RESTART_MAX_DELAY_MS;

	c.restarts++;
	logger::info << "uxcd: " << c.name << " is wanted up, restarting in " << ( delay / 1000 ) << "s"
	             << ( c.crash_count > 1 ? " (crash backoff)" : "" ) << std::endl;
	schedule_relaunch(c.name, delay);
}

// Watch every infra netns that has live members. An external event (network or
// firewall reload, manual ifdown) can tear the netns down underneath running
// containers; if that happens we bring it back up and restart the affected
// members so they rejoin the restored network namespace.
void infra_watchdog() {

	std::set<std::string> needed;
	for ( auto& kv : containers ) {
		Container& c = kv.second;
		if ( !c.infra.empty() && ( c.desired == UP || c.pid != 0 ))
			needed.insert(c.infra);
	}

	for ( const std::string& infra : needed ) {
		if ( netns_exists(infra))
			continue;

		logger::warning << "uxcd: infra netns '" << infra << "' went down, restoring" << std::endl;
		ensure_infra(infra);

		// running members are now on an orphaned netns - restart them so the
		// intent-restart path relaunches them into the restored one.
		for ( auto& kv : containers ) {
			Container& c = kv.second;
			if ( c.infra == infra && c.pid != 0 ) {
				logger::info << "uxcd: restarting " << c.name << " to rejoin infra " << infra << std::endl;
				kill(c.pid, SIGTERM);
			}
		}
	}
}

void start_infra_watchdog() {
	uloop::task::add([]() -> int {
		infra_watchdog();
		return INFRA_WATCH_MS;   // re-arm
	}, INFRA_WATCH_MS);
}

// Re-adopted containers aren't our children, so we can't waitpid them; poll
// their cgroup for liveness and apply the restart policy when one exits. A
// respawn relaunches it as a normal uloop-supervised container (with a log pipe).
void adopt_watchdog() {
	for ( auto& kv : containers ) {
		Container& c = kv.second;
		if ( !c.adopted || c.pid == 0 )
			continue;
		if ( cgroup_alive(c.name))
			continue;

		logger::info << "uxcd: adopted container " << c.name << " exited" << std::endl;
		c.pid = 0;
		c.adopted = false;
		c.health = "unknown";
		emit(c.name, "exited");

		schedule_respawn(c);   // same crash-aware policy as uloop-supervised exits
	}
}

void start_adopt_watchdog() {
	uloop::task::add([]() -> int {
		adopt_watchdog();
		return ADOPT_POLL_MS;   // re-arm
	}, ADOPT_POLL_MS);
}

void update_check_exit_cb(struct uloop_process* p, int ret) {
	(void)p; (void)ret;
	update_check_running = false;
	updates_checked = time(nullptr);
	updates.clear();
	std::ifstream f(SHADOW_DIR + "updates.out");   // name \t state \t digest
	std::string line;
	while ( std::getline(f, line)) {
		size_t t1 = line.find('\t');
		if ( t1 == std::string::npos )
			continue;
		size_t t2 = line.find('\t', t1 + 1);
		std::string name  = line.substr(0, t1);
		std::string state = line.substr(t1 + 1, ( t2 == std::string::npos ? line.size() : t2 ) - t1 - 1);
		UpdateInfo u;
		u.available = ( state == "update" );
		u.digest = ( t2 == std::string::npos ) ? "" : line.substr(t2 + 1);
		updates[name] = u;
	}
	logger::info << "uxcd: update check finished (" << updates.size() << " containers)" << std::endl;
}

// Swap a container's bundle with its <path>.prev backup (the same 3-rename dance
// as `uxc rollback`; reversible - swapping again rolls forward). Returns false if
// there is no .prev backup or a rename fails.
bool rollback_swap(const std::string& path) {
	std::string prev = path + ".prev";
	struct stat st;
	if ( stat(prev.c_str(), &st) != 0 )
		return false;
	std::string tmp = path + ".rollback-tmp";
	if ( rename(path.c_str(), tmp.c_str()) != 0 ||
	     rename(prev.c_str(), path.c_str()) != 0 ||
	     rename(tmp.c_str(), prev.c_str()) != 0 )
		return false;
	return true;
}

// Watch container `name` for up to window_s seconds: call done(true) as soon as a
// freshly (re)started instance reports healthy, else done(false) once the window
// elapses (or it vanishes). `after_started` is the launch time of the instance that
// was running when the watch began - we only accept a strictly newer instance, so
// the old image lingering during the restart's SIGTERM grace cannot pass the gate.
// Driven by a uloop task so the loop never blocks. Used by the health-gated safe-update.
void watch_health(const std::string& name, int window_s, time_t after_started, std::function<void(bool)> done) {
	time_t deadline = time(nullptr) + ( window_s > 0 ? window_s : 1 );
	auto cb = std::make_shared<std::function<void(bool)>>(std::move(done));
	uloop::task::add([name, deadline, after_started, cb]() -> int {
		auto it = containers.find(name);
		if ( it == containers.end())     { (*cb)(false); return 0; }   // vanished
		if ( it -> second.health == "healthy" && it -> second.started > after_started ) { (*cb)(true); return 0; }
		if ( time(nullptr) >= deadline ) { (*cb)(false); return 0; }   // window elapsed
		return 1000;   // not healthy yet: poll again in 1s
	}, 1000);
}

void job_exit_cb(struct uloop_process* p, int ret) {
	for ( auto& kv : jobs ) {
		Job& j = kv.second;
		if ( &j.proc != p )
			continue;
		j.running = false;
		j.exit_code = WIFEXITED(ret) ? WEXITSTATUS(ret) : -1;
		logger::info << "uxcd: job " << j.id << " (" << j.kind << " " << j.label
		             << ") finished, exit " << j.exit_code << std::endl;
		if ( j.exit_code == 0 && !j.restart_after.empty()) {
			std::string e, who = j.restart_after;
			// capture the gate + pre-restart instance BEFORE restarting: a running
			// container's old (healthy) instance lingers during the SIGTERM grace, and a
			// stopped one is relaunched synchronously - in both cases we must compare the
			// new instance against the one that existed *before* this restart.
			auto it = containers.find(who);
			time_t base = ( it != containers.end()) ? it -> second.started : 0;
			bool gate = j.safe_update && uxcd::settings.safe_update &&
			            it != containers.end() && it -> second.hc_interval > 0;
			if ( gate )
				it -> second.last_update.clear();
			logger::info << "uxcd: upgrade of " << who << " succeeded, restarting" << std::endl;
			uxcd::restart(who, e);   // apply the freshly re-pulled bundle

			// health-gated safe-update: watch the fresh instance and roll back to .prev if
			// it does not become healthy within the window. No healthcheck -> nothing to
			// gate on (plain upgrade).
			if ( gate ) {
				int window = uxcd::settings.safe_update_window;
				logger::info << "uxcd: safe-update watch for " << who << " (" << window << "s health window)" << std::endl;
				watch_health(who, window, base, [who](bool ok) {
					auto it = containers.find(who);
					if ( it == containers.end())
						return;
					if ( ok ) {
						it -> second.last_update = "verified";
						logger::info << "uxcd: update of " << who << " verified healthy" << std::endl;
						emit(who, "update_verified");
						return;
					}
					// not healthy within the window: roll the bundle back to .prev
					JSON cfg = read_config(who);
					std::string path = cfg.contains("path") ? cfg["path"].to_string() : "";
					logger::error << "uxcd: update of " << who << " did not become healthy; rolling back" << std::endl;
					if ( !path.empty() && rollback_swap(path)) {
						it -> second.last_update = "rolled_back";
						std::string e2;
						uxcd::restart(who, e2);
						emit(who, "rolled_back");
						logger::info << "uxcd: rolled " << who << " back to the previous bundle" << std::endl;
					} else {
						it -> second.last_update = "rollback_failed";
						logger::error << "uxcd: rollback of " << who << " failed (no .prev backup?)" << std::endl;
						emit(who, "rollback_failed");
					}
				});
			}
		}
		return;
	}
}

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
		emit(c.name, "exited");

		// unregistered while running? drop the in-memory entry instead of respawning
		// (remove() unlinks the registry file before stopping a running container).
		if ( !std::ifstream(UXC_DIR + c.name + ".json")) {
			std::string n = c.name;
			logger::info << "uxcd: container " << n << " was removed; dropping it" << std::endl;
			containers.erase(n);     // c is now dangling - do not touch it below
			return;
		}

		schedule_respawn(c);   // crash-aware backoff / max-restarts (resets c.started)
		return;
	}
}

void launch(Container& c) {

	if ( c.bundle.empty()) {
		logger::error << "uxcd: cannot start " << c.name << ": no bundle registered" << std::endl;
		return;
	}

	// dependencies must be up first - and healthy, if they define a healthcheck:
	// bring each up once and defer until ready. Boot order falls out of this. Fail-open:
	// after settings.start_timeout we launch anyway, so a stuck dependency never wedges us.
	bool dep_timeout = c.dep_wait_since != 0 &&
	                   ( time(nullptr) - c.dep_wait_since ) >= uxcd::settings.start_timeout;
	for ( const std::string& dep : c.depends_on ) {
		if ( dep == c.name )
			continue;
		auto di = containers.find(dep);
		if ( di == containers.end()) {
			logger::warning << "uxcd: " << c.name << " depends on unknown container " << dep << " (ignored)" << std::endl;
			continue;
		}
		bool running = ( di -> second.pid != 0 || cgroup_alive(dep));
		bool ready   = running && ( di -> second.hc_interval <= 0 || di -> second.health == "healthy" );
		if ( ready )
			continue;   // dependency is up (and healthy if it has a healthcheck)
		if ( dep_timeout ) {
			logger::warning << "uxcd: " << c.name << " starting without ready dependency " << dep
			                << " after " << uxcd::settings.start_timeout << "s (timeout)" << std::endl;
			continue;   // fail-open: treat as satisfied
		}
		if ( !running && di -> second.desired != UP ) {
			std::string e;
			uxcd::start(dep, e);   // bring the dependency up (idempotent)
		}
		logger::info << "uxcd: " << c.name << " waits for dependency " << dep
		             << ( running ? " to become healthy" : " to start" ) << std::endl;
		if ( c.dep_wait_since == 0 )
			c.dep_wait_since = time(nullptr);
		schedule_relaunch(c.name, RESTART_DELAY_MS);
		return;
	}
	c.dep_wait_since = 0;   // all dependencies ready (or timed out)

	// required filesystems: defer until they are mounted (procd's --mounts).
	for ( const std::string& m : c.req_mounts ) {
		if ( !is_mounted(m)) {
			logger::error << "uxcd: " << c.name << " requires mount " << m
			              << " (not available), retrying in " << ( RESTART_DELAY_MS / 1000 ) << "s" << std::endl;
			schedule_relaunch(c.name, RESTART_DELAY_MS);
			return;
		}
	}

	// infra members need the shared netns up first; defer if it isn't.
	if ( !c.infra.empty() && !ensure_infra(c.infra)) {
		logger::error << "uxcd: infra netns '" << c.infra << "' for " << c.name
		              << " is not up, retrying in " << ( RESTART_DELAY_MS / 1000 ) << "s" << std::endl;
		schedule_relaunch(c.name, RESTART_DELAY_MS);
		return;
	}

	// any registry override (infra, volumes, devices, env, resources, caps,
	// seccomp) is applied by generating a shadow OCI bundle; otherwise launch the
	// bundle directly.
	std::string bundle = c.bundle;
	if ( !c.infra.empty() || !c.volumes.empty() || !c.env.empty() ||
	     !c.devices.empty() || !c.resources.empty() ||
	     !c.cap_add.empty() || !c.cap_drop.empty() || !c.seccomp.empty()) {
		std::string err;
		if ( !make_launch_bundle(c, bundle, err)) {
			logger::error << "uxcd: cannot start " << c.name << ": " << err << std::endl;
			schedule_relaunch(c.name, RESTART_DELAY_MS);
			return;
		}
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
		std::vector<const char*> av;
		av.push_back("ujail");
		av.push_back("-n"); av.push_back(c.name.c_str());
		if ( !c.overlay_size.empty()) { av.push_back("-T"); av.push_back(c.overlay_size.c_str()); }
		if ( !c.overlay_path.empty()) { av.push_back("-O"); av.push_back(c.overlay_path.c_str()); }
		av.push_back("-J"); av.push_back(bundle.c_str());
		av.push_back("-i");
		av.push_back(nullptr);
		execvp("ujail", const_cast<char* const*>(av.data()));
		_exit(127);
	}

	close(pfd[1]);
	fcntl(pfd[0], F_SETFL, O_NONBLOCK);

	c.pid = pid;
	c.adopted = false;                 // uxcd-launched: uloop-supervised with a log pipe
	c.started = time(nullptr);
	{ struct stat cst; if ( stat(( UXC_DIR + c.name + ".json" ).c_str(), &cst) == 0 ) c.cfg_mtime = cst.st_mtime; }
	memset(&c.proc, 0, sizeof(c.proc));
	c.proc.pid = pid;
	c.proc.cb = proc_exit_cb;
	uloop_process_add(&c.proc);

	log_open(c);                       // persist stdout/stderr to /var/log/uxcd/<name>.log

	memset(&c.lfd, 0, sizeof(c.lfd));
	c.lfd.fd = pfd[0];
	c.lfd.cb = log_fd_cb;
	uloop_fd_add(&c.lfd, ULOOP_READ);
	c.lfd_active = true;

	c.hc_last_cpu = 0;
	schedule_health(c.name);

	logger::info << "uxcd: started container " << c.name << " (pid " << pid << ")" << std::endl;
	emit(c.name, "started");
}

} // namespace

namespace uxcd {

void set_event_sink(std::function<void(const std::string&, const JSON&)> sink) {
	g_event_sink = std::move(sink);
}

void init() {

	// apply tunables from /etc/config/uxcd (main has already called load_config)
	RESTART_DELAY_MS     = settings.restart_delay * 1000;
	RESTART_MAX_DELAY_MS = settings.restart_max_delay * 1000;
	STOP_TIMEOUT_MS  = settings.stop_timeout * 1000;
	MAX_LOG_LINES    = settings.log_lines > 0 ? (size_t)settings.log_lines : MAX_LOG_LINES;
	LOG_SIZE_BYTES   = settings.log_size > 0 ? settings.log_size * 1024 : LOG_SIZE_BYTES;
	PROBE_TIMEOUT_MS = settings.probe_timeout;
	INFRA_WATCH_MS   = settings.infra_watch * 1000;

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

	// re-adopt containers still running from a previous uxcd instance, so we do
	// not double-start them. They are poll-supervised (no log pipe); logs resume
	// the next time uxcd itself (re)starts them.
	for ( const std::string& name : names ) {
		Container& c = ensure(name);
		pid_t jp = find_jail_pid(name);
		if ( jp > 0 && cgroup_alive(name)) {
			c.pid = jp;
			c.adopted = true;
			c.desired = UP;
			c.started = time(nullptr);   // real start unknown; measure uptime from adoption
			{ struct stat cst; if ( stat(( UXC_DIR + name + ".json" ).c_str(), &cst) == 0 ) c.cfg_mtime = cst.st_mtime; }
			logger::info << "uxcd: re-adopted running container " << name << " (ujail pid " << jp << ")" << std::endl;
			emit(name, "adopted");
			schedule_health(name);
		}
	}

	// autostart "autostart": true containers that are not already running.
	// (procd's own "uxc boot" should be disabled so uxcd is the sole autostarter.)
	for ( const std::string& name : names ) {
		if ( containers[name].pid != 0 )
			continue;
		JSON cfg = read_config(name);
		if ( cfg.contains("autostart") && cfg["autostart"].to_bool()) {
			logger::info << "uxcd: autostarting " << name << std::endl;
			std::string err;
			if ( !start(name, err))
				logger::error << "uxcd: autostart of " << name << " failed: " << err << std::endl;
		}
	}

	start_infra_watchdog();
	start_adopt_watchdog();
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
		{
			auto uit = updates.find(name);
			if ( uit != updates.end() && uit -> second.available ) {
				c["update_available"] = true;
				if ( !uit -> second.digest.empty()) c["update_digest"] = uit -> second.digest;
			}
		}
		if ( cfg.contains("infra"))
			c["infra"] = cfg["infra"].to_string();

		auto it = containers.find(name);
		bool running = ( it != containers.end() && it -> second.pid != 0 );
		c["running"] = running;
		if ( running ) {
			c["pid"] = (long long)it -> second.pid;
			if ( cfg_changed(it -> second)) c["config_changed"] = true;
		}
		c["desired"] = ( it != containers.end() && it -> second.desired == UP ) ? "up" : "down";
		c["health"]  = ( it != containers.end()) ? it -> second.health : std::string("unknown");
		if ( it != containers.end() && !it -> second.last_update.empty())
			c["last_update"] = it -> second.last_update;

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

// Detailed view of a single container: everything `list` reports plus the OCI
// process command/cwd/hostname/root, uptime, restart count and the network
// namespace + its addresses - so a UI (LuCI) has one place to read it all.
JSON info(const std::string& name) {

	JSON res = JSON::Object();

	std::ifstream rf(UXC_DIR + name + ".json");
	if ( !rf ) { res["error"] = "unknown container '" + name + "'"; return res; }
	rf.close();

	JSON cfg = read_config(name);
	std::string bundle = cfg.contains("path")  ? cfg["path"].to_string()  : "";
	std::string infra  = cfg.contains("infra") ? cfg["infra"].to_string() : "";

	res["name"]      = name;
	res["bundle"]    = bundle;
	res["config"]    = UXC_DIR + name + ".json";
	if ( cfg.contains("image"))  res["image"]  = cfg["image"].to_string();    // provenance: pulled ref
	if ( cfg.contains("digest")) res["digest"] = cfg["digest"].to_string();   // resolved digest at pull
	{
		auto uit = updates.find(name);
		if ( uit != updates.end()) {
			res["update_available"] = uit -> second.available;
			if ( !uit -> second.digest.empty()) res["update_digest"] = uit -> second.digest;
		}
	}
	if ( !infra.empty())
		res["infra"] = infra;
	res["autostart"] = cfg.contains("autostart") && cfg["autostart"].to_bool();
	res["respawn"]   = !cfg.contains("respawn") || cfg["respawn"].to_bool();
	if ( cfg.contains("write_overlay_path"))
		res["write_overlay_path"] = cfg["write_overlay_path"].to_string();
	if ( cfg.contains("temp_overlay_size"))
		res["temp_overlay_size"] = cfg["temp_overlay_size"].to_string();
	if ( cfg.contains("mounts"))
		res["mounts"] = cfg["mounts"];
	if ( cfg.contains("volumes"))
		res["volumes"] = cfg["volumes"];
	if ( cfg.contains("devices"))
		res["devices"] = cfg["devices"];
	if ( cfg.contains("env"))
		res["env"] = cfg["env"];
	if ( cfg.contains("depends_on"))
		res["depends_on"] = cfg["depends_on"];
	if ( cfg.contains("cap_add"))
		res["cap_add"] = cfg["cap_add"];
	if ( cfg.contains("cap_drop"))
		res["cap_drop"] = cfg["cap_drop"];
	if ( cfg.contains("seccomp"))
		res["seccomp"] = cfg["seccomp"].to_string();
	if ( cfg.contains("resources"))
		res["resources"] = cfg["resources"];
	if ( cfg.contains("healthcheck"))
		res["healthcheck"] = cfg["healthcheck"];

	auto it = containers.find(name);
	bool running = ( it != containers.end() && it -> second.pid != 0 );
	res["running"] = running;
	res["desired"] = ( it != containers.end() && it -> second.desired == UP ) ? "up" : "down";
	res["health"]  = ( it != containers.end()) ? it -> second.health : std::string("unknown");
	if ( it != containers.end())
		res["restarts"] = (long long)it -> second.restarts;
	if ( it != containers.end() && !it -> second.last_update.empty())
		res["last_update"] = it -> second.last_update;   // verified | rolled_back | rollback_failed
	if ( running ) {
		res["pid"] = (long long)it -> second.pid;
		if ( cfg_changed(it -> second))
			res["config_changed"] = true;
		if ( it -> second.adopted )
			res["adopted"] = true;   // re-adopted across a uxcd restart (poll-supervised)
		if ( it -> second.started > 0 )
			res["uptime"] = (long long)( time(nullptr) - it -> second.started );
	}

	std::string cg = CGROUP_BASE + name + "/";
	res["memory"]      = (long long)read_u64(cg + "memory.current");
	res["memory_peak"] = (long long)read_u64(cg + "memory.peak");
	res["pids"]        = (long long)read_u64(cg + "pids.current");
	res["cpu_usec"]    = (long long)read_cpu_usec(cg);

	// OCI bundle: the in-container command, cwd, hostname and rootfs
	if ( !bundle.empty()) {
		std::ifstream bf(bundle + "/config.json");
		if ( bf ) {
			std::string s((std::istreambuf_iterator<char>(bf)), std::istreambuf_iterator<char>());
			try {
				JSON oci = JSON::parse(s);
				if ( oci.contains("hostname"))
					res["hostname"] = oci["hostname"].to_string();
				if ( oci.contains("process")) {
					JSON p = oci["process"];
					if ( p.contains("args"))
						res["command"] = p["args"];
					if ( p.contains("cwd"))
						res["cwd"] = p["cwd"].to_string();
				}
				if ( oci.contains("root") && oci["root"].contains("path"))
					res["root"] = oci["root"]["path"].to_string();
			} catch ( ... ) {}
		}
	}

	// network namespace + its IPv4 addresses. Query the live container netns (via
	// the init child) when running, since that reflects reality for both infra
	// members and own-netns containers; fall back to the named infra netns when
	// not running so its configured address is still shown.
	pid_t cpid = running ? container_init_pid(it -> second.pid) : 0;
	if ( cpid > 0 )
		res["init_pid"] = (long long)cpid;   // in-container PID 1 (for uxexec setns)
	std::string netns_path;
	int nsfd = -1;
	if ( !infra.empty())
		netns_path = NETNS_DIR + infra;
	else if ( cpid > 0 )
		netns_path = "/proc/" + std::to_string(cpid) + "/ns/net";
	if ( cpid > 0 )
		nsfd = open(( "/proc/" + std::to_string(cpid) + "/ns/net" ).c_str(), O_RDONLY | O_CLOEXEC);
	else if ( !infra.empty())
		nsfd = open(( NETNS_DIR + infra ).c_str(), O_RDONLY | O_CLOEXEC);
	if ( !netns_path.empty())
		res["netns"] = netns_path;
	if ( nsfd >= 0 ) {
		JSON arr = JSON::Array();
		for ( const std::string& a : netns_addrs(nsfd))
			arr.append(JSON(a));
		res["ipaddr"] = arr;
	}

	return res;
}

JSON logs(const std::string& name, int lines) {
	JSON res = JSON::Object();
	JSON arr = JSON::Array();

	// read the rotated file then the current one (persistent, survives restart),
	// keep the last N lines.
	std::vector<std::string> all;
	for ( const std::string& suffix : { std::string(".log.1"), std::string(".log") }) {
		std::ifstream f(LOG_DIR + name + suffix);
		std::string line;
		while ( std::getline(f, line))
			all.push_back(line);
	}

	size_t want = lines > 0 ? (size_t)lines : MAX_LOG_LINES;
	size_t start = all.size() > want ? all.size() - want : 0;
	for ( size_t i = start; i < all.size(); i++ )
		arr.append(JSON(all[i]));

	res["lines"] = arr;
	return res;
}

// Return the raw registry file (/etc/uxc/<name>.json) so an editor (uxc / LuCI)
// can load -> edit -> save it as a whole; the curated `info` view is for display.
JSON getconfig(const std::string& name) {
	JSON res = JSON::Object();
	if ( !valid_name(name)) { res["error"] = "invalid container name '" + name + "'"; return res; }
	std::ifstream f(UXC_DIR + name + ".json");
	if ( !f ) { res["error"] = "unknown container '" + name + "'"; return res; }
	std::string s(( std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	try {
		return JSON::parse(s);
	} catch ( ... ) {
		res["error"] = "registry file for '" + name + "' is not valid JSON";
		return res;
	}
}

// Replace the registry file with `config` (full-object replace), validated and
// written atomically (temp + rename, previous kept as .bak). Takes effect on the
// next start/restart; the in-memory config is refreshed so the next launch uses it.
bool setconfig(const std::string& name, const JSON& config, std::string& err) {
	if ( !valid_name(name)) { err = "invalid container name '" + name + "'"; return false; }
	if ( config.type() != JSON::TYPE::OBJECT ) { err = "config must be a JSON object"; return false; }
	if ( !config.contains("path") || config["path"].to_string().empty()) {
		err = "config must have a non-empty 'path' (the OCI bundle directory)";
		return false;
	}

	JSON cfg = config;
	cfg["name"] = name;                          // keep the file self-consistent

	std::string path = UXC_DIR + name + ".json";
	std::string tmp  = path + ".tmp";
	{
		std::ofstream of(tmp);
		if ( !of ) { err = "cannot write " + tmp; return false; }
		of << cfg.dump(true) << "\n";
		if ( !of ) { err = "write failed for " + tmp; return false; }
	}
	chmod(tmp.c_str(), 0600);                          // registry holds env (may hold secrets)
	rename(path.c_str(), ( path + ".bak" ).c_str());   // best effort backup
	if ( rename(tmp.c_str(), path.c_str()) != 0 ) {
		err = std::string("cannot replace ") + path + ": " + strerror(errno);
		return false;
	}

	auto it = containers.find(name);
	if ( it != containers.end())
		refresh_config(it -> second);              // next launch picks up the change
	return true;
}

// Start a docker2uxcd pull/build as a captured background child; returns the job
// id (empty + err on failure). docker2uxcd registers the container itself, so on
// success it simply appears in list(); poll job_status/job_log for progress.
std::string job_start(const std::string& kind, const JSON& params, std::string& err) {
	std::vector<std::string> args;
	std::string label, name = params.contains("name") ? params["name"].to_string() : "";

	if ( kind == "pull" ) {
		std::string image = params.contains("image") ? params["image"].to_string() : "";
		if ( image.empty()) { err = "pull needs 'image'"; return ""; }
		label = image;
		if ( !name.empty()) { args.push_back("--name"); args.push_back(name); }
		if ( params.contains("autostart") && params["autostart"].to_bool()) args.push_back("--autostart");
		if ( params.contains("infra") && !params["infra"].to_string().empty()) { args.push_back("--infra"); args.push_back(params["infra"].to_string()); }
		if ( params.contains("out") && !params["out"].to_string().empty()) { args.push_back("--out"); args.push_back(params["out"].to_string()); }
		args.push_back("--force");
		args.push_back(image);
	} else if ( kind == "build" ) {
		std::string df = params.contains("dockerfile") ? params["dockerfile"].to_string() : "";
		if ( df.empty()) { err = "build needs 'dockerfile'"; return ""; }
		label = df;
		args.push_back("--dockerfile"); args.push_back(df);
		if ( params.contains("context") && !params["context"].to_string().empty()) { args.push_back("--context"); args.push_back(params["context"].to_string()); }
		if ( !name.empty()) { args.push_back("--name"); args.push_back(name); }
		if ( params.contains("autostart") && params["autostart"].to_bool()) args.push_back("--autostart");
		if ( params.contains("infra") && !params["infra"].to_string().empty()) { args.push_back("--infra"); args.push_back(params["infra"].to_string()); }
		args.push_back("--force");
	} else {
		err = "unknown job kind '" + kind + "'";
		return "";
	}

	// reap old finished jobs so the map + /var/log/uxcd/jobs don't grow forever
	while ( jobs.size() >= 30 ) {
		auto oldest = jobs.end();
		for ( auto i = jobs.begin(); i != jobs.end(); ++i )
			if ( !i -> second.running && ( oldest == jobs.end() || i -> second.started < oldest -> second.started ))
				oldest = i;
		if ( oldest == jobs.end())
			break;                                  // all still running; don't reap
		unlink(oldest -> second.log_path.c_str());
		jobs.erase(oldest);
	}

	std::string id = "j" + std::to_string(++job_seq);
	mkdir(LOG_DIR.c_str(), 0755);
	mkdir(JOB_LOG_DIR.c_str(), 0755);
	std::string logp = JOB_LOG_DIR + id + ".log";
	int logfd = open(logp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
	if ( logfd < 0 ) { err = "cannot open job log " + logp; return ""; }

	pid_t pid = fork();
	if ( pid < 0 ) { close(logfd); err = "fork failed"; return ""; }
	if ( pid == 0 ) {
		setsid();
		dup2(logfd, STDOUT_FILENO);
		dup2(logfd, STDERR_FILENO);
		if ( logfd > STDERR_FILENO ) close(logfd);
		int dn = open("/dev/null", O_RDONLY);
		if ( dn >= 0 ) { dup2(dn, STDIN_FILENO); if ( dn > STDERR_FILENO ) close(dn); }
		// default bundle dir: a fresh pull/build without an explicit "out" otherwise
		// lands in uxcd's cwd ("/"). Run the converter from settings.bundle_dir so its
		// ./<name> default - and the absolute path it records - go there. An explicit
		// "out" (e.g. an upgrade re-pull) is absolute and unaffected by the chdir.
		if ( !( params.contains("out") && !params["out"].to_string().empty()) && !settings.bundle_dir.empty()) {
			mkdir_p(settings.bundle_dir, 0755);
			if ( chdir(settings.bundle_dir.c_str()) != 0 ) {}
		}
		std::vector<char*> av;
		av.push_back((char*)"docker2uxcd");
		for ( std::string& s : args ) av.push_back(const_cast<char*>(s.c_str()));
		av.push_back(nullptr);
		execvp("docker2uxcd", av.data());
		av[0] = (char*)"docker2uxc";
		execvp("docker2uxc", av.data());
		const char* m = "docker2uxcd not found; install it: opkg install docker2uxcd\n";
		(void)!write(STDERR_FILENO, m, strlen(m));
		_exit(127);
	}
	close(logfd);

	Job j;
	j.id = id; j.kind = kind; j.label = label; j.name = name;
	j.pid = pid; j.running = true; j.exit_code = -1; j.started = time(nullptr);
	j.log_path = logp;
	j.restart_after = params.contains("restart_after") ? params["restart_after"].to_string() : "";
	j.safe_update   = params.contains("safe_update") && params["safe_update"].to_bool();
	memset(&j.proc, 0, sizeof(j.proc));
	Job& jr = jobs.emplace(id, std::move(j)).first -> second;   // stable address in the map
	jr.proc.pid = pid;
	jr.proc.cb = job_exit_cb;
	uloop_process_add(&jr.proc);

	logger::info << "uxcd: job " << id << " started: docker2uxcd " << kind << " " << label << std::endl;
	return id;
}

JSON job_status(const std::string& id) {
	JSON res = JSON::Object();
	auto it = jobs.find(id);
	if ( it == jobs.end()) { res["error"] = "unknown job '" + id + "'"; return res; }
	Job& j = it -> second;
	res["id"] = id; res["kind"] = j.kind; res["label"] = j.label;
	if ( !j.name.empty()) res["name"] = j.name;
	res["running"] = j.running;
	res["started"] = (long long)j.started;
	if ( !j.running ) res["exit_code"] = (long long)j.exit_code;
	return res;
}

JSON job_log(const std::string& id, int lines) {
	JSON res = JSON::Object();
	JSON arr = JSON::Array();
	auto it = jobs.find(id);
	if ( it == jobs.end()) { res["error"] = "unknown job '" + id + "'"; return res; }
	std::ifstream f(it -> second.log_path);
	std::vector<std::string> all;
	std::string line;
	while ( std::getline(f, line)) all.push_back(line);
	size_t want = lines > 0 ? (size_t)lines : 200;
	size_t start = all.size() > want ? all.size() - want : 0;
	for ( size_t i = start; i < all.size(); i++ ) arr.append(JSON(all[i]));
	res["lines"] = arr;
	res["running"] = it -> second.running;
	if ( !it -> second.running ) res["exit_code"] = (long long)it -> second.exit_code;
	return res;
}

// Start an on-demand update check: runs `docker2uxcd --check-updates` as one
// captured child (non-blocking); update_check_exit_cb caches the result, which
// list()/info() then report. Returns false if a check is already running.
bool check_updates(std::string& err) {
	if ( update_check_running ) { err = "an update check is already running"; return false; }
	mkdir(SHADOW_DIR.c_str(), 0700);
	std::string outp = SHADOW_DIR + "updates.out";
	int ofd = open(outp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if ( ofd < 0 ) { err = "cannot open " + outp; return false; }

	pid_t pid = fork();
	if ( pid < 0 ) { close(ofd); err = "fork failed"; return false; }
	if ( pid == 0 ) {
		dup2(ofd, STDOUT_FILENO);
		if ( ofd > STDERR_FILENO ) close(ofd);
		int dn = open("/dev/null", O_WRONLY); if ( dn >= 0 ) dup2(dn, STDERR_FILENO);
		int di = open("/dev/null", O_RDONLY); if ( di >= 0 ) dup2(di, STDIN_FILENO);
		execlp("docker2uxcd", "docker2uxcd", "--check-updates", (char*)nullptr);
		execlp("docker2uxc",  "docker2uxc",  "--check-updates", (char*)nullptr);
		_exit(127);
	}
	close(ofd);
	update_check_running = true;
	memset(&update_proc, 0, sizeof(update_proc));
	update_proc.pid = pid;
	update_proc.cb = update_check_exit_cb;
	uloop_process_add(&update_proc);
	logger::info << "uxcd: update check started (pid " << pid << ")" << std::endl;
	return true;
}

// Re-pull the recorded image to the same bundle path as a job (keeps .prev, and
// the registry merge preserves the user's overrides), then restart on success.
// Returns the job id (empty + err on failure).
std::string upgrade(const std::string& name, std::string& err) {
	if ( !valid_name(name)) { err = "invalid container name '" + name + "'"; return ""; }
	JSON cfg = read_config(name);
	std::string image = cfg.contains("image") ? cfg["image"].to_string() : "";
	std::string path  = cfg.contains("path")  ? cfg["path"].to_string()  : "";
	if ( image.empty()) { err = "no recorded image for '" + name + "' - pull it once to enable upgrades"; return ""; }
	if ( path.empty())  { err = "no bundle path for '" + name + "'"; return ""; }
	JSON p = JSON::Object();
	p["image"] = image; p["name"] = name; p["out"] = path; p["restart_after"] = name;
	p["safe_update"] = true;   // health-gate the restart + auto-rollback to .prev if a healthcheck exists
	return job_start("pull", p, err);
}

JSON job_list() {
	JSON res = JSON::Object();
	for ( auto& kv : jobs ) {
		Job& j = kv.second;
		JSON o = JSON::Object();
		o["kind"] = j.kind; o["label"] = j.label;
		if ( !j.name.empty()) o["name"] = j.name;
		o["running"] = j.running;
		o["started"] = (long long)j.started;
		if ( !j.running ) o["exit_code"] = (long long)j.exit_code;
		res[j.id] = o;
	}
	return res;
}

// List registered bundles (path + size + running + .prev backup size) and the
// docker2uxc blob cache, so a UI can show disk/RAM use and offer a prune.
JSON images() {
	JSON res = JSON::Object();
	JSON bundles = JSON::Object();

	DIR* d = opendir(UXC_DIR.c_str());
	if ( d ) {
		struct dirent* e;
		while (( e = readdir(d))) {
			std::string fn = e -> d_name;
			if ( fn.size() <= 5 || fn.substr(fn.size() - 5) != ".json" )
				continue;
			std::string name = fn.substr(0, fn.size() - 5);
			JSON cfg = read_config(name);
			std::string path = cfg.contains("path") ? cfg["path"].to_string() : "";
			if ( path.empty())
				continue;
			JSON b = JSON::Object();
			b["path"] = path;
			b["size"] = (long long)dir_size(path);
			auto it = containers.find(name);
			b["running"] = ( it != containers.end() && it -> second.pid != 0 );
			struct stat st;
			if ( lstat(( path + ".prev" ).c_str(), &st) == 0 )
				b["prev"] = (long long)dir_size(path + ".prev");
			bundles[name] = b;
		}
		closedir(d);
	}
	res["bundles"] = bundles;

	std::string cache = cache_dir();
	JSON c = JSON::Object();
	c["path"] = cache;
	c["size"] = (long long)dir_size(cache);
	res["cache"] = c;
	return res;
}

// Reclaim disk/RAM: target "cache" (docker2uxc blob cache), "prev" (rollback
// backups of every registered bundle) or "all". Returns what was removed + freed.
JSON prune(const std::string& target) {
	JSON res = JSON::Object();
	if ( target != "cache" && target != "prev" && target != "all" ) {
		res["error"] = "target must be 'cache', 'prev' or 'all'";
		return res;
	}
	bool do_cache = ( target == "cache" || target == "all" );
	bool do_prev  = ( target == "prev"  || target == "all" );
	JSON removed = JSON::Array();
	unsigned long long freed = 0;

	if ( do_cache ) {
		std::string cache = cache_dir();
		struct stat st;
		if ( lstat(cache.c_str(), &st) == 0 ) {
			unsigned long long sz = dir_size(cache);
			if ( rm_rf(cache)) { freed += sz; removed.append(JSON("cache")); }
		}
	}
	if ( do_prev ) {
		DIR* d = opendir(UXC_DIR.c_str());
		if ( d ) {
			struct dirent* e;
			while (( e = readdir(d))) {
				std::string fn = e -> d_name;
				if ( fn.size() <= 5 || fn.substr(fn.size() - 5) != ".json" )
					continue;
				std::string name = fn.substr(0, fn.size() - 5);
				JSON cfg = read_config(name);
				std::string path = cfg.contains("path") ? cfg["path"].to_string() : "";
				if ( path.empty())
					continue;
				std::string prev = path + ".prev";
				struct stat st;
				if ( lstat(prev.c_str(), &st) == 0 ) {
					unsigned long long sz = dir_size(prev);
					if ( rm_rf(prev)) { freed += sz; removed.append(JSON(name + ".prev")); }
				}
			}
			closedir(d);
		}
	}
	res["removed"] = removed;
	res["freed"] = (long long)freed;
	return res;
}

// Prometheus text exposition of per-container + daemon metrics, generated where
// the data lives. Served over HTTP by the uxcd-metrics CGI (and `uxc metrics`).
std::string metrics() {
	auto esc = [](const std::string& s) {
		std::string o;
		for ( char c : s ) {
			if ( c == '\\' || c == '"' ) { o += '\\'; o += c; }
			else if ( c == '\n' ) o += "\\n";
			else o += c;
		}
		return o;
	};
	struct M { std::string name; int up; long long mem, mempeak, pids, cpu_usec, restarts; int health; };
	std::vector<M> ms;
	int running = 0;

	JSON l = list();
	for ( auto it = l.begin(); it != l.end(); ++it ) {
		JSON c = *it.value();
		M m; m.name = it.key();
		m.up = ( c.contains("running") && c["running"].to_bool()) ? 1 : 0;
		running += m.up;
		m.mem      = c.contains("memory")      ? (long long)c["memory"].to_number()      : 0;
		m.mempeak  = c.contains("memory_peak") ? (long long)c["memory_peak"].to_number() : 0;
		m.pids     = c.contains("pids")        ? (long long)c["pids"].to_number()        : 0;
		m.cpu_usec = c.contains("cpu_usec")    ? (long long)c["cpu_usec"].to_number()    : 0;
		std::string h = c.contains("health") ? c["health"].to_string() : "unknown";
		m.health = ( h == "healthy" ) ? 1 : ( h == "unhealthy" ) ? 0 : -1;
		auto cit = containers.find(m.name);
		m.restarts = ( cit != containers.end()) ? (long long)cit -> second.restarts : 0;
		ms.push_back(m);
	}

	std::string o;
	o += "# HELP uxcd_up uxcd daemon is responding\n# TYPE uxcd_up gauge\nuxcd_up 1\n";
	o += "# HELP uxcd_containers_total Number of registered containers\n# TYPE uxcd_containers_total gauge\n";
	o += "uxcd_containers_total " + std::to_string(ms.size()) + "\n";
	o += "# HELP uxcd_containers_running Number of running containers\n# TYPE uxcd_containers_running gauge\n";
	o += "uxcd_containers_running " + std::to_string(running) + "\n";

	auto family = [&]( const char* mname, const char* help, const char* type,
	                   std::function<std::string(const M&)> val ) {
		o += "# HELP "; o += mname; o += " "; o += help; o += "\n";
		o += "# TYPE "; o += mname; o += " "; o += type; o += "\n";
		for ( const M& m : ms ) {
			o += mname; o += "{name=\""; o += esc(m.name); o += "\"} "; o += val(m); o += "\n";
		}
	};
	family("uxcd_container_up", "Container running (1) or stopped (0)", "gauge",
	       [](const M& m){ return std::to_string(m.up); });
	family("uxcd_container_memory_bytes", "Container current memory in bytes", "gauge",
	       [](const M& m){ return std::to_string(m.mem); });
	family("uxcd_container_memory_peak_bytes", "Container peak memory in bytes", "gauge",
	       [](const M& m){ return std::to_string(m.mempeak); });
	family("uxcd_container_pids", "Container process count", "gauge",
	       [](const M& m){ return std::to_string(m.pids); });
	family("uxcd_container_cpu_seconds_total", "Container CPU time in seconds", "counter",
	       [](const M& m){ char b[32]; snprintf(b, sizeof b, "%.6f", m.cpu_usec / 1000000.0); return std::string(b); });
	family("uxcd_container_restarts_total", "Container auto-restarts since uxcd start", "counter",
	       [](const M& m){ return std::to_string(m.restarts); });
	family("uxcd_container_health", "Container health: 1 healthy, 0 unhealthy, -1 unknown", "gauge",
	       [](const M& m){ return std::to_string(m.health); });
	return o;
}

bool start(const std::string& name, std::string& err) {
	Container& c = ensure(name);
	if ( c.bundle.empty()) {
		err = "no bundle registered for '" + name + "'";
		return false;
	}
	c.desired = UP;
	c.crash_count = 0;                  // manual start: clear any crash backoff
	c.dep_wait_since = 0;               // fresh dependency-wait window for this start
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
			logger::info << "uxcd: " << name << " did not stop on SIGTERM, killing cgroup" << std::endl;
			cgroup_kill(name);
			kill(target, SIGKILL);   // belt and suspenders: the ujail too
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
	c.crash_count = 0;                  // manual restart: clear any crash backoff
	if ( c.pid != 0 )
		kill(c.pid, SIGTERM);
	else
		launch(c);
	return true;
}

bool create(const std::string& name, const std::string& bundle, bool autostart,
            bool respawn, const std::string& infra, const std::string& overlay_path,
            const std::string& overlay_size, const JSON& mounts,
            const JSON& healthcheck, std::string& err) {

	if ( !valid_name(name)) { err = "invalid container name '" + name + "'"; return false; }
	if ( bundle.empty()) { err = "bundle required"; return false; }

	std::ifstream cf(bundle + "/config.json");
	if ( !cf ) { err = "bundle has no config.json: " + bundle; return false; }
	cf.close();

	JSON j = JSON::Object();
	j["name"] = name;
	j["path"] = bundle;
	if ( autostart )
		j["autostart"] = true;
	if ( !respawn )                 // default is respawn on; only persist when off
		j["respawn"] = false;
	if ( !infra.empty())
		j["infra"] = infra;
	if ( !overlay_path.empty())
		j["write_overlay_path"] = overlay_path;
	if ( !overlay_size.empty())
		j["temp_overlay_size"] = overlay_size;
	if ( !mounts.empty())
		j["mounts"] = mounts;
	if ( !healthcheck.empty())
		j["healthcheck"] = healthcheck;

	std::ofstream f(UXC_DIR + name + ".json");
	if ( !f ) { err = "cannot write " + UXC_DIR + name + ".json"; return false; }
	f << j.dump(true) << "\n";
	if ( !f ) { err = "write failed"; return false; }
	f.close();
	chmod(( UXC_DIR + name + ".json" ).c_str(), 0600);   // may hold env secrets

	refresh_config(ensure(name));
	logger::info << "uxcd: registered container " << name << std::endl;
	return true;
}

bool remove(const std::string& name, std::string& err) {
	if ( !valid_name(name)) { err = "invalid container name '" + name + "'"; return false; }
	auto it = containers.find(name);
	bool running = ( it != containers.end() && it -> second.pid != 0 );
	// unlink the registry first, so when a still-running container exits,
	// proc_exit_cb sees it gone and drops the in-memory entry (no respawn, no leak).
	unlink(( UXC_DIR + name + ".json").c_str());
	unlink(( LOG_DIR + name + ".log").c_str());
	unlink(( LOG_DIR + name + ".log.1").c_str());
	if ( running ) {
		std::string e;
		stop(name, e);   // SIGTERM + SIGKILL fallback; exit cb drops the map entry
	} else if ( it != containers.end())
		containers.erase(it);
	logger::info << "uxcd: removed container " << name << std::endl;
	return true;
}

} // namespace uxcd
