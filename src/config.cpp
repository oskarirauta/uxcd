#include <cstdlib>

#include "uci.hpp"
#include "config.hpp"

namespace uxcd {

Settings settings;

void load_config(const std::string& path) {

	try {

		UCI::PACKAGE pkg(path);

		if ( !pkg.contains("uxcd") || !pkg["uxcd"].contains("main"))
			return;

		UCI::SECTION& s = pkg["uxcd"]["main"];

		auto num = [&](const char* k, int def) -> int {
			if ( !s.contains(k)) return def;
			std::string v = s[k].to_string();
			return v.empty() ? def : atoi(v.c_str());
		};
		auto flag = [&](const char* k, bool def) -> bool {
			if ( !s.contains(k)) return def;
			std::string v = s[k].to_string();
			return v == "1" || v == "true" || v == "yes" || v == "on";
		};

		if ( s.contains("socket") && !s["socket"].to_string().empty())
			settings.socket = s["socket"].to_string();
		if ( s.contains("bundle_dir") && !s["bundle_dir"].to_string().empty())
			settings.bundle_dir = s["bundle_dir"].to_string();

		settings.log_lines       = num("log_lines",       settings.log_lines);
		settings.log_size        = num("log_size",        settings.log_size);
		settings.restart_delay   = num("restart_delay",   settings.restart_delay);
		settings.restart_max_delay = num("restart_max_delay", settings.restart_max_delay);
		settings.max_restarts    = num("max_restarts",    settings.max_restarts);
		settings.stop_timeout    = num("stop_timeout",    settings.stop_timeout);
		settings.infra_watch   = num("infra_watch",   settings.infra_watch);
		settings.probe_timeout = num("probe_timeout", settings.probe_timeout);
		settings.start_timeout = num("start_timeout", settings.start_timeout);
		settings.safe_update   = flag("safe_update",  settings.safe_update);
		settings.safe_update_window = num("safe_update_window", settings.safe_update_window);
		settings.debug         = flag("debug",        settings.debug);

	} catch ( ... ) {
		// no config file or a parse error: keep the built-in defaults
	}
}

}
