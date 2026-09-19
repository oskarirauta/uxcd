#include <iostream>

#include "logger.hpp"
#include "ubus.hpp"
#include "signal.hpp"
#include "usage.hpp"
#include "version.hpp"
#include "config.hpp"
#include "container.hpp"

extern "C" {
#include <libubox/uloop.h>   // uloop_end(): async-signal-safe way to stop the loop from a signal handler
#include <sys/stat.h>
#include <dirent.h>
#include <fstream>
}

static ubus* srv = nullptr;
static volatile sig_atomic_t shutdown_signum = 0;

// Async-signal-safe: SIGTERM/SIGINT can interrupt the main thread anywhere, so the
// handler must not take a lock or allocate. Record the signal and ask uloop to stop
// (uloop_end only sets a flag); the log + teardown run after uloop::run() returns.
static void stop_handler(int signum) {
	shutdown_signum = signum;
	uloop_end();
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

static int log_clear_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) { res["error"] = "missing 'name'"; return 0; }
	std::string err;
	if ( !uxcd::log_clear(req["name"].to_string(), err)) res["error"] = err;
	else res["success"] = true;
	return 0;
}

// A container mid-upgrade is locked: the running pull job restarts it on
// success, and a concurrent lifecycle/config/bundle action would race the
// bundle rotation. Guards the ubus surface only - the daemon's own internal
// calls (the job's restart, provenance writes) are unaffected.
static bool upgrade_locked(const std::string& name, JSON& res) {
	if ( !uxcd::is_upgrading(name))
		return false;
	res["error"] = "an upgrade of '" + name + "' is in progress - wait for it to finish or cancel the job";
	return true;
}

static int rename_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || !req.contains("new_name") ||
	     req["name"].to_string().empty() || req["new_name"].to_string().empty()) {
		res["error"] = "missing 'name'/'new_name'"; return 0;
	}
	if ( upgrade_locked(req["name"].to_string(), res)) return 0;
	std::string err;
	if ( !uxcd::rename_container(req["name"].to_string(), req["new_name"].to_string(), err)) res["error"] = err;
	else res["success"] = true;
	return 0;
}

static int registry_list_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res["registries"] = uxcd::registry_list();
	return 0;
}

static int registry_set_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("registry") || req["registry"].to_string().empty()) { res["error"] = "missing 'registry'"; return 0; }
	std::string err;
	if ( !uxcd::registry_set(req["registry"].to_string(),
	                         req.contains("username") ? req["username"].to_string() : "",
	                         req.contains("password") ? req["password"].to_string() : "", err))
		res["error"] = err;
	else res["success"] = true;
	return 0;
}

static int registry_remove_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("registry") || req["registry"].to_string().empty()) { res["error"] = "missing 'registry'"; return 0; }
	std::string err;
	if ( !uxcd::registry_remove(req["registry"].to_string(), err)) res["error"] = err;
	else res["success"] = true;
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
	if ( upgrade_locked(req["name"].to_string(), res)) return 0;
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

static int console_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) {
		res["error"] = "missing 'name'";
		return 0;
	}
	std::string bind = req.contains("bind") ? req["bind"].to_string() : "";
	bool tls = req.contains("tls") ? ((int)req["tls"].to_number() != 0) : false;
	res = uxcd::console(req["name"].to_string(), bind, tls);
	return 0;
}

static int console_active_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	int port = req.contains("port") ? (int)req["port"].to_number() : 0;
	res["active"] = ( port > 0 ) && uxcd::console_active(port);
	return 0;
}

// Deferred: exec runs a command inside the container and replies when it finishes
// (so a slow command never blocks the uloop). Replies {exit_code, output, ...}.
static void exec_func(const std::string& method, const JSON& req, ubus::request r) {
	(void)method;
	std::vector<std::string> cmd;
	if ( req.contains("command") && req["command"].type() == JSON::TYPE::ARRAY ) {
		JSON a = req["command"];
		for ( auto it = a.begin(); it != a.end(); ++it )
			cmd.push_back(( *it.value()).to_string());
	}
	std::string name = req.contains("name") ? req["name"].to_string() : "";
	int tmo = req.contains("timeout") ? (int)req["timeout"].to_number() * 1000 : 0;
	uxcd::exec_async(name, cmd, tmo, [r](JSON res) { r.reply(res); });
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
	if ( upgrade_locked(req["name"].to_string(), res)) return 0;
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
	JSON r = req;
	// wizard path: Dockerfile CONTENT arrives inline and is written next to the
	// future bundle as <dir>.Dockerfile - the container's editable recipe (edit
	// it and `uxc build` the path again to evolve the container) - and the job
	// then builds from that file.
	if ( r.contains("dockerfile_content") && !r["dockerfile_content"].to_string().empty()) {
		std::string name = r.contains("name") ? r["name"].to_string() : "";
		std::string body = r["dockerfile_content"].to_string();
		if ( name.empty() || name.find('/') != std::string::npos || name[0] == '.' ) {
			res["error"] = "dockerfile_content needs a plain 'name'"; return 0;
		}
		if ( body.size() > 65536 ) { res["error"] = "dockerfile_content too large"; return 0; }
		std::string dir = ( r.contains("out") && !r["out"].to_string().empty())
			? r["out"].to_string() : ( uxcd::settings.bundle_dir + "/" + name );
		{
			std::string parent = dir;
			std::string::size_type s = parent.find_last_of('/');
			parent = ( s == std::string::npos ) ? std::string(".") : ( s == 0 ? std::string("/") : parent.substr(0, s));
			if ( !parent.empty() && parent != "." && parent != "/" ) {
				std::string cur = ( parent[0] == '/' ) ? std::string("/") : std::string();
				std::string part;
				for ( std::string::size_type i = 0; i <= parent.size(); ++i ) {
					char ch = ( i < parent.size() ) ? parent[i] : '/';
					if ( ch == '/' ) {
						if ( part.empty()) continue;
						if ( cur.empty() || cur == "/" ) cur += part;
						else cur += "/" + part;
						mkdir(cur.c_str(), 0755);
						part.clear();
					} else part += ch;
				}
			}
		}
		std::string path = dir + ".Dockerfile";
		{
			std::ofstream f(path);
			if ( !f ) { res["error"] = "cannot write " + path; return 0; }
			f << body;
		}
		r["dockerfile"] = path;
	}
	std::string id = uxcd::job_start("build", r, err);
	if ( id.empty()) res["error"] = err; else res["job"] = id;
	return 0;
}

// deploy: create a container from a recipe (a profile that also says where the
// container comes from). Resolves to a pull or a build in the job child, so the
// whole "fetch/build + host dirs + config files + registry" sequence is one call.
static int deploy_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("recipe") || req["recipe"].to_string().empty()) { res["error"] = "deploy needs 'recipe'"; return 0; }
	std::string err;
	std::string id = uxcd::job_start("deploy", req, err);
	if ( id.empty()) res["error"] = err; else res["job"] = id;
	return 0;
}

// What attachable devices this box actually has - the LuCI "New container"
// wizard shows only what exists (GPU, USB bus, serial dongles, TUN, PCIe Coral).
static int host_devices_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	struct stat st;
	res["gpu"] = ( stat("/dev/dri", &st) == 0 );
	res["usb"] = ( stat("/dev/bus/usb", &st) == 0 );
	res["tun"] = ( stat("/dev/net/tun", &st) == 0 );
	JSON serial = JSON::Array(), apex = JSON::Array();
	if ( DIR* d = opendir("/dev")) {
		struct dirent* e;
		while (( e = readdir(d))) {
			std::string n = e -> d_name;
			if ( n.rfind("ttyUSB", 0) == 0 || n.rfind("ttyACM", 0) == 0 ) serial.append(JSON("/dev/" + n));
			else if ( n.rfind("apex_", 0) == 0 ) apex.append(JSON("/dev/" + n));
		}
		closedir(d);
	}
	res["serial"] = serial;
	res["apex"] = apex;
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

static int images_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res = uxcd::images();
	return 0;
}

static int doctor_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) { res["error"] = "doctor needs 'name'"; return 0; }
	res = uxcd::doctor(req["name"].to_string());
	return 0;
}

static int list_profiles_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	JSON details;
	res["profiles"] = uxcd::list_profiles(&details);   // names, for older callers
	res["details"]  = details;                         // what each one actually does
	return 0;
}

// list_recipes: the deployable profiles, with what each deploy would create -
// the LuCI Recipes gallery reads this and nothing else.
static int list_recipes_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res = uxcd::list_recipes();
	return 0;
}

static int events_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	int limit = req.contains("limit") ? (int)req["limit"].to_number() : 0;
	res["events"] = uxcd::events(limit);
	return 0;
}

static int events_clear_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	uxcd::events_clear();
	res["success"] = true;
	return 0;
}

static int check_updates_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	std::string err;
	if ( uxcd::check_updates(err)) res["checking"] = true;
	else res["error"] = err;
	return 0;
}

static int upgrade_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) { res["error"] = "missing 'name'"; return 0; }
	std::string err;
	if ( upgrade_locked(req["name"].to_string(), res)) return 0;   // one upgrade at a time
	std::string img = req.contains("image") ? req["image"].to_string() : "";   // optional version/tag jump
	std::string id = uxcd::upgrade(req["name"].to_string(), err, img);
	if ( id.empty()) res["error"] = err; else res["job"] = id;
	return 0;
}

static int rollback_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("name") || req["name"].to_string().empty()) { res["error"] = "missing 'name'"; return 0; }
	if ( upgrade_locked(req["name"].to_string(), res)) return 0;
	std::string err;
	if ( uxcd::rollback(req["name"].to_string(), err)) res["success"] = true; else res["error"] = err;
	return 0;
}

static int job_cancel_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	if ( !req.contains("id") || req["id"].to_string().empty()) { res["error"] = "missing 'id'"; return 0; }
	std::string err;
	if ( uxcd::job_cancel(req["id"].to_string(), err)) res["success"] = true; else res["error"] = err;
	return 0;
}

static int prune_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method;
	res = uxcd::prune(req.contains("target") ? req["target"].to_string() : "");
	return 0;
}

static int metrics_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;
	res["metrics"] = uxcd::metrics();
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
	if ( upgrade_locked(name, res)) return 0;
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

// ---- uxcd.api: self-describing contract ------------------------------------

static std::vector<ubus::method> uxcd_methods();   // defined below; used by api_func

static const char* json_type_name(JSON::TYPE t) {
	switch ( t ) {
		case JSON::TYPE::STRING: return "string";
		case JSON::TYPE::INT:    return "int";
		case JSON::TYPE::FLOAT:  return "float";
		case JSON::TYPE::BOOL:   return "bool";
		case JSON::TYPE::OBJECT: return "object";
		case JSON::TYPE::ARRAY:  return "array";
		default:                 return "null";
	}
}

// uxcd.api: daemon + api version, the method list with parameter type hints
// (generated from the same table that is actually registered, so the advertised
// contract can never silently drift), and the feature flags a client can key on.
static int api_func(const std::string& method, const JSON& req, JSON& res) {
	(void)method; (void)req;

	res["daemon_version"] = UXCD_VERSION;
	res["api_version"] = 1;

	JSON methods = JSON::Object();
	for ( const auto& m : uxcd_methods()) {
		JSON params = JSON::Object();
		for ( const auto& [pname, ptype] : m.hints )
			params[pname] = json_type_name(ptype);
		methods[m.name] = params;
	}
	res["methods"] = methods;

	static const char* const feats[] = {
		"multi_stage", "ipv6", "safe_update", "metrics", "profiles",
		"recipes", "build_provenance", "published_ports",
		"read_only_rootfs", "compose", "schedule", "health", "exec",
		"console", "events", "registries", "dev_containers", "new_version_tags",
		"doctor", "profile_match", "resource_limits"
	};
	JSON features = JSON::Array();
	for ( const char* f : feats )
		features.append(JSON(std::string(f)));
	res["features"] = features;

	return 0;
}

// The registered ubus method table - shared by add_object() and uxcd.api so the
// advertised contract is exactly what is served.
static std::vector<ubus::method> uxcd_methods() {
	return {
		{ .name = "api",     .cb = api_func },
		{ .name = "list",    .cb = list_func },
		{ .name = "info",    .cb = info_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "log",     .cb = log_func, .hints = {{ "name", JSON::TYPE::STRING }, { "lines", JSON::TYPE::INT }}},
		{ .name = "log_clear", .cb = log_clear_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "rename", .cb = rename_func, .hints = {{ "name", JSON::TYPE::STRING }, { "new_name", JSON::TYPE::STRING }}},
		{ .name = "console", .cb = console_func, .hints = {{ "name", JSON::TYPE::STRING }, { "bind", JSON::TYPE::STRING }, { "tls", JSON::TYPE::INT }}},
		{ .name = "console_active", .cb = console_active_func, .hints = {{ "port", JSON::TYPE::INT }}},
		{ .name = "registry_list",   .cb = registry_list_func },
		{ .name = "registry_set",    .cb = registry_set_func, .hints = {{ "registry", JSON::TYPE::STRING }, { "username", JSON::TYPE::STRING }, { "password", JSON::TYPE::STRING }}},
		{ .name = "registry_remove", .cb = registry_remove_func, .hints = {{ "registry", JSON::TYPE::STRING }}},
		{ .name = "create",  .cb = create_func, .hints = {{ "name", JSON::TYPE::STRING }, { "bundle", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "respawn", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }}},
		{ .name = "remove",  .cb = remove_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "getconfig", .cb = getconfig_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "setconfig", .cb = setconfig_func, .hints = {{ "name", JSON::TYPE::STRING }, { "config", JSON::TYPE::OBJECT }}},
		{ .name = "pull",    .cb = pull_func, .hints = {{ "image", JSON::TYPE::STRING }, { "name", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }, { "profile", JSON::TYPE::STRING }, { "dev", JSON::TYPE::BOOL }, { "out", JSON::TYPE::STRING }}},
		{ .name = "build",   .cb = build_func, .hints = {{ "dockerfile", JSON::TYPE::STRING }, { "context", JSON::TYPE::STRING }, { "name", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }, { "profile", JSON::TYPE::STRING }, { "dev", JSON::TYPE::BOOL }, { "dockerfile_content", JSON::TYPE::STRING }, { "out", JSON::TYPE::STRING }}},
		{ .name = "deploy",  .cb = deploy_func, .hints = {{ "recipe", JSON::TYPE::STRING }, { "name", JSON::TYPE::STRING }, { "autostart", JSON::TYPE::BOOL }, { "infra", JSON::TYPE::STRING }, { "out", JSON::TYPE::STRING }}},
		{ .name = "job_list",   .cb = job_list_func },
		{ .name = "job_status", .cb = job_status_func, .hints = {{ "id", JSON::TYPE::STRING }}},
		{ .name = "job_log",    .cb = job_log_func, .hints = {{ "id", JSON::TYPE::STRING }, { "lines", JSON::TYPE::INT }}},
		{ .name = "job_cancel", .cb = job_cancel_func, .hints = {{ "id", JSON::TYPE::STRING }}},
		{ .name = "images",     .cb = images_func },
		{ .name = "doctor",  .cb = doctor_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "list_profiles", .cb = list_profiles_func },
		{ .name = "list_recipes", .cb = list_recipes_func },
		{ .name = "host_devices", .cb = host_devices_func },
		{ .name = "events",     .cb = events_func, .hints = {{ "limit", JSON::TYPE::INT }}},
		{ .name = "events_clear", .cb = events_clear_func },
		{ .name = "prune",      .cb = prune_func, .hints = {{ "target", JSON::TYPE::STRING }}},
		{ .name = "check_updates", .cb = check_updates_func },
		{ .name = "upgrade",    .cb = upgrade_func, .hints = {{ "name", JSON::TYPE::STRING }, { "image", JSON::TYPE::STRING }}},
		{ .name = "rollback",   .cb = rollback_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "metrics",    .cb = metrics_func },
		{ .name = "start",   .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "stop",    .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "restart", .cb = lifecycle_func, .hints = {{ "name", JSON::TYPE::STRING }}},
		{ .name = "exec",    .dcb = exec_func, .hints = {{ "name", JSON::TYPE::STRING }, { "command", JSON::TYPE::ARRAY }, { "timeout", JSON::TYPE::INT }}},
	};
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
		srv -> add_object("uxcd", uxcd_methods());
	} catch ( const ubus::exception& e ) {
		logger::error << "uxcd: cannot register ubus object: " << e.what() << std::endl;
		delete srv;
		return 1;
	}

	// broadcast container state changes as ubus events (uxcd.container)
	uxcd::set_event_sink([](const std::string& id, const JSON& data) {
		if ( srv ) srv -> send_event(id, data);
	});

	try { uxcd::init(); }
	catch ( const std::exception& e ) {
		logger::error << "uxcd: init failed (" << e.what() << "); continuing - some containers may be unsupervised" << std::endl;
	}

	logger::info << "uxcd started, serving ubus object 'uxcd'" << std::endl;
	uloop::run();

	if ( shutdown_signum )
		logger::info << "uxcd: " << SIG::to_string((int)shutdown_signum) << " received, shutting down" << std::endl;
	delete srv;
	logger::info << "uxcd stopped" << std::endl;
	return 0;
}
