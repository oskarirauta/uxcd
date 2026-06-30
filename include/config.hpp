#pragma once

#include <string>

// Global daemon settings, read from /etc/config/uxcd (UCI). The per-container
// registry stays in /etc/uxc/<name>.json (as with the stock uxc). A missing
// config file or option keeps the built-in default, so uxcd runs out of the box.
namespace uxcd {

	struct Settings {
		std::string socket    = "";     // ubus socket ("" = libubus built-in default)
		std::string bundle_dir = "/srv/uxc"; // base dir for daemon-initiated pull/build bundles
		int  log_lines        = 200;    // default number of lines `uxc log` returns
		int  log_size         = 64;     // KB per-container log file before rotation
		int  restart_delay    = 2;      // s, base delay before respawning an exited container
		int  restart_max_delay= 60;     // s, cap for the exponential crash backoff
		int  max_restarts     = 0;      // give up after N rapid crashes (0 = never give up)
		int  stop_timeout     = 5;      // s, SIGTERM grace before SIGKILL
		int  infra_watch      = 5;      // s, infra-netns watchdog interval
		int  probe_timeout    = 1500;   // ms, tcp/http healthcheck connect timeout
		int  start_timeout    = 60;     // s, max wait for a dependency to become ready (ordered startup)
		bool safe_update      = true;   // health-gated upgrade: auto-rollback if the new image is unhealthy
		int  safe_update_window = 120;  // s, health window after an upgrade before keep/rollback
		std::string update_check_cron = ""; // cron for the scheduled image-update check ("" = off)
		std::string notify_hook = "";   // shell hook run on each event (args: name event; UXCD_* env); "" = off
		int  notify_debounce  = 0;      // s, min gap between identical (name,event) notifications (0 = none)
		int  heartbeat        = 0;      // s, interval of a periodic "heartbeat" event (dead-man's switch; 0 = off)
		bool debug            = false;  // verbose/debug logging
	};

	extern Settings settings;

	// Load section `config uxcd 'main'` from `path` into settings. Safe to call
	// before connecting to ubus; on a missing file / parse error it is a no-op.
	void load_config(const std::string& path = "/etc/config/uxcd");

}
