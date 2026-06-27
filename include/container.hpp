#pragma once

#include <string>
#include "json.hpp"

// uxcd owns the container lifecycle: it launches ujail directly, supervises it
// via uloop, and applies an intent-aware restart policy. The container registry
// (name -> bundle) is read from /etc/uxc/<name>.json (written by `uxc create`).
namespace uxcd {

	// Load the registry from /etc/uxc so state/healthchecks are known up front.
	void init();

	// Full view of every registered container: bundle, desired/running state,
	// pid and cgroup resource usage (memory/pids/cpu).
	JSON list();

	// Detailed view of one container: list() fields plus OCI command/cwd/
	// hostname/root, uptime, restart count and the network namespace + addresses.
	JSON info(const std::string& name);

	// Last `lines` lines of a container's captured stdout/stderr (0 = all kept,
	// up to the ring-buffer cap). Returns { "lines": [ ... ] }.
	JSON logs(const std::string& name, int lines);

	// Registration: write/remove /etc/uxc/<name>.json. create() registers only
	// (does not start); healthcheck may be an empty JSON to omit it. infra is the
	// optional shared netns to join (empty = the container's own network); respawn
	// (default true) auto-restarts the container when it exits while wanted up.
	bool create(const std::string& name, const std::string& bundle, bool autostart,
	            bool respawn, const std::string& infra, const JSON& healthcheck, std::string& err);
	bool remove(const std::string& name, std::string& err);

	// Lifecycle. On success returns true; on failure returns false and sets err.
	// start/restart mark the container "wanted up" so it is auto-restarted if it
	// exits on its own (crash or in-app restart); stop marks it "wanted down".
	bool start(const std::string& name, std::string& err);
	bool stop(const std::string& name, std::string& err);
	bool restart(const std::string& name, std::string& err);

}
