// uxc - command line control for uxcd. A drop-in-style replacement for the
// stock OpenWrt `uxc` tool: it speaks to the uxcd daemon over ubus instead of
// driving procd/ujail directly. (Package CONFLICTS:=uxc.)

#include <string>
#include <vector>
#include <fstream>
#include <iterator>
#include <iostream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <csignal>
#include <functional>

#include <unistd.h>

#include "ubus.hpp"
#include "json.hpp"
#include "usage.hpp"
#include "version.hpp"

static const char* UXC_DIR = "/etc/uxc/";

static std::string human(long long b) {
	const char* u[] = { "B", "K", "M", "G", "T" };
	double v = (double)b;
	int i = 0;
	while ( v >= 1024.0 && i < 4 ) { v /= 1024.0; i++; }
	char buf[32];
	snprintf(buf, sizeof buf, i == 0 ? "%.0f%s" : "%.1f%s", v, u[i]);
	return buf;
}

// ---- ubus helpers ------------------------------------------------------------
static int with_ubus(const std::function<int(ubus&)>& fn) {
	try {
		ubus u;
		return fn(u);
	} catch ( const ubus::exception& e ) {
		fprintf(stderr, "uxc: cannot reach uxcd over ubus: %s\n", e.what());
		return 1;
	}
}

static int report(const JSON& r) {
	if ( r.contains("error")) {
		fprintf(stderr, "uxc: %s\n", r["error"].to_string().c_str());
		return 1;
	}
	return 0;
}

static int lifecycle(const std::string& method, const std::string& name) {
	return with_ubus([&](ubus& u) {
		JSON a; a["name"] = name;
		return report(u.call("uxcd", method, a));
	});
}

// ---- commands ----------------------------------------------------------------
static int cmd_list(bool as_json) {
	return with_ubus([&](ubus& u) {
		JSON r = u.call("uxcd", "list");
		if ( as_json ) { printf("%s\n", r.dump(true).c_str()); return 0; }
		printf("%-16s %-8s %-9s %-7s %-9s %s\n", "NAME", "RUNNING", "HEALTH", "PID", "MEM", "INFRA");
		for ( auto it = r.begin(); it != r.end(); ++it ) {
			std::string name = it.key();
			JSON c = *it.value();
			bool run = c.contains("running") && c["running"].to_bool();
			std::string pid = run && c.contains("pid") ? std::to_string((long long)c["pid"].to_number()) : "-";
			std::string mem = run && c.contains("memory") ? human((long long)c["memory"].to_number()) : "-";
			std::string health = c.contains("health") ? c["health"].to_string() : "-";
			std::string infra = c.contains("infra") ? c["infra"].to_string() : "-";
			printf("%-16s %-8s %-9s %-7s %-9s %s\n", name.c_str(), run ? "yes" : "no",
			       health.c_str(), pid.c_str(), mem.c_str(), infra.c_str());
		}
		return 0;
	});
}

static int cmd_info(const std::string& name) {
	return with_ubus([&](ubus& u) {
		JSON a; a["name"] = name;
		JSON r = u.call("uxcd", "info", a);
		if ( report(r)) return 1;
		printf("%s\n", r.dump(true).c_str());
		return 0;
	});
}

static int cmd_log(const std::string& name, int lines) {
	return with_ubus([&](ubus& u) {
		JSON a; a["name"] = name;
		if ( lines > 0 ) a["lines"] = lines;
		JSON r = u.call("uxcd", "log", a);
		if ( report(r)) return 1;
		if ( r.contains("lines")) {
			JSON arr = r["lines"];
			for ( auto it = arr.begin(); it != arr.end(); ++it )
				printf("%s\n", ( *it.value()).to_string().c_str());
		}
		return 0;
	});
}

static int cmd_create(const std::string& name, const std::string& bundle, bool autostart,
                      bool respawn, const std::string& infra, const std::string& ov_size,
                      const std::string& ov_path, const std::string& mounts_csv) {
	if ( name.empty()) { fprintf(stderr, "uxc: create needs a <name>\n"); return 2; }
	if ( bundle.empty()) { fprintf(stderr, "uxc: create needs --bundle <path>\n"); return 2; }
	return with_ubus([&](ubus& u) {
		JSON a;
		a["name"] = name;
		a["bundle"] = bundle;
		if ( autostart ) a["autostart"] = true;
		if ( !respawn )  a["respawn"] = false;
		if ( !infra.empty()) a["infra"] = infra;
		if ( !ov_size.empty()) a["temp_overlay_size"] = ov_size;
		if ( !ov_path.empty()) a["write_overlay_path"] = ov_path;
		if ( !mounts_csv.empty()) {
			JSON arr = JSON::Array();
			size_t p = 0;
			while ( p <= mounts_csv.size()) {
				size_t c = mounts_csv.find(',', p);
				if ( c == std::string::npos ) c = mounts_csv.size();
				std::string m = mounts_csv.substr(p, c - p);
				if ( !m.empty()) arr.append(JSON(m));
				p = c + 1;
			}
			a["mounts"] = arr;
		}
		return report(u.call("uxcd", "create", a));
	});
}

// enable/disable just flip "autostart" in the registry file; uxcd reads it on
// boot. Editing the file directly avoids a dedicated ubus method.
static int cmd_autostart(const std::string& name, bool on) {
	std::string path = std::string(UXC_DIR) + name + ".json";
	std::ifstream f(path);
	if ( !f ) { fprintf(stderr, "uxc: no such container '%s'\n", name.c_str()); return 1; }
	std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	f.close();
	JSON j;
	try { j = JSON::parse(s); } catch ( ... ) { fprintf(stderr, "uxc: bad config %s\n", path.c_str()); return 1; }
	if ( on ) j["autostart"] = true;
	else j.erase("autostart");
	std::ofstream o(path);
	if ( !o ) { fprintf(stderr, "uxc: cannot write %s\n", path.c_str()); return 1; }
	o << j.dump(true) << "\n";
	return 0;
}

static int cmd_attach(const std::string& name) {
	execlp("uxe", "uxe", name.c_str(), (char*)nullptr);
	fprintf(stderr, "uxc: cannot exec uxe: %s\n", strerror(errno));
	return 127;
}

static int signal_by_name(const std::string& s) {
	if ( s.empty()) return SIGTERM;
	if ( s[0] >= '0' && s[0] <= '9' ) return atoi(s.c_str());
	std::string n = s;
	if ( n.rfind("SIG", 0) == 0 ) n = n.substr(3);
	struct { const char* n; int s; } map[] = {
		{ "TERM", SIGTERM }, { "KILL", SIGKILL }, { "HUP", SIGHUP }, { "INT", SIGINT },
		{ "QUIT", SIGQUIT }, { "USR1", SIGUSR1 }, { "USR2", SIGUSR2 }, { "STOP", SIGSTOP },
		{ "CONT", SIGCONT }, { "ABRT", SIGABRT },
	};
	for ( auto& e : map ) if ( n == e.n ) return e.s;
	return -1;
}

// Send a signal directly to the container's init process (original uxc `kill`
// semantics). The container exits if the signal is fatal; uxcd's respawn policy
// then applies. For a managed stop that won't respawn, use `uxc stop`.
static int cmd_kill(const std::string& name, const std::string& sig) {
	int signum = signal_by_name(sig);
	if ( signum <= 0 ) { fprintf(stderr, "uxc: unknown signal '%s'\n", sig.c_str()); return 2; }
	return with_ubus([&](ubus& u) {
		JSON a; a["name"] = name;
		JSON r = u.call("uxcd", "info", a);
		if ( report(r)) return 1;
		if ( !( r.contains("running") && r["running"].to_bool()) || !r.contains("init_pid")) {
			fprintf(stderr, "uxc: container '%s' is not running\n", name.c_str());
			return 1;
		}
		pid_t pid = (pid_t)r["init_pid"].to_number();
		if ( kill(pid, signum) != 0 ) {
			fprintf(stderr, "uxc: kill %s: %s\n", name.c_str(), strerror(errno));
			return 1;
		}
		return 0;
	});
}

int main(int argc, char** argv) {

	// uxc has a subcommand model: `uxc <command> [name] [options]`. usage_cpp
	// collects the command and name into remainder() and still parses options
	// that follow them.
	usage_t usage = {
		.args = { argc, argv },
		.info = {
			.name = "uxc",
			.version = UXCD_VERSION,
			.author = "Oskari Rauta",
			.copyright = "2026, Oskari Rauta",
			.usage =
				"<command> [name] [options]\n\n"
				"commands:\n"
				"   list                       list all containers (state, health, usage)\n"
				"   info | state <name>        full detail for one container\n"
				"   start <name>               start (and keep up) <name>\n"
				"   stop <name>                stop <name> (managed; no respawn)\n"
				"   kill <name>                send a signal to <name> (default TERM)\n"
				"   restart <name>             restart <name>\n"
				"   log <name>                 show captured stdout/stderr\n"
				"   attach <name>              open a shell inside <name> (via uxexec)\n"
				"   create <name> --bundle <path> [options]\n"
				"   remove | delete <name>     unregister <name>\n"
				"   enable | disable <name>    start on boot, or not",
			.description = "\ncommand line control for the uxcd container supervisor",
		},
		.options = {
			{ "json",               { .word = "json",               .desc = "list: output raw JSON" }},
			{ "bundle",             { .word = "bundle",             .desc = "create: OCI bundle path", .flag = usage_t::REQUIRED, .name = "path" }},
			{ "autostart",          { .word = "autostart",          .desc = "create: start on boot" }},
			{ "infra",              { .word = "infra",              .desc = "create: shared netns to join", .flag = usage_t::REQUIRED, .name = "netns" }},
			{ "no-respawn",         { .word = "no-respawn",         .desc = "create: do not auto-restart" }},
			{ "temp-overlay-size",  { .word = "temp-overlay-size",  .desc = "create: tmpfs r/w overlay size", .flag = usage_t::REQUIRED, .name = "size" }},
			{ "write-overlay-path", { .word = "write-overlay-path", .desc = "create: persistent r/w overlay dir", .flag = usage_t::REQUIRED, .name = "path" }},
			{ "mounts",             { .word = "mounts",             .desc = "create: required mountpoints", .flag = usage_t::REQUIRED, .name = "m1,..." }},
			{ "console",            { .word = "console",            .desc = "start: attach a shell after starting" }},
			{ "signal",             { .word = "signal",             .desc = "kill: signal to send", .flag = usage_t::REQUIRED, .name = "sig" }},
			{ "force",              { .word = "force",              .desc = "delete: force (implied)" }},
			{ "lines",              { .key = "n", .word = "lines",  .desc = "log: number of lines", .flag = usage_t::REQUIRED, .name = "N", .type = usage_t::INT }},
			{ "help",               { .key = "h", .word = "help",   .desc = "show this help" }},
			{ "version",            { .key = "V", .word = "version",.desc = "show version" }},
		}
	};

	std::vector<std::string> rem = usage.remainder();
	std::string cmd  = rem.empty() ? "" : rem[0];
	std::string name = rem.size() > 1 ? rem[1] : "";

	// version before help, so `uxc --version` / `uxc version` is not shadowed by
	// the no-command help branch.
	if ( (bool)usage["version"] || cmd == "version" ) {
		std::cout << usage.version() << std::endl;
		return 0;
	}
	if ( (bool)usage["help"] || cmd == "help" || cmd.empty()) {
		std::cout << usage << "\n" << usage.help() << std::endl;   // header + usage/options
		return cmd.empty() && !(bool)usage["help"] ? 2 : 0;
	}

	if ( cmd == "list" )
		return cmd_list((bool)usage["json"]);

	if ( cmd == "create" )
		return cmd_create(name, usage["bundle"].value, (bool)usage["autostart"],
		                  !(bool)usage["no-respawn"], usage["infra"].value,
		                  usage["temp-overlay-size"].value, usage["write-overlay-path"].value,
		                  usage["mounts"].value);

	// everything else needs a <name>
	if ( name.empty()) { fprintf(stderr, "uxc: '%s' needs a <name>\n", cmd.c_str()); return 2; }

	if ( cmd == "start" ) {
		int rc = lifecycle("start", name);
		if ( rc == 0 && (bool)usage["console"] ) return cmd_attach(name);   // execs
		return rc;
	}
	if ( cmd == "stop" )                       return lifecycle("stop", name);
	if ( cmd == "kill" )                       return cmd_kill(name, usage["signal"].value);
	if ( cmd == "restart" )                    return lifecycle("restart", name);
	if ( cmd == "remove" || cmd == "delete" )  return lifecycle("remove", name);
	if ( cmd == "info" || cmd == "state" )     return cmd_info(name);
	if ( cmd == "attach" )                     return cmd_attach(name);
	if ( cmd == "enable" )                     return cmd_autostart(name, true);
	if ( cmd == "disable" )                    return cmd_autostart(name, false);
	if ( cmd == "log" )                        return cmd_log(name, (int)usage["lines"].intValue());

	fprintf(stderr, "uxc: unknown command '%s'\n", cmd.c_str());
	std::cout << usage.help() << std::endl;
	return 2;
}
