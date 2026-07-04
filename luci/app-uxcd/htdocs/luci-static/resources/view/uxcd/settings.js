'use strict';
'require view';
'require form';

// Daemon-wide settings for uxcd, backed by UCI (/etc/config/uxcd, section
// 'uxcd.main'). This is the one UCI-backed page in the app - the per-container
// config lives in the registry JSON and is edited from the Overview. Most options
// take effect only on the next uxcd (re)start, so "Save & Apply" restarts uxcd
// automatically (a procd reload trigger on the uxcd config; see uxcd.init).
return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('uxcd', _('uxcd Settings'),
			_('Daemon-wide settings for the uxcd container supervisor. ' +
			  'Save &amp; Apply applies the changes and restarts uxcd (most options take effect only on restart).'));

		s = m.section(form.NamedSection, 'main', 'uxcd', _('Daemon'));
		s.addremove = false;

		s.tab('storage', _('Storage'));
		s.tab('logging', _('Logging'));
		s.tab('restart', _('Restart & crash'));
		s.tab('health',  _('Health & timeouts'));
		s.tab('update',  _('Safe-update'));
		s.tab('metrics', _('Metrics'));
		s.tab('notify',  _('Notifications'));
		s.tab('debug',   _('Debug'));

		// --- Storage ---
		o = s.taboption('storage', form.Value, 'bundle_dir', _('Bundle directory'),
			_('Base directory for containers pulled/built via the UI.<br>Point at external storage for large images.'));
		o.placeholder = '/srv/uxc';
		o.rmempty = true;
		o = s.taboption('storage', form.Value, 'disk_min', _('Minimum free space (MB)'),
			_('Refuse a pull/build/upgrade when free space on the bundle filesystem drops below this.<br>Stops a near-full partition from bricking the box (an upgrade briefly doubles the bundle).<br>0 = off.<br>'));
		o.datatype = 'uinteger'; o.placeholder = '50';

		// --- Logging ---
		o = s.taboption('logging', form.Value, 'log_lines', _('Log lines'),
			_('Default number of lines returned by the log view / <code>uxc log</code>.'));
		o.datatype = 'uinteger'; o.placeholder = '200';
		o = s.taboption('logging', form.Value, 'log_size', _('Log size (KB)'),
			_('Per-container log file size before rotation.'));
		o.datatype = 'uinteger'; o.placeholder = '64';

		// --- Restart & crash ---
		o = s.taboption('restart', form.Value, 'restart_delay', _('Restart delay (s)'),
			_('Base delay before respawning an exited container.'));
		o.datatype = 'uinteger'; o.placeholder = '2';
		o = s.taboption('restart', form.Value, 'restart_max_delay', _('Max restart delay (s)'),
			_('Cap for the exponential crash backoff.'));
		o.datatype = 'uinteger'; o.placeholder = '60';
		o = s.taboption('restart', form.Value, 'max_restarts', _('Max restarts'),
			_('Give up after this many rapid crashes.<br>Default: respawn forever'));
		o.datatype = 'uinteger'; o.placeholder = '0';
		o = s.taboption('restart', form.Value, 'stop_timeout', _('Stop timeout (s)'),
			_('SIGTERM grace period before SIGKILL.'));
		o.datatype = 'uinteger'; o.placeholder = '5';

		// --- Health & timeouts ---
		o = s.taboption('health', form.Value, 'probe_timeout', _('Probe timeout (ms)'),
			_('tcp/http healthcheck connect timeout.'));
		o.datatype = 'uinteger'; o.placeholder = '1500';
		o = s.taboption('health', form.Value, 'infra_watch', _('Infra watch (s)'),
			_('Shared-netns (infra) watchdog interval.'));
		o.datatype = 'uinteger'; o.placeholder = '5';
		o = s.taboption('health', form.Value, 'start_timeout', _('Start timeout (s)'),
			_('Max wait for a dependency to become ready during ordered startup.<br>Fail-open: the container starts anyway after this.'));
		o.datatype = 'uinteger'; o.placeholder = '60';

		// --- Safe-update ---
		o = s.taboption('update', form.Flag, 'safe_update', _('Safe update'),
			_('Health-gated upgrade: after a one-click upgrade, automatically roll back<br>to the previous bundle if the new image does not become healthy.<br>Applies only to containers that define a healthcheck.'));
		o.default = '1';
		o = s.taboption('update', form.Value, 'safe_update_window', _('Safe-update window (s)'),
			_('How long to watch the upgraded container for health<br>before keeping it or rolling back.'));
		o.datatype = 'uinteger'; o.placeholder = '120';
		o.depends('safe_update', '1');

		o = s.taboption('update', form.Value, 'update_check_cron', _('Scheduled update check (cron)'),
			_('Check for image updates on this schedule (5-field cron, host local time; empty = off).<br>Notify-only: it flags containers that have updates (badge + Activity event) but<br>does not upgrade.<br><br>Example: "0 3 * * *" = 03:00 daily.'));
		o.placeholder = '0 3 * * *';

		// --- Metrics ---
		o = s.taboption('metrics', form.Flag, 'metrics_public', _('Public metrics'),
			_('Allow the Prometheus endpoint (<code>/cgi-bin/uxcd-metrics</code>) to be scraped<br>from other hosts. Default: localhost only. Prefer an authenticating<br>reverse proxy for remote scraping.'));
		o.default = '0';
		o.rmempty = true;

		// --- Notifications ---
		o = s.taboption('notify', form.Value, 'notify_hook', _('Notify hook'),
			_('Shell script run on every event.<br>Args: name event; plus env<br> - UXCD_EVENT<br> - UXCD_CONTAINER<br> - UXCD_HEALTH<br> - UXCD_OOM<br> - UXCD_SIGNAL<br> - UXCD_EXIT_CODE<br> - UXCD_RUNNING<br><br>Write transport script manually (ntfy.sh/curl/sendmail).<br>'));
		o.placeholder = '/etc/uxcd/notify.sh';
		o.rmempty = true;
		o = s.taboption('notify', form.Value, 'notify_debounce', _('Debounce (s)'),
			_('Minimum gap between identical (container, event) notifications.<br>Default: none'));
		o.datatype = 'uinteger'; o.placeholder = '0';
		o = s.taboption('notify', form.Value, 'heartbeat', _('Heartbeat (s)'),
			_('Interval of a periodic "heartbeat" event - its ABSENCE tells your script<br>the box itself died (dead-man\'s switch).<br>Default: none'));
		o.datatype = 'uinteger'; o.placeholder = '0';

		// --- Debug ---
		o = s.taboption('debug', form.Flag, 'debug', _('Debug logging'),
			_('Verbose/debug logging to the system log.'));
		o.default = '0';
		o.rmempty = true;

		// Standard Save & Apply / Save / Reset footer. Apply commits the uxcd UCI
		// config, whose procd reload trigger (uxcd.init) restarts the daemon - so no
		// separate "Restart uxcd" button is needed.
		return m.render();
	}
});
