#include <fstream>
#include <string>

#include "logger.hpp"
#include "ubus.hpp"
#include "signal.hpp"

static ubus* srv = nullptr;

static const std::string CGROUP_BASE = "/sys/fs/cgroup/containers/";

static void stop_handler(int signum) {
	logger::info << "uxcd: " << SIG::to_string(signum) << " received, shutting down" << std::endl;
	uloop::exit();
}

// Read a single unsigned integer from a cgroup file; 0 if missing/empty.
static unsigned long long read_u64(const std::string& path) {

	std::ifstream f(path);
	unsigned long long v = 0;
	if ( f )
		f >> v;
	return v;
}

// cpu.stat has lines like "usage_usec 12345"; return the usage_usec value.
static unsigned long long read_cpu_usec(const std::string& cgdir) {

	std::ifstream f(cgdir + "cpu.stat");
	std::string key;
	unsigned long long v;
	while ( f >> key >> v )
		if ( key == "usage_usec" )
			return v;
	return 0;
}

// uxcd.list - clean per-container view: state (from procd) + cgroup resources.
static int list_func(const std::string& method, const JSON& req, JSON& res) {

	(void)method; (void)req;

	JSON raw;
	try {
		raw = srv -> call("container", "list", JSON());
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: container list failed: " << e.what() << std::endl;
		res["error"] = e.what();
		return 0;
	}

	for ( auto it = raw.begin(); it != raw.end(); ++it ) {

		std::string name = it.name();
		JSON entry = *it.value();

		// procd nests the running instance under "instances"; for uxc the
		// instance is named after the container.
		JSON inst;
		if ( entry.contains("instances")) {
			JSON insts = entry["instances"];
			if ( insts.contains(name))
				inst = insts[name];
			else
				for ( auto i = insts.begin(); i != insts.end(); ++i ) { inst = *i.value(); break; }
		}

		JSON c;
		c["running"] = inst.contains("running") ? inst["running"].to_bool() : false;
		if ( inst.contains("pid"))
			c["pid"] = inst["pid"];
		if ( inst.contains("bundle"))
			c["bundle"] = inst["bundle"];

		std::string cgdir = CGROUP_BASE + name + "/";
		c["memory"] = (long long)read_u64(cgdir + "memory.current");
		c["memory_peak"] = (long long)read_u64(cgdir + "memory.peak");
		c["pids"] = (long long)read_u64(cgdir + "pids.current");
		c["cpu_usec"] = (long long)read_cpu_usec(cgdir);

		res[name] = c;
	}

	return 0;
}

int main() {

	logger::info << "uxcd starting" << std::endl;

	SIG handler = {
		.TERM = stop_handler,
		.INT  = stop_handler,
	};
	handler.install();

	try {
		srv = new ubus;
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: cannot connect to ubus: " << e.what() << std::endl;
		return 1;
	}

	try {
		srv -> add_object("uxcd", {
			{ .name = "list", .cb = list_func },
		});
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: cannot register ubus object: " << e.what() << std::endl;
		delete srv;
		return 1;
	}

	logger::info << "uxcd started, serving ubus object 'uxcd'" << std::endl;
	uloop::run();

	delete srv;
	logger::info << "uxcd stopped" << std::endl;
	return 0;
}
