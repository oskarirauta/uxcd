#include <fstream>
#include <iterator>
#include <map>
#include <cstring>

#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

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

enum desired_t { DOWN, UP };

struct Container {
	std::string name;
	std::string bundle;
	desired_t desired = DOWN;
	pid_t pid = 0;                 // running ujail pid, 0 if not running
	struct uloop_process proc;     // exit supervision (do not move once added)
};

// std::map keeps node addresses stable, so &Container::proc stays valid while it
// is linked into uloop's process list.
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
	return containers.emplace(name, std::move(c)).first -> second;
}

void launch(Container& c);

void proc_exit_cb(struct uloop_process* p, int ret) {
	for ( auto& kv : containers ) {
		Container& c = kv.second;
		if ( &c.proc != p )
			continue;

		logger::info << "uxcd: container " << c.name << " exited (code " << ret << ")" << std::endl;
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

	pid_t pid = fork();
	if ( pid < 0 ) {
		logger::error << "uxcd: fork failed for " << c.name << std::endl;
		return;
	}

	if ( pid == 0 ) {
		// child: ujail becomes the container runtime; discard its stdio for now
		// (per-container log capture arrives in the next phase).
		int devnull = open("/dev/null", O_RDWR);
		if ( devnull >= 0 ) {
			dup2(devnull, STDOUT_FILENO);
			dup2(devnull, STDERR_FILENO);
			if ( devnull > STDERR_FILENO )
				close(devnull);
		}
		execlp("ujail", "ujail", "-n", c.name.c_str(), "-J", c.bundle.c_str(), "-i", (char*)nullptr);
		_exit(127);
	}

	c.pid = pid;
	memset(&c.proc, 0, sizeof(c.proc));
	c.proc.pid = pid;
	c.proc.cb = proc_exit_cb;
	uloop_process_add(&c.proc);

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
