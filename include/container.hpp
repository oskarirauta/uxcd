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

	// Last `lines` lines of a container's captured stdout/stderr (0 = all kept,
	// up to the ring-buffer cap). Returns { "lines": [ ... ] }.
	JSON logs(const std::string& name, int lines);

	// Lifecycle. On success returns true; on failure returns false and sets err.
	// start/restart mark the container "wanted up" so it is auto-restarted if it
	// exits on its own (crash or in-app restart); stop marks it "wanted down".
	bool start(const std::string& name, std::string& err);
	bool stop(const std::string& name, std::string& err);
	bool restart(const std::string& name, std::string& err);

}
