// uxc - command line control for uxcd. A drop-in-style replacement for the
// stock OpenWrt `uxc` tool: it speaks to the uxcd daemon over ubus instead of
// driving procd/ujail directly. (Package CONFLICTS:=uxc.)

#include <string>
#include <vector>
#include <fstream>
#include <iterator>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <functional>

#include <unistd.h>

#include "ubus.hpp"
#include "json.hpp"
#include "version.hpp"

static const char* UXC_DIR = "/etc/uxc/";

static void usage(void) {
	fprintf(stderr,
		"uxc " UXCD_VERSION " - control uxcd containers\n"
		"\n"
		"usage: uxc <command> [parameters ...]\n"
		"commands:\n"
		"  list [--json]                 list all containers (state, health, usage)\n"
		"  info|state <name>             full detail for one container\n"
		"  start <name>                  start (and keep up) <name>\n"
		"  stop|kill <name>              stop <name>\n"
		"  restart <name>                restart <name>\n"
		"  log <name> [-n lines]         show captured stdout/stderr\n"
		"  attach <name>                 open a shell inside <name> (via uxexec)\n"
		"  create <name> --bundle <path> [--autostart] [--infra <netns>] [--no-respawn]\n"
		"  remove|delete <name>          unregister <name>\n"
		"  enable|disable <name>         start on boot, or not\n");
}

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

static int cmd_create(int argc, char** argv) {
	// uxc create <name> --bundle <path> [--autostart] [--infra <n>] [--no-respawn]
	if ( argc < 1 ) { usage(); return 2; }
	std::string name = argv[0], bundle, infra;
	bool autostart = false, respawn = true;
	for ( int i = 1; i < argc; i++ ) {
		std::string o = argv[i];
		if ( o == "--bundle" && i + 1 < argc ) bundle = argv[++i];
		else if ( o == "--infra" && i + 1 < argc ) infra = argv[++i];
		else if ( o == "--autostart" ) autostart = true;
		else if ( o == "--no-respawn" ) respawn = false;
		else { fprintf(stderr, "uxc: unknown option '%s'\n", o.c_str()); return 2; }
	}
	if ( bundle.empty()) { fprintf(stderr, "uxc: create needs --bundle <path>\n"); return 2; }
	return with_ubus([&](ubus& u) {
		JSON a;
		a["name"] = name;
		a["bundle"] = bundle;
		if ( autostart ) a["autostart"] = true;
		if ( !respawn )  a["respawn"] = false;
		if ( !infra.empty()) a["infra"] = infra;
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
	execlp("uxexec", "uxexec", name.c_str(), (char*)nullptr);
	fprintf(stderr, "uxc: cannot exec uxexec: %s\n", strerror(errno));
	return 127;
}

int main(int argc, char** argv) {
	if ( argc < 2 ) { usage(); return 2; }
	std::string cmd = argv[1];

	if ( cmd == "list" )
		return cmd_list(argc > 2 && std::string(argv[2]) == "--json");

	if ( cmd == "help" || cmd == "-h" || cmd == "--help" ) { usage(); return 0; }
	if ( cmd == "-V" || cmd == "--version" ) { printf("uxc %s\n", UXCD_VERSION); return 0; }

	if ( cmd == "create" )
		return cmd_create(argc - 2, argv + 2);

	// the rest take a <name> as the next argument
	if ( argc < 3 ) { usage(); return 2; }
	std::string name = argv[2];

	if ( cmd == "start" )                       return lifecycle("start", name);
	if ( cmd == "stop" || cmd == "kill" )       return lifecycle("stop", name);
	if ( cmd == "restart" )                     return lifecycle("restart", name);
	if ( cmd == "remove" || cmd == "delete" )   return lifecycle("remove", name);
	if ( cmd == "info" || cmd == "state" )      return cmd_info(name);
	if ( cmd == "attach" )                      return cmd_attach(name);
	if ( cmd == "enable" )                       return cmd_autostart(name, true);
	if ( cmd == "disable" )                      return cmd_autostart(name, false);
	if ( cmd == "log" ) {
		int lines = 0;
		if ( argc >= 5 && std::string(argv[3]) == "-n" )
			lines = atoi(argv[4]);
		return cmd_log(name, lines);
	}

	fprintf(stderr, "uxc: unknown command '%s'\n", cmd.c_str());
	usage();
	return 2;
}
