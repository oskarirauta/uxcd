#include "logger.hpp"
#include "ubus.hpp"
#include "signal.hpp"

static ubus* srv = nullptr;

static void stop_handler(int signum) {
	logger::info << "uxcd: " << SIG::to_string(signum) << " received, shutting down" << std::endl;
	uloop::exit();
}

// uxcd.list - for now this proxies procd's "container list"; cgroup resource
// stats (memory/cpu/pids per container) are added in the next step.
static int list_func(const std::string& method, const JSON& req, JSON& res) {

	(void)method; (void)req;

	try {
		res = srv -> call("container", "list", JSON());
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: container list failed: " << e.what() << std::endl;
		res["error"] = e.what();
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
