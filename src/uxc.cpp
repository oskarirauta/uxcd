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
#include <sys/stat.h>
#include <fcntl.h>
#include <iterator>

#include "ubus.hpp"
#include "json.hpp"
#include "usage.hpp"
#include "version.hpp"

// the docker2uxc converter, called directly instead of exec'ing it
#include "convert.hpp"
#include "http.hpp"
#include "work.hpp"
#include "compose.hpp"

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
		fprintf(stderr, "uxc: cannot reach the uxcd daemon - is it running?\n"
		                "     start it with: /etc/init.d/uxcd start   (or run: uxcd)\n"
		                "     (%s)\n", e.what());
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

static int cmd_metrics() {
	return with_ubus([&](ubus& u) {
		JSON r = u.call("uxcd", "metrics");
		if ( r.contains("metrics"))
			printf("%s", r["metrics"].to_string().c_str());
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

// Fill the converter knobs that pull and build share, from the parsed flags.
static void fill_opts(docker2uxc::Options& o, usage_t& usage, const std::string& name) {
	o.force = true;
	if ( !name.empty())              o.name = name;
	o.autostart = (bool)usage["autostart"];
	if ( (bool)usage["infra"] )      o.infra = usage["infra"].value;
	if ( (bool)usage["out"] )        o.out = usage["out"].value;
	if ( (bool)usage["profile"] )    o.profile = usage["profile"].value;
	if ( (bool)usage["arch"] )       o.arch = usage["arch"].value;
	if ( (bool)usage["caps"] )       o.caps = usage["caps"].value;
	o.privileged       = (bool)usage["privileged"];
	o.network_isolated = ( (bool)usage["network"] && usage["network"].value == "isolated" );
	o.resolvconf       = (bool)usage["resolv-conf"];
	o.accounting       = !(bool)usage["no-accounting"];
	o.rw_overlay       = (bool)usage["rw-overlay"];
	o.emit_netconfig   = (bool)usage["emit-netconfig"];
	if ( (bool)usage["net-bridge"] ) o.net_bridge = usage["net-bridge"].value;
	o.emit_keeper      = (bool)usage["emit-keeper"];
	o.verify           = !(bool)usage["no-verify"];
	{ const char* ce = getenv("DOCKER2UXC_CACHE");  if ( ce && *ce ) o.cache_dir = ce; }
	{ const char* ud = getenv("DOCKER2UXC_UXCDIR"); if ( ud && *ud ) o.uxc_dir = ud; }
}

// Run the converter in-process (one-shot CLI; a Dockerfile build's chroot is
// confined to RUN's own fork children). Returns the process exit code.
static int run_convert(docker2uxc::Options& o, const char* what) {
	http::global_init();
	work::install_signal_handlers();
	std::string err;
	bool ok = docker2uxc::convert(o, err);
	if ( !ok ) fprintf(stderr, "uxc: %s failed: %s\n", what, err.c_str());
	http::global_cleanup();
	return ok ? 0 : 1;
}

// pull <image> [name] [opts]: fetch + convert + register an image.
static int cmd_pull(usage_t& usage, const std::string& image, const std::string& name) {
	if ( image.empty()) { fprintf(stderr, "uxc: pull needs an <image>\n"); return 2; }
	docker2uxc::Options o;
	o.image = image;
	fill_opts(o, usage, name);
	return run_convert(o, "pull");
}

// build <dockerfile|dir> [name] [opts]: build from a Dockerfile (no Docker daemon).
static int cmd_build(usage_t& usage, const std::string& target, const std::string& name) {
	if ( target.empty()) { fprintf(stderr, "uxc: build needs a <dockerfile|dir>\n"); return 2; }
	std::string df = target, ctx;
	struct stat st;
	if ( stat(target.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) { df = target + "/Dockerfile"; ctx = target; }
	docker2uxc::Options o;
	o.dockerfile = df;
	if ( !ctx.empty()) o.context = ctx;
	fill_opts(o, usage, name);
	return run_convert(o, "build");
}

// Write a registry entry 0600 (it may hold env secrets), unescaping '\/' -> '/'
// to match docker2uxc-written entries + the shipped examples.
static bool write_registry(const std::string& path, JSON j, std::string& err) {
	std::string data = j.dump(true);
	for ( std::string::size_type p = 0; ( p = data.find("\\/", p)) != std::string::npos; ) data.replace(p, 2, "/");
	data += "\n";
	int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if ( fd < 0 ) { err = "cannot write " + path; return false; }
	bool ok = ( write(fd, data.data(), data.size()) == (ssize_t)data.size());
	close(fd);
	if ( !ok ) { err = "write failed for " + path; return false; }
	return true;
}

// Merge the compose-derived overrides into the registry entry convert() just
// wrote for this service.
static bool merge_overrides(const std::string& uxc_dir, const compose::Service& s,
                            const std::string& infra, std::string& err) {
	std::string path = uxc_dir + "/" + s.name + ".json";
	JSON j = JSON::Object();
	{
		std::ifstream f(path);
		if ( f ) {
			std::string c(( std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
			try { JSON e = JSON::parse(c); if ( e.type() == JSON::TYPE::OBJECT ) j = e; } catch ( ... ) {}
		}
	}
	auto setarr = [&](const char* k, const std::vector<std::string>& v) {
		if ( v.empty()) return;
		JSON a = JSON::Array(); for ( const auto& e : v ) a.append(JSON(e)); j[k] = a;
	};
	if ( !s.host_network && !infra.empty()) j["infra"] = infra;
	setarr("volumes", s.volumes); setarr("env", s.env); setarr("devices", s.devices);
	setarr("depends_on", s.depends_on); setarr("cap_add", s.cap_add); setarr("cap_drop", s.cap_drop);
	if ( !s.respawn ) j["respawn"] = false;
	return write_registry(path, j, err);
}

// Pull/build each service in the plan then register it with the (compose/run-)
// derived overrides merged in. --dry-run only prints the plan. Nothing is started.
static int apply_plan(const compose::Plan& plan, bool dry_run) {
	if ( dry_run ) { fputs(compose::preview(plan).c_str(), stdout); return 0; }

	for ( const auto& w : plan.warnings ) fprintf(stderr, "uxc: %s\n", w.c_str());

	std::string uxc_dir = "/etc/uxc";
	{ const char* ud = getenv("DOCKER2UXC_UXCDIR"); if ( ud && *ud ) uxc_dir = ud; }

	http::global_init();
	work::install_signal_handlers();
	int rc = 0, done = 0;
	for ( const compose::Service& s : plan.services ) {
		docker2uxc::Options o;
		o.name = s.name; o.force = true; o.uxc_dir = uxc_dir;
		if ( !s.host_network && !plan.infra.empty()) o.infra = plan.infra;
		if ( !s.image.empty()) o.image = s.image;
		else { o.dockerfile = s.dockerfile; o.context = s.build_context; }
		{ const char* ce = getenv("DOCKER2UXC_CACHE"); if ( ce && *ce ) o.cache_dir = ce; }
		fprintf(stderr, "uxc: %s %s ...\n", s.image.empty() ? "building" : "pulling", s.name.c_str());
		std::string cerr;
		if ( !docker2uxc::convert(o, cerr)) { fprintf(stderr, "uxc: %s failed: %s\n", s.name.c_str(), cerr.c_str()); rc = 1; continue; }
		if ( !merge_overrides(uxc_dir, s, plan.infra, cerr)) { fprintf(stderr, "uxc: %s overrides: %s\n", s.name.c_str(), cerr.c_str()); rc = 1; continue; }
		fprintf(stderr, "uxc: registered %s\n", s.name.c_str());
		done++;
	}
	http::global_cleanup();
	fprintf(stderr, "uxc: %d/%zu container(s) registered (none started).\n", done, plan.services.size());
	if ( done && !plan.infra.empty())
		fprintf(stderr, "  define the '%s' netns in /etc/config/network (see examples/), then `uxc start <name>`.\n", plan.infra.c_str());
	else if ( done )
		for ( const compose::Service& s : plan.services ) fprintf(stderr, "    uxc start %s\n", s.name.c_str());
	return rc;
}

// compose <docker-compose.yml> [--dry-run] [--infra <netns>]: import a compose file
// into uxcd containers sharing one infra netns (review, define netns, then start).
static int cmd_compose(usage_t& usage, const std::string& file) {
	if ( file.empty()) { fprintf(stderr, "uxc: compose needs a <docker-compose.yml>\n"); return 2; }
	compose::Plan plan;
	std::string err;
	if ( !compose::parse(file, (bool)usage["infra"] ? usage["infra"].value : std::string(), plan, err)) {
		fprintf(stderr, "uxc: compose: %s\n", err.c_str());
		return 1;
	}
	return apply_plan(plan, (bool)usage["dry-run"]);
}

// import uxc <stock.json> [name]: adopt a stock OpenWrt `uxc` container definition.
// Stock uxc shares /etc/uxc + the name/path/autostart keys with us; this normalises
// the keys that differ - `volumes` (stock's required-mounts list) -> `mounts`,
// `temp-overlay-size`/`write-overlay-path` -> `temp_overlay_size`/`write_overlay_path`.
// `jail`/`pidfile` are dropped (uxcd tracks the pid itself and uses <name> as the
// jail name). Nothing is pulled - the bundle at `path` already exists.
static int cmd_import_uxc(const std::string& file, const std::string& name_override, bool dry_run) {
	std::ifstream f(file);
	if ( !f ) { fprintf(stderr, "uxc: import uxc: cannot read %s\n", file.c_str()); return 1; }
	std::string c(( std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	JSON src;
	try { src = JSON::parse(c); } catch ( ... ) { fprintf(stderr, "uxc: import uxc: %s is not valid JSON\n", file.c_str()); return 1; }
	if ( src.type() != JSON::TYPE::OBJECT ) { fprintf(stderr, "uxc: import uxc: %s is not a stock uxc definition (expected a JSON object)\n", file.c_str()); return 1; }

	std::string name = name_override;
	if ( name.empty() && src.contains("name")) name = src["name"].to_string();
	if ( name.empty()) {                                    // fall back to the filename stem
		std::string b = file;
		std::string::size_type sl = b.find_last_of('/'); if ( sl != std::string::npos ) b = b.substr(sl + 1);
		if ( b.size() > 5 && b.compare(b.size() - 5, 5, ".json") == 0 ) b = b.substr(0, b.size() - 5);
		name = b;
	}
	if ( name.empty()) { fprintf(stderr, "uxc: import uxc: no container name (pass one: import uxc <file> <name>)\n"); return 2; }
	if ( !src.contains("path") || src["path"].to_string().empty()) {
		fprintf(stderr, "uxc: import uxc: %s has no \"path\" - not a stock uxc definition?\n", file.c_str()); return 1; }
	std::string path = src["path"].to_string();

	std::vector<std::string> warn;
	static const char* known[] = { "name", "path", "autostart", "jail", "pidfile", "temp-overlay-size", "write-overlay-path", "volumes" };
	for ( auto it = src.begin(); it != src.end(); ++it ) {
		std::string k = it.key();
		bool ok = false; for ( const char* kk : known ) if ( k == kk ) { ok = true; break; }
		if ( !ok ) warn.push_back("unknown stock key '" + k + "' ignored");
	}
	if ( src.contains("jail")) { std::string jn = src["jail"].to_string(); if ( !jn.empty() && jn != name ) warn.push_back("stock 'jail' name '" + jn + "' dropped (uxcd uses '" + name + "' as the jail name)"); }
	if ( src.contains("pidfile")) warn.push_back("stock 'pidfile' dropped (uxcd tracks the init pid itself)");
	{ struct stat st; if ( stat(path.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) warn.push_back("bundle path '" + path + "' does not exist - fix it before `uxc start`"); }

	std::string uxc_dir = "/etc/uxc";
	{ const char* ud = getenv("DOCKER2UXC_UXCDIR"); if ( ud && *ud ) uxc_dir = ud; }
	std::string target = uxc_dir + "/" + name + ".json";

	JSON j = JSON::Object();                                // merge onto an existing entry so uxcd-only fields survive
	{
		std::ifstream e(target);
		if ( e ) { std::string ec(( std::istreambuf_iterator<char>(e)), std::istreambuf_iterator<char>());
			try { JSON ex = JSON::parse(ec); if ( ex.type() == JSON::TYPE::OBJECT ) j = ex; } catch ( ... ) {} }
	}
	j["name"] = name;
	j["path"] = path;
	if ( src.contains("autostart")) j["autostart"] = src["autostart"].to_bool();
	if ( src.contains("temp-overlay-size"))  j["temp_overlay_size"]  = src["temp-overlay-size"].to_string();
	if ( src.contains("write-overlay-path")) j["write_overlay_path"] = src["write-overlay-path"].to_string();
	if ( src.contains("volumes") && src["volumes"].type() == JSON::TYPE::ARRAY ) j["mounts"] = src["volumes"];  // stock volumes == required mounts

	if ( dry_run ) {
		printf("# import plan: stock uxc container '%s' -> %s\n", name.c_str(), target.c_str());
		for ( const auto& w : warn ) printf("# WARNING: %s\n", w.c_str());
		std::string data = j.dump(true);
		for ( std::string::size_type p = 0; ( p = data.find("\\/", p)) != std::string::npos; ) data.replace(p, 2, "/");
		fputs(data.c_str(), stdout); fputc('\n', stdout);
		return 0;
	}
	for ( const auto& w : warn ) fprintf(stderr, "uxc: import uxc: %s\n", w.c_str());
	std::string err;
	if ( !write_registry(target, j, err)) { fprintf(stderr, "uxc: import uxc: %s\n", err.c_str()); return 1; }
	fprintf(stderr, "uxc: import uxc: registered %s -> %s (nothing started)\n", name.c_str(), path.c_str());
	fprintf(stderr, "    uxc start %s\n", name.c_str());
	return 0;
}

// import [docker run] <flags...> <image> [cmd]: translate a `docker run` line into
// one uxcd container. `import` is a raw-passthrough subcommand (usage_cpp leaves
// its arguments unparsed in tail(), since docker's flags collide with uxc's own
// option set). `import uxc <file>` instead adopts a stock uxc definition.
static int cmd_import(const std::vector<std::string>& tail) {
	std::vector<std::string> raw;
	bool dry = false;
	for ( const auto& a : tail ) {
		if ( a == "--dry-run" ) { dry = true; continue; }   // uxc-level, not a docker flag
		raw.push_back(a);
	}
	if ( raw.empty()) { fprintf(stderr, "uxc: import needs a `docker run ...` line, or `uxc <file.json>`\n"); return 2; }

	if ( raw[0] == "uxc" ) {                                // adopt a stock OpenWrt uxc definition
		if ( raw.size() < 2 ) { fprintf(stderr, "uxc: import uxc needs a <stock-uxc.json> file\n"); return 2; }
		return cmd_import_uxc(raw[1], raw.size() > 2 ? raw[2] : std::string(), dry);
	}

	compose::Plan plan;
	std::string err;
	if ( !compose::parse_run(raw, std::string(), plan, err)) { fprintf(stderr, "uxc: import: %s\n", err.c_str()); return 1; }
	return apply_plan(plan, dry);
}

// rollback <name>: swap the container's bundle with its <bundle>.prev backup
// (kept by docker2uxcd on update) and restart. Rolling back again rolls forward.
static int cmd_rollback(const std::string& name) {
	std::string cfgpath = std::string(UXC_DIR) + name + ".json";
	std::ifstream f(cfgpath);
	if ( !f ) { fprintf(stderr, "uxc: no such container '%s'\n", name.c_str()); return 1; }
	std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	f.close();
	JSON j;
	try { j = JSON::parse(s); } catch ( ... ) { fprintf(stderr, "uxc: bad config %s\n", cfgpath.c_str()); return 1; }
	if ( !j.contains("path")) { fprintf(stderr, "uxc: '%s' has no bundle path\n", name.c_str()); return 1; }

	std::string p = j["path"].to_string();
	std::string prev = p + ".prev";
	struct stat st;
	if ( stat(prev.c_str(), &st) != 0 ) {
		fprintf(stderr, "uxc: no previous bundle to roll back to (%s)\n", prev.c_str());
		return 1;
	}
	std::string tmp = p + ".rollback-tmp";
	if ( rename(p.c_str(), tmp.c_str()) != 0 ||
	     rename(prev.c_str(), p.c_str()) != 0 ||
	     rename(tmp.c_str(), prev.c_str()) != 0 ) {
		fprintf(stderr, "uxc: rollback swap failed: %s\n", strerror(errno));
		return 1;
	}
	printf("uxc: rolled '%s' back to its previous bundle; restarting\n", name.c_str());
	return lifecycle("restart", name);
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

// The option set shared by `pull` and `build` (their own subcommand usage_t's).
static std::vector<std::pair<std::string, usage_t::option_t>> convert_opts() {
	return {
		{ "autostart",      { .word = "autostart",      .desc = "register as start-on-boot" }},
		{ "infra",          { .word = "infra",          .desc = "shared netns to join", .flag = usage_t::REQUIRED, .name = "netns" }},
		{ "out",            { .word = "out",            .desc = "bundle output directory", .flag = usage_t::REQUIRED, .name = "dir" }},
		{ "profile",        { .word = "profile",        .desc = "apply profiles/<name>.json overlay", .flag = usage_t::REQUIRED, .name = "name" }},
		{ "arch",           { .word = "arch",           .desc = "target architecture", .flag = usage_t::REQUIRED, .name = "arch" }},
		{ "caps",           { .word = "caps",           .desc = "permissive | minimal", .flag = usage_t::REQUIRED, .name = "set" }},
		{ "network",        { .word = "network",        .desc = "host | isolated", .flag = usage_t::REQUIRED, .name = "mode" }},
		{ "privileged",     { .word = "privileged",     .desc = "noNewPrivileges = false" }},
		{ "resolv-conf",    { .word = "resolv-conf",    .desc = "bind host /etc/resolv.conf" }},
		{ "no-accounting",  { .word = "no-accounting",  .desc = "omit memory+pids accounting" }},
		{ "rw-overlay",     { .word = "rw-overlay",     .desc = "tune for a writable overlay" }},
		{ "emit-netconfig", { .word = "emit-netconfig", .desc = "write a network.uci snippet" }},
		{ "net-bridge",     { .word = "net-bridge",     .desc = "bridge for --emit-netconfig", .flag = usage_t::REQUIRED, .name = "br" }},
		{ "emit-keeper",    { .word = "emit-keeper",    .desc = "write a <name>.init keeper service" }},
		{ "no-verify",      { .word = "no-verify",      .desc = "skip blob sha256 verification" }},
		{ "help",           { .key = "h", .word = "help", .desc = "show this command's help" }},
	};
}

// Helper to wrap a command's options in a heap usage_t (owned by `commands`).
static std::shared_ptr<usage_t> cmd_usage(const std::string& use, const std::string& desc,
                                          std::vector<std::pair<std::string, usage_t::option_t>> opts) {
	return std::make_shared<usage_t>(usage_t{
		.info = { .name = "uxc", .usage = use, .description = desc },
		.options = std::move(opts),
	});
}

int main(int argc, char** argv) {

	// uxc has a subcommand model: each command gets its OWN option set via a
	// nested usage_t (usage_cpp `commands`). `import` is a raw passthrough -
	// its docker-run flags are left unparsed and read from tail().
	usage_t usage = {
		.args = { argc, argv },
		.info = {
			.name = "uxc",
			.version_title = "version ",
			.version = UXCD_VERSION,
			.copyright = "2026, Oskari Rauta",
			.usage =
				"<command> [args] [options]    (try: uxc <command> --help)\n\n"
				"commands:\n"
				"   list                       list all containers (state, health, usage)\n"
				"   metrics                    print Prometheus metrics (for scraping)\n"
				"   info | state <name>        full detail for one container\n"
				"   start <name>               start (and keep up) <name>\n"
				"   stop <name>                stop <name> (managed; no respawn)\n"
				"   kill <name>                send a signal to <name> (default TERM)\n"
				"   restart <name>             restart <name>\n"
				"   log <name>                 show captured stdout/stderr\n"
				"   attach <name>              open a shell inside <name> (via uxexec)\n"
				"   create <name> --bundle <path> [options]\n"
				"   pull <image> [name] [opts]   fetch+convert+register an image (--profile, ...)\n"
				"   build <dockerfile|dir> [name] [opts]  build from a Dockerfile, no Docker\n"
				"   compose <docker-compose.yml> [--dry-run]  import services into one netns\n"
				"   import <docker run ...> [--dry-run]   translate a docker run line into a container\n"
				"   import uxc <file.json> [name] [--dry-run]  adopt a stock OpenWrt uxc definition\n"
				"   rollback <name>            revert <name> to its previous bundle + restart\n"
				"   remove | delete <name>     unregister <name>\n"
				"   enable | disable <name>    start on boot, or not",
			.description = "\ncommand line control for the uxcd container supervisor",
		},
		.options = {
			{ "help",    { .key = "h", .word = "help",    .desc = "show this help" }},
			{ "version", { .key = "V", .word = "version", .desc = "show version" }},
		},
		.commands = {
			{ "list",    cmd_usage("[--json]", "\nlist all containers\n", {
				{ "json", { .word = "json", .desc = "output raw JSON" }},
				{ "help", { .key = "h", .word = "help", .desc = "show this command's help" }} }) },
			{ "metrics", nullptr },
			{ "info",    nullptr },
			{ "state",   nullptr },
			{ "start",   cmd_usage("<name> [--console]", "\nstart (and keep up) a container\n", {
				{ "console", { .word = "console", .desc = "attach a shell after starting" }},
				{ "help",    { .key = "h", .word = "help", .desc = "show this command's help" }} }) },
			{ "stop",    nullptr },
			{ "kill",    cmd_usage("<name> [--signal SIG]", "\nsend a signal to a container's init\n", {
				{ "signal", { .word = "signal", .desc = "signal to send (default TERM)", .flag = usage_t::REQUIRED, .name = "sig" }},
				{ "help",   { .key = "h", .word = "help", .desc = "show this command's help" }} }) },
			{ "restart", nullptr },
			{ "log",     cmd_usage("<name> [-n N]", "\nshow a container's captured stdout/stderr\n", {
				{ "lines", { .key = "n", .word = "lines", .desc = "number of lines", .flag = usage_t::REQUIRED, .name = "N", .type = usage_t::INT }},
				{ "help",  { .key = "h", .word = "help", .desc = "show this command's help" }} }) },
			{ "attach",  nullptr },
			{ "create",  cmd_usage("<name> --bundle <path> [options]", "\nregister an existing OCI bundle\n", {
				{ "bundle",             { .word = "bundle",             .desc = "OCI bundle path", .flag = usage_t::REQUIRED, .name = "path" }},
				{ "autostart",          { .word = "autostart",          .desc = "start on boot" }},
				{ "infra",              { .word = "infra",              .desc = "shared netns to join", .flag = usage_t::REQUIRED, .name = "netns" }},
				{ "no-respawn",         { .word = "no-respawn",         .desc = "do not auto-restart" }},
				{ "temp-overlay-size",  { .word = "temp-overlay-size",  .desc = "tmpfs r/w overlay size", .flag = usage_t::REQUIRED, .name = "size" }},
				{ "write-overlay-path", { .word = "write-overlay-path", .desc = "persistent r/w overlay dir", .flag = usage_t::REQUIRED, .name = "path" }},
				{ "mounts",             { .word = "mounts",             .desc = "required mountpoints", .flag = usage_t::REQUIRED, .name = "m1,..." }},
				{ "help",               { .key = "h", .word = "help",   .desc = "show this command's help" }} }) },
			{ "pull",    cmd_usage("<image> [name] [options]", "\nfetch + convert + register an image\n", convert_opts()) },
			{ "build",   cmd_usage("<dockerfile|dir> [name] [options]", "\nbuild from a Dockerfile (no Docker daemon)\n", convert_opts()) },
			{ "compose", cmd_usage("<docker-compose.yml> [--dry-run] [--infra netns]", "\nimport a compose file into one infra netns\n", {
				{ "dry-run", { .word = "dry-run", .desc = "print the plan, do not pull/register" }},
				{ "infra",   { .word = "infra",   .desc = "shared netns name", .flag = usage_t::REQUIRED, .name = "netns" }},
				{ "help",    { .key = "h", .word = "help", .desc = "show this command's help" }} }) },
			{ "import",  nullptr },   // raw passthrough: docker-run flags / `uxc <file>`
			{ "rollback", nullptr },
			{ "remove",  nullptr },
			{ "delete",  nullptr },
			{ "enable",  nullptr },
			{ "disable", nullptr },
		}
	};

	std::string cmd  = usage.subcommand();
	usage_t* sub     = usage.sub();                          // nullptr for raw / no command
	std::vector<std::string> rem = usage.remainder();        // non-command positionals (help/version/unknown)
	std::vector<std::string> pos = sub ? sub->remainder() : usage.tail();   // the command's own positionals
	std::string name = pos.empty() ? "" : pos[0];

	// version & help: their words are positionals (not commands), so check both
	// the global flag and rem[0]. A bare `uxc` prints help with exit 2.
	if ( (bool)usage["version"] || ( !rem.empty() && rem[0] == "version" )) {
		std::cout << usage.version() << std::endl;
		return 0;
	}
	if ( (bool)usage["help"] || ( !rem.empty() && rem[0] == "help" ) || ( cmd.empty() && rem.empty())) {
		std::cout << usage << "\n" << usage.help() << std::endl;
		return ( cmd.empty() && rem.empty() && !(bool)usage["help"] ) ? 2 : 0;
	}
	if ( cmd.empty()) {   // a positional that is not a known command
		fprintf(stderr, "uxc: unknown command '%s'\n", rem[0].c_str());
		std::cout << usage.help() << std::endl;
		return 2;
	}

	// per-command help: `uxc <command> --help` (help() prepends the command name)
	if ( sub && (bool)(*sub)["help"] ) {
		std::cout << sub->help() << std::endl;
		return 0;
	}

	// commands that do not need a <name>
	if ( cmd == "list" )     return cmd_list((bool)(*sub)["json"]);
	if ( cmd == "metrics" )  return cmd_metrics();
	if ( cmd == "create" )   return cmd_create(name, (*sub)["bundle"].value, (bool)(*sub)["autostart"],
	                                            !(bool)(*sub)["no-respawn"], (*sub)["infra"].value,
	                                            (*sub)["temp-overlay-size"].value, (*sub)["write-overlay-path"].value,
	                                            (*sub)["mounts"].value);
	if ( cmd == "pull" )     return cmd_pull(*sub, name, pos.size() > 1 ? pos[1] : "");
	if ( cmd == "build" )    return cmd_build(*sub, name, pos.size() > 1 ? pos[1] : "");
	if ( cmd == "compose" )  return cmd_compose(*sub, name);
	if ( cmd == "import" )   return cmd_import(usage.tail());

	// everything else needs a <name>
	if ( name.empty()) { fprintf(stderr, "uxc: '%s' needs a <name>\n", cmd.c_str()); return 2; }

	if ( cmd == "start" ) {
		int rc = lifecycle("start", name);
		if ( rc == 0 && (bool)(*sub)["console"] ) return cmd_attach(name);   // execs
		return rc;
	}
	if ( cmd == "stop" )                       return lifecycle("stop", name);
	if ( cmd == "kill" )                       return cmd_kill(name, (*sub)["signal"].value);
	if ( cmd == "restart" )                    return lifecycle("restart", name);
	if ( cmd == "rollback" )                   return cmd_rollback(name);
	if ( cmd == "remove" || cmd == "delete" )  return lifecycle("remove", name);
	if ( cmd == "info" || cmd == "state" )     return cmd_info(name);
	if ( cmd == "attach" )                     return cmd_attach(name);
	if ( cmd == "enable" )                     return cmd_autostart(name, true);
	if ( cmd == "disable" )                    return cmd_autostart(name, false);
	if ( cmd == "log" )                        return cmd_log(name, (int)(*sub)["lines"].intValue());

	fprintf(stderr, "uxc: unknown command '%s'\n", cmd.c_str());   // unreachable
	return 2;
}
