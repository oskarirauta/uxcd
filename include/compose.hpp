#pragma once
#include <string>
#include <vector>

// One-shot docker-compose IMPORT (not a runtime): translate a compose file into
// uxcd registry entries that share one infra netns, reusing depends_on / volumes
// / env / devices. The compose runtime, service-name DNS and port publishing are
// out of scope - inside the shared netns services reach each other on 127.0.0.1,
// and external exposure is the admin's firewall job (as everywhere in uxcd).
namespace compose {

struct Service {
	std::string name;                       // container_name, else the service key
	std::string image;                      // "image:" ref ("" if a build)
	std::string build_context;              // "build:" context dir ("" if an image)
	std::string dockerfile;                 // resolved Dockerfile path for a build
	std::vector<std::string> volumes;       // translated to "src:dst[:ro]" (host paths)
	std::vector<std::string> env;           // "KEY=VAL"
	std::vector<std::string> devices;       // "/dev/..." (host)
	std::vector<std::string> depends_on;
	std::vector<std::string> cap_add;
	std::vector<std::string> cap_drop;
	std::vector<std::string> ports;         // raw "h:c" - informational only (no port mapping)
	bool host_network = false;              // network_mode: host
	bool autostart = true;                  // from restart: (no/"" -> false)
	bool respawn = true;                    // from restart: (no -> false)
};

struct Plan {
	std::string project;                    // derived from the compose dir (for naming/volumes)
	std::string infra;                      // shared netns name ("" when every service is host-net)
	std::vector<Service> services;          // in file order
	std::vector<std::string> warnings;      // unsupported/translated bits to show the user
};

// Parse + translate a compose file into a Plan. compose_path resolves relative
// bind sources and names the project; infra_override sets the netns name (else
// derived). Returns false + err on a parse/semantic error.
bool parse(const std::string& compose_path, const std::string& infra_override, Plan& out, std::string& err);

// The per-service registry JSON the import would write (for --dry-run review).
std::string preview(const Plan& plan);

}
