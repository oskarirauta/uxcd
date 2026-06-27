#include <iostream>

#include "logger.hpp"
#include "ubus.hpp"
#include "signal.hpp"
#include "usage.hpp"
#include "version.hpp"
#include "config.hpp"
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

static int info_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	res = uxcd::info(req["name"].to_string());
	return 0;
}

static int log_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	int lines = req.contains("lines") ? (int)req["lines"].to_number() : 0;
	res = uxcd::logs(req["name"].to_string(), lines);
	return 0;
}

static int create_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	std::string name   = req.contains("name")   ? req["name"].to_string()   : "";
	std::string bundle = req.contains("bundle") ? req["bundle"].to_string() : "";
	bool autostart     = req.contains("autostart") && req["autostart"].to_bool();
	bool respawn       = !req.contains("respawn") || req["respawn"].to_bool();
	std::string infra  = req.contains("infra") ? req["infra"].to_string() : "";
	std::string ovp    = req.contains("write_overlay_path") ? req["write_overlay_path"].to_string() : "";
	std::string ovs    = req.contains("temp_overlay_size")  ? req["temp_overlay_size"].to_string()  : "";
	JSON mounts        = req.contains("mounts") ? req["mounts"] : JSON();
	JSON hc            = req.contains("healthcheck") ? req["healthcheck"] : JSON();
	std::string err;
	if ( uxcd::create(name, bundle, autostart, respawn, infra, ovp, ovs, mounts, hc, err)) res["success"] = true;
	else res["error"] = err;
	return 0;
}

static int remove_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	std::string err;
	if ( uxcd::remove(req["name"].to_string(), err)) res["success"] = true;
	else res["error"] = err;
	return 0;
}

static int getconfig_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	res = uxcd::getconfig(req["name"].to_string());
	return 0;
}

static int setconfig_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	if ( !req.contains("config")) {
		res["error"] = "missing 'config'";
		return 0;
	}
	std::string err;
	if ( uxcd::setconfig(req["name"].to_string(), req["config"], err)) res["success"] = true;
	else res["error"] = err;
	return 0;
}

// pull/build: start a docker2uxcd job (long-running) and return its id; the UI
// polls job_status/job_log. job_list/job_status/job_log report progress.
static int pull_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	std::string err;
	std::string id = uxcd::job_start("pull", req, err);
	if ( id.empty()) res["error"] = err; else res["job"] = id;
	return 0;
}

static int build_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	std::string err;
	std::string id = uxcd::job_start("build", req, err);
	if ( id.empty()) res["error"] = err; else res["job"] = id;
	return 0;
}

static int job_status_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("id") || req["id"].to_string().empty()) { res["error"] = "missing 'id'"; return 0; }
	res = uxcd::job_status(req["id"].to_string());
	return 0;
}

static int job_log_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("id") || req["id"].to_string().empty()) { res["error"] = "missing 'id'"; return 0; }
	int lines = req.contains("lines") ? (int)req["lines"].to_number() : 0;
	res = uxcd::job_log(req["id"].to_string(), lines);
	return 0;
}

static int job_list_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res = uxcd::job_list();
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

int main(int argc, char** argv) {

	usage_t usage = {
		.args = { argc, argv },
		.info = {
			.name = "uxcd",
			.version_title = "version ",
			.version = UXCD_VERSION,
			.copyright = "2026, Oskari Rauta",
			.usage = "[options]",
			.description = "\ncontainer supervisor daemon; serves the 'uxcd' ubus object",
		},
		.options = {
			{ "socket",  { .key = "s", .word = "socket", .desc = "ubus socket path", .flag = usage_t::REQUIRED, .name = "path" }},
			{ "debug",   { .key = "d", .word = "debug",  .desc = "verbose/debug logging" }},
			{ "help",    { .key = "h", .word = "help",   .desc = "show this help" }},
			{ "version", { .key = "V", .word = "version",.desc = "show version" }},
		}
	};

	if ( (bool)usage["version"] ) { std::cout << usage.version() << std::endl; return 0; }
	if ( (bool)usage["help"] )    { std::cout << usage << "\n" << usage.help() << std::endl; return 0; }

	// /etc/config/uxcd first, then let -s / -d override it
	uxcd::load_config();
	if ( (bool)usage["socket"] ) uxcd::settings.socket = usage["socket"].value;
	if ( (bool)usage["debug"] )  uxcd::settings.debug = true;
	if ( uxcd::settings.debug )  logger::loglevel(logger::debug);

	logger::info << "uxcd " << UXCD_VERSION << " starting" << std::endl;
	logger::verbose << "uxcd: settings: log_lines=" << uxcd::settings.log_lines
	                << " restart_delay=" << uxcd::settings.restart_delay << "s"
	                << " stop_timeout=" << uxcd::settings.stop_timeout << "s"
	                << " infra_watch=" << uxcd::settings.infra_watch << "s"
	                << " probe_timeout=" << uxcd::settings.probe_timeout << "ms"
	                << ( uxcd::settings.socket.empty() ? "" : " socket=" + uxcd::settings.socket ) << std::endl;

	SIG handler = {
		.TERM = stop_handler,
		.INT  = stop_handler,
	};
	handler.install();

	try {
		srv = new ubus(uxcd::settings.socket);
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: cannot connect to ubus: " << e.what() << std::endl;
		return 1;
	}

	try {
		srv -> add_object("uxcd", {
			{ .name = "list",    .cb = list_func },
			{ .name = "info",    .cb = info_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "log",     .cb = log_func, .hints = {{ "name", JSON::TYPE::STRING }, { "lines", JSON::TYPE::INT }}},
			{ .name = "create",  .cb = create_func, .hints = {{ "name", JSON::TYPE::STRING }, { "bundle", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "respawn", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }}},
			{ .name = "remove",  .cb = remove_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "getconfig", .cb = getconfig_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "setconfig", .cb = setconfig_func, .hints = {{ "name", JSON::TYPE::STRING }, { "config", JSON::TYPE::OBJECT }}},
			{ .name = "pull",    .cb = pull_func, .hints = {{ "image", JSON::TYPE::STRING }, { "name", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }}},
			{ .name = "build",   .cb = build_func, .hints = {{ "dockerfile", JSON::TYPE::STRING }, { "context", JSON::TYPE::STRING }, { "name", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }}},
			{ .name = "job_list",   .cb = job_list_func },
			{ .name = "job_status", .cb = job_status_func, .hints = {{ "id", JSON::TYPE::STRING }}},
			{ .name = "job_log",    .cb = job_log_func, .hints = {{ "id", JSON::TYPE::STRING }, { "lines", JSON::TYPE::INT }}},
			{ .name = "start",   .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "stop",    .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
			{ .name = "restart", .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		});
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: cannot register ubus object: " << e.what() << std::endl;
		delete srv;
		return 1;
	}

	// broadcast container state changes as ubus events (uxcd.container)
	uxcd::set_event_sink([](const std::string& id, const JSON& data) {
		if ( srv ) srv -> send_event(id, data);
	});

	uxcd::init();

	logger::info << "uxcd started, serving ubus object 'uxcd'" << std::endl;
	uloop::run();

	delete srv;
	logger::info << "uxcd stopped" << std::endl;
	return 0;
}
