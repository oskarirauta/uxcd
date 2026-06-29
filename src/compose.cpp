#include "compose.hpp"
#include "json.hpp"

#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <cstdlib>

namespace compose {
namespace {

// ---- a minimal block-YAML reader (the compose subset) -----------------------
// Supports: block maps (key: value / key:), block sequences of scalars (- x),
// nesting by indentation, '#' comments, and '/" quoted scalars. NOT supported
// (warned + skipped): flow style {..}/[..], anchors/aliases, multi-line scalars,
// and long-form list items (- key: ...). Good enough for real compose files.

struct Node {
	int kind = 0;   // 0 scalar, 1 map, 2 seq
	std::string scalar;
	std::vector<std::pair<std::string, Node>> map;
	std::vector<Node> seq;
	const Node* find(const std::string& k) const {
		for ( const auto& p : map ) if ( p.first == k ) return &p.second;
		return nullptr;
	}
};

struct Line { int indent; std::string text; };

std::string trim(const std::string& s) {
	std::string::size_type a = s.find_first_not_of(" \t");
	if ( a == std::string::npos ) return "";
	std::string::size_type b = s.find_last_not_of(" \t");
	return s.substr(a, b - a + 1);
}

std::string unquote(const std::string& in) {
	std::string s = trim(in);
	if ( s.size() >= 2 && (( s.front() == '"' && s.back() == '"' ) || ( s.front() == '\'' && s.back() == '\'' ))) {
		char q = s.front();
		std::string b = s.substr(1, s.size() - 2);
		if ( q == '"' ) {
			std::string o;
			for ( std::string::size_type i = 0; i < b.size(); i++ ) {
				if ( b[i] == '\\' && i + 1 < b.size()) { char n = b[++i]; o += ( n == 'n' ? '\n' : n == 't' ? '\t' : n ); }
				else o += b[i];
			}
			return o;
		}
		return b;
	}
	return s;
}

// drop a '#' comment that is at line start or preceded by space, honoring quotes
std::string strip_comment(const std::string& s) {
	bool sq = false, dq = false;
	for ( std::string::size_type i = 0; i < s.size(); i++ ) {
		char c = s[i];
		if ( c == '\'' && !dq ) sq = !sq;
		else if ( c == '"' && !sq ) dq = !dq;
		else if ( c == '#' && !sq && !dq && ( i == 0 || s[i-1] == ' ' || s[i-1] == '\t' )) return s.substr(0, i);
	}
	return s;
}

// index of the ':' separating a map key from its value (followed by space or EOL,
// outside quotes), or npos
std::string::size_type key_colon(const std::string& t) {
	bool sq = false, dq = false;
	for ( std::string::size_type i = 0; i < t.size(); i++ ) {
		char c = t[i];
		if ( c == '\'' && !dq ) sq = !sq;
		else if ( c == '"' && !sq ) dq = !dq;
		else if ( c == ':' && !sq && !dq && ( i + 1 == t.size() || t[i+1] == ' ' )) return i;
	}
	return std::string::npos;
}

bool is_seq_item(const std::string& t) { return !t.empty() && t[0] == '-' && ( t.size() == 1 || t[1] == ' ' ); }

bool load_lines(const std::string& path, std::vector<Line>& out, std::string& err) {
	std::ifstream f(path);
	if ( !f ) { err = "cannot read " + path; return false; }
	std::string raw;
	while ( std::getline(f, raw)) {
		if ( !raw.empty() && raw.back() == '\r' ) raw.pop_back();
		int ind = 0; std::string::size_type i = 0;
		while ( i < raw.size() && ( raw[i] == ' ' || raw[i] == '\t' )) {
			if ( raw[i] == '\t' ) { err = "tab used in indentation (compose must use spaces)"; return false; }
			ind++; i++;
		}
		std::string content = trim(strip_comment(raw.substr(i)));
		if ( content.empty() || content == "---" || content == "..." ) continue;
		out.push_back({ ind, content });
	}
	return true;
}

Node parse_block(const std::vector<Line>& L, std::vector<Line>::size_type& pos, int min_indent, std::vector<std::string>& warn) {
	Node n;
	if ( pos >= L.size() || L[pos].indent < min_indent ) return n;   // empty
	int cur = L[pos].indent;

	if ( is_seq_item(L[pos].text)) {
		n.kind = 2;
		while ( pos < L.size() && L[pos].indent == cur && is_seq_item(L[pos].text)) {
			std::string rest = L[pos].text.size() > 1 ? trim(L[pos].text.substr(1)) : "";
			if ( rest.empty()) { pos++; n.seq.push_back(parse_block(L, pos, cur + 1, warn)); }
			else if ( key_colon(rest) != std::string::npos ) { warn.push_back("long-form list item not supported, skipped: - " + rest); pos++; }
			else { Node s; s.kind = 0; s.scalar = unquote(rest); n.seq.push_back(s); pos++; }
		}
	} else {
		n.kind = 1;
		while ( pos < L.size() && L[pos].indent == cur && !is_seq_item(L[pos].text)) {
			const std::string& t = L[pos].text;
			std::string::size_type c = key_colon(t);
			if ( c == std::string::npos ) { warn.push_back("skipped unparseable line: " + t); pos++; continue; }
			std::string key = unquote(t.substr(0, c));
			std::string val = ( c + 1 < t.size()) ? trim(t.substr(c + 1)) : "";
			pos++;
			if ( !val.empty()) { Node s; s.kind = 0; s.scalar = unquote(val); n.map.push_back({ key, s }); }
			else n.map.push_back({ key, parse_block(L, pos, cur + 1, warn) });
		}
	}
	return n;
}

// ---- compose -> uxcd translation helpers ------------------------------------

std::string dirname_of(const std::string& p) {
	std::string::size_type s = p.find_last_of('/');
	return ( s == std::string::npos ) ? "." : ( s == 0 ? "/" : p.substr(0, s) );
}
std::string basename_of(const std::string& p) {
	std::string q = p;
	while ( q.size() > 1 && q.back() == '/' ) q.pop_back();
	std::string::size_type s = q.find_last_of('/');
	return ( s == std::string::npos ) ? q : q.substr(s + 1);
}

std::vector<std::string> scalars(const Node* n) {
	std::vector<std::string> v;
	if ( n && n->kind == 2 ) for ( const auto& e : n->seq ) if ( e.kind == 0 ) v.push_back(e.scalar);
	return v;
}

// environment: a list (KEY=VAL) or a map (KEY: VAL) -> ["KEY=VAL", ...]
std::vector<std::string> env_of(const Node* n) {
	std::vector<std::string> v;
	if ( !n ) return v;
	if ( n->kind == 2 ) for ( const auto& e : n->seq ) { if ( e.kind == 0 ) v.push_back(e.scalar); }
	else if ( n->kind == 1 ) for ( const auto& p : n->map ) v.push_back(p.first + "=" + ( p.second.kind == 0 ? p.second.scalar : std::string()));
	return v;
}

// depends_on: a list of names, or a map whose keys are the names
std::vector<std::string> deps_of(const Node* n) {
	std::vector<std::string> v;
	if ( !n ) return v;
	if ( n->kind == 2 ) return scalars(n);
	if ( n->kind == 1 ) for ( const auto& p : n->map ) v.push_back(p.first);
	return v;
}

std::string cap_norm(const std::string& c) {   // compose "NET_ADMIN" -> "CAP_NET_ADMIN"
	if ( c == "ALL" || c.compare(0, 4, "CAP_") == 0 ) return c;
	return "CAP_" + c;
}

} // anonymous namespace

bool parse(const std::string& compose_path, const std::string& infra_override, Plan& out, std::string& err) {
	std::vector<Line> L;
	if ( !load_lines(compose_path, L, err)) return false;
	std::vector<Line>::size_type pos = 0;
	Node root = parse_block(L, pos, 0, out.warnings);
	if ( root.kind != 1 ) { err = "not a compose mapping (no top-level keys)"; return false; }

	const Node* services = root.find("services");
	if ( !services || services->kind != 1 || services->map.empty()) { err = "no 'services:' in " + compose_path; return false; }

	std::string dir = dirname_of(compose_path);
	out.project = basename_of(dir);
	if ( out.project.empty() || out.project == "." ) out.project = "compose";

	bool any_netns = false;
	for ( const auto& sv : services->map ) {
		const std::string& key = sv.first;
		const Node& s = sv.second;
		if ( s.kind != 1 ) { out.warnings.push_back("service '" + key + "' is not a mapping, skipped"); continue; }

		Service svc;
		const Node* cn = s.find("container_name");
		svc.name = ( cn && cn->kind == 0 && !cn->scalar.empty()) ? cn->scalar : key;

		const Node* img = s.find("image");
		if ( img && img->kind == 0 ) svc.image = img->scalar;
		const Node* bld = s.find("build");
		if ( bld ) {
			std::string ctx;
			if ( bld->kind == 0 ) ctx = bld->scalar;
			else if ( bld->kind == 1 ) {
				const Node* c = bld->find("context"); if ( c && c->kind == 0 ) ctx = c->scalar;
				const Node* d = bld->find("dockerfile"); if ( d && d->kind == 0 ) svc.dockerfile = d->scalar;
			}
			if ( !ctx.empty()) {
				if ( ctx[0] != '/' ) ctx = dir + "/" + ctx;     // relative to the compose file
				svc.build_context = ctx;
				if ( svc.dockerfile.empty()) svc.dockerfile = ctx + "/Dockerfile";
				else if ( svc.dockerfile[0] != '/' ) svc.dockerfile = ctx + "/" + svc.dockerfile;
			}
		}
		if ( svc.image.empty() && svc.build_context.empty()) {
			out.warnings.push_back("service '" + key + "' has neither image nor build, skipped");
			continue;
		}

		// volumes: src:dst[:ro]; resolve ./relative, map named volumes to /srv/<project>/<name>
		for ( const std::string& v : scalars(s.find("volumes"))) {
			std::string::size_type c1 = v.find(':');
			if ( c1 == std::string::npos ) { out.warnings.push_back("anonymous volume '" + v + "' on " + svc.name + " skipped (give it a host path)"); continue; }
			std::string host = v.substr(0, c1), rest = v.substr(c1);   // rest keeps ":dst[:ro]"
			if ( host.empty()) { out.warnings.push_back("volume '" + v + "' on " + svc.name + " skipped"); continue; }
			if ( host[0] == '/' ) { /* absolute host bind */ }
			else if ( host[0] == '.' || host[0] == '~' ) host = ( host[0] == '.' ? dir + "/" + host : host );   // ./rel -> compose dir
			else { std::string np = "/srv/" + out.project + "/" + host;   // named volume
			       out.warnings.push_back("named volume '" + host + "' on " + svc.name + " mapped to " + np); host = np; }
			svc.volumes.push_back(host + rest);
		}

		svc.env = env_of(s.find("environment"));
		for ( const std::string& d : scalars(s.find("devices"))) {
			std::string::size_type c = d.find(':');           // host[:container]
			svc.devices.push_back(c == std::string::npos ? d : d.substr(0, c));
		}
		svc.depends_on = deps_of(s.find("depends_on"));
		for ( const std::string& c : scalars(s.find("cap_add"))) svc.cap_add.push_back(cap_norm(c));
		for ( const std::string& c : scalars(s.find("cap_drop"))) svc.cap_drop.push_back(cap_norm(c));
		svc.ports = scalars(s.find("ports"));
		if ( !svc.ports.empty()) out.warnings.push_back("service '" + svc.name + "' ports are NOT published (uxcd does no port mapping); reach it in the netns over 127.0.0.1, expose it via your firewall");

		const Node* nm = s.find("network_mode");
		if ( nm && nm->kind == 0 && nm->scalar == "host" ) svc.host_network = true;
		else any_netns = true;

		const Node* rs = s.find("restart");
		if ( rs && rs->kind == 0 && ( rs->scalar == "no" || rs->scalar.empty())) svc.respawn = false;

		out.services.push_back(std::move(svc));
	}

	if ( out.services.empty()) { err = "no usable services in " + compose_path; return false; }
	out.infra = any_netns ? ( infra_override.empty() ? out.project : infra_override ) : "";
	return true;
}

std::string preview(const Plan& plan) {
	std::ostringstream os;
	os << "# compose import plan: project '" << plan.project << "'";
	if ( !plan.infra.empty()) os << ", shared netns '" << plan.infra << "'";
	os << "\n# " << plan.services.size() << " service(s). Each becomes /etc/uxc/<name>.json after the image is pulled/built.\n";
	for ( const auto& w : plan.warnings ) os << "# WARNING: " << w << "\n";

	for ( const Service& s : plan.services ) {
		JSON j = JSON::Object();
		j["name"] = s.name;
		if ( !s.image.empty()) j["_image"] = s.image;
		if ( !s.build_context.empty()) j["_dockerfile"] = s.dockerfile;
		if ( !s.host_network && !plan.infra.empty()) j["infra"] = plan.infra;
		j["autostart"] = s.autostart;
		if ( !s.respawn ) j["respawn"] = false;
		auto arr = [](const std::vector<std::string>& v) { JSON a = JSON::Array(); for ( const auto& e : v ) a.append(JSON(e)); return a; };
		if ( !s.volumes.empty())    j["volumes"]    = arr(s.volumes);
		if ( !s.env.empty())        j["env"]        = arr(s.env);
		if ( !s.devices.empty())    j["devices"]    = arr(s.devices);
		if ( !s.depends_on.empty()) j["depends_on"] = arr(s.depends_on);
		if ( !s.cap_add.empty())    j["cap_add"]    = arr(s.cap_add);
		if ( !s.cap_drop.empty())   j["cap_drop"]   = arr(s.cap_drop);
		std::string d = j.dump(true);   // this JSON lib escapes '/' as '\/'; show plain slashes
		for ( std::string::size_type p = 0; ( p = d.find("\\/", p)) != std::string::npos; ) d.replace(p, 2, "/");
		os << "\n# --- " << s.name << ( s.host_network ? "  (host network)" : "" ) << " ---\n";
		os << d << "\n";
	}
	return os.str();
}

}
