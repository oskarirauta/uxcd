#pragma once

#include <string>
#include <functional>
#include "json.hpp"

// uxcd owns the container lifecycle: it launches ujail directly, supervises it
// via uloop, and applies an intent-aware restart policy. The container registry
// (name -> bundle) is read from /etc/uxc/<name>.json (written by `uxc create`).
namespace uxcd {

	// Wire container state-change events (started/exited/healthy/unhealthy/
	// adopted) to a sink - main connects this to ubus send_event. Call before init().
	void set_event_sink(std::function<void(const std::string&, const JSON&)> sink);

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
	            bool respawn, const std::string& infra, const std::string& overlay_path,
	            const std::string& overlay_size, const JSON& mounts,
	            const JSON& healthcheck, std::string& err);
	bool remove(const std::string& name, std::string& err);

	// Per-container settings editing. getconfig returns the raw registry file
	// (/etc/uxc/<name>.json) for a load->edit->save round-trip; setconfig replaces
	// it wholesale (validated, atomic) and refreshes the in-memory config, so the
	// change applies on the next start/restart.
	JSON getconfig(const std::string& name);
	bool setconfig(const std::string& name, const JSON& config, std::string& err);

	// Background jobs: pull/build via docker2uxcd, run as a captured child process
	// (long-running, so non-blocking). job_start returns a job id (empty + err on
	// failure); the UI polls job_status / job_log. docker2uxcd registers the
	// container itself, so on success it simply appears in list().
	std::string job_start(const std::string& kind, const JSON& params, std::string& err);
	JSON job_status(const std::string& id);
	JSON job_log(const std::string& id, int lines);
	JSON job_list();

	// Recent daemon events (newest first) for the Activity timeline; limit <= 0 = all kept.
	JSON events(int limit);

	// On-demand image-update check: runs docker2uxcd --check-updates as a child
	// and caches per-container results, reported as update_available in list/info.
	bool check_updates(std::string& err);

	// One-click upgrade: re-pull the recorded image to the same bundle path as a
	// job (keeps .prev + overrides) and restart on success. Returns the job id.
	std::string upgrade(const std::string& name, std::string& err);

	// Roll a container back to its .prev backup (swap + restart); false if no .prev.
	bool rollback(const std::string& name, std::string& err);

	// Cancel a running pull/build/upgrade job (SIGTERM its process group).
	bool job_cancel(const std::string& id, std::string& err);

	// Disk: list registered bundles (size, running, .prev backup) and the
	// docker2uxc blob cache; prune reclaims the cache and/or .prev backups.
	// prune target is "cache", "prev" or "all".
	JSON images();
	JSON prune(const std::string& target);

	// Prometheus text exposition of container + daemon metrics (served by the
	// uxcd-metrics CGI and `uxc metrics`).
	std::string metrics();

	// Lifecycle. On success returns true; on failure returns false and sets err.
	// start/restart mark the container "wanted up" so it is auto-restarted if it
	// exits on its own (crash or in-app restart); stop marks it "wanted down".
	bool start(const std::string& name, std::string& err);
	bool stop(const std::string& name, std::string& err);
	bool restart(const std::string& name, std::string& err);

}
