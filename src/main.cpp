#include "logger.hpp"
#include "ubus.hpp"
#include "signal.hpp"
#include "container.hpp"

static ubus* srv = nullptr;

static void stop_handler(int signum) {
	logger::info << "uxcd: " << SIG::to_string(signum) << " received, shutting down" << std::endl;
	uloop::exit();
}

static int list_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res = uxcd::list();
	return 0;
}

// Shared handler for start/stop/restart: pulls "name" from the request and
// dispatches to the matching uxcd lifecycle call.
static int lifecycle_func(const std::string& method, const JSON& req, JSON& res) {

	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	std::string name = req["name"].to_string();
	std::string err;
	bool ok = false;

	if ( method == "start" )        ok = uxcd::start(name, err);
	else if ( method == "stop" )    ok = uxcd::stop(name, err);
	else if ( method == "restart" ) ok = uxcd::restart(name, err);
	else { res["error"] = "unknown method"; return 0; }

	if ( ok )
		res["success"] = true;
	else
		res["error"] = err;
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
			{ .name = "list",    .cb = list_func },
			{ .name = "start",   .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "stop",    .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "restart", .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
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
