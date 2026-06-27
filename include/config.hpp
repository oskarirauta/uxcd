#pragma once

#include <string>

// Global daemon settings, read from /etc/config/uxcd (UCI). The per-container
// registry stays in /etc/uxc/<name>.json (as with the stock uxc). A missing
// config file or option keeps the built-in default, so uxcd runs out of the box.
namespace uxcd {

	struct Settings {
		std::string socket    = "";     // ubus socket ("" = libubus built-in default)
		int  log_lines        = 200;    // per-container captured-log ring size
		int  restart_delay    = 2;      // s, delay before respawning an exited container
		int  stop_timeout     = 5;      // s, SIGTERM grace before SIGKILL
		int  infra_watch      = 5;      // s, infra-netns watchdog interval
		int  probe_timeout    = 1500;   // ms, tcp/http healthcheck connect timeout
		bool debug            = false;  // verbose/debug logging
	};

	extern Settings settings;

	// Load section `config uxcd 'main'` from `path` into settings. Safe to call
	// before connecting to ubus; on a missing file / parse error it is a no-op.
	void load_config(const std::string& path = "/etc/config/uxcd");

}
