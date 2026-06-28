'use strict';
'require view';
'require form';
'require fs';
'require ui';

// Daemon-wide settings for uxcd, backed by UCI (/etc/config/uxcd, section
// 'uxcd.main'). This is the one UCI-backed page in the app - the per-container
// config lives in the registry JSON and is edited from the Overview. Most options
// here take effect on the next uxcd (re)start, so a "Restart uxcd" action is
// offered below the form.
return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('uxcd', _('uxcd Settings'),
			_('Daemon-wide settings for the uxcd container supervisor. ' +
			  'Save, then use "Restart uxcd" below to apply (most options take effect on restart).'));

		s = m.section(form.NamedSection, 'main', 'uxcd', _('Daemon'));
		s.addremove = false;

		s.tab('storage', _('Storage'));
		s.tab('logging', _('Logging'));
		s.tab('restart', _('Restart & crash'));
		s.tab('health',  _('Health & timeouts'));
		s.tab('update',  _('Safe-update'));
		s.tab('metrics', _('Metrics'));
		s.tab('debug',   _('Debug'));

		// --- Storage ---
		o = s.taboption('storage', form.Value, 'bundle_dir', _('Bundle directory'),
			_('Base directory for containers pulled/built via the UI. Point at external storage for large images.'));
		o.placeholder = '/srv/uxc';
		o.rmempty = true;

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
			_('Give up after this many rapid crashes (0 = never give up).'));
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
			_('Max wait for a dependency to become ready during ordered startup. Fail-open: the container starts anyway after this.'));
		o.datatype = 'uinteger'; o.placeholder = '60';

		// --- Safe-update ---
		o = s.taboption('update', form.Flag, 'safe_update', _('Safe update'),
			_('Health-gated upgrade: after a one-click upgrade, automatically roll back to the previous bundle if the new image does not become healthy. Applies only to containers that define a healthcheck.'));
		o.default = '1';
		o = s.taboption('update', form.Value, 'safe_update_window', _('Safe-update window (s)'),
			_('How long to watch the upgraded container for health before keeping it or rolling back.'));
		o.datatype = 'uinteger'; o.placeholder = '120';
		o.depends('safe_update', '1');

		// --- Metrics ---
		o = s.taboption('metrics', form.Flag, 'metrics_public', _('Public metrics'),
			_('Allow the Prometheus endpoint (<code>/cgi-bin/uxcd-metrics</code>) to be scraped from other hosts. Default: localhost only. Prefer an authenticating reverse proxy for remote scraping.'));
		o.default = '0';
		o.rmempty = true;

		// --- Debug ---
		o = s.taboption('debug', form.Flag, 'debug', _('Debug logging'),
			_('Verbose/debug logging to the system log.'));
		o.default = '0';
		o.rmempty = true;

		return m.render().then(function(mapEl) {
			var restartBtn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, function() {
					return fs.exec('/etc/init.d/uxcd', [ 'restart' ]).then(function(res) {
						if (res.code === 0)
							ui.addNotification(null, E('p', _('uxcd restarted - settings applied.')), 'info');
						else
							ui.addNotification(null, E('p', _('uxcd restart failed (exit %d): %s').format(res.code, res.stderr || '')), 'danger');
					}).catch(function(e) {
						ui.addNotification(null, E('p', _('uxcd restart failed: %s').format(e)), 'danger');
					});
				})
			}, _('Restart uxcd'));

			return E('div', {}, [
				mapEl,
				E('div', { 'class': 'cbi-page-actions', 'style': 'margin-top:1em' }, [
					restartBtn,
					E('span', { 'style': 'margin-left:1em;color:#888' },
						_('Save the form first, then restart to apply.'))
				])
			]);
		}.bind(this));
	}
});
