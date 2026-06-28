'use strict';
'require view';
'require poll';
'require dom';
'require ui';
'require uxcd';

// "Activity": recent pull/build/upgrade jobs (with cancel + log) and the daemon's
// event timeline (container starts/exits, health changes, safe-update rollbacks).
// Both are in-memory and reset when uxcd restarts. Shares uxcd.js.

return view.extend({
	load: function() {
		return Promise.all([ uxcd.events(50), uxcd.jobList() ]);
	},

	fmtTime: function(ts) {
		if (!ts) return '-';
		var d = new Date(ts * 1000);
		return d.toLocaleString();
	},

	// --- jobs ---
	jobBadge: function(j) {
		if (j.running) return j.cancelled ? uxcd.badge(_('cancelling'), 'starting') : uxcd.badge(_('running'), 'running');
		if (j.cancelled) return uxcd.badge(_('cancelled'), 'stopped');
		if (j.exit_code === 0) return uxcd.badge(_('done'), 'healthy');
		return uxcd.badge(_('failed (%d)').format(j.exit_code), 'down');
	},

	viewJobLog: function(id) {
		return uxcd.jobLog(id, 300).then(function(r) {
			var lines = (r && r.lines) || [];
			ui.showModal(_('Job log') + ': ' + id, [
				E('pre', { 'style': 'max-height:24em;overflow:auto;white-space:pre-wrap' },
					lines.length ? lines.join('\n') : _('(no output)')),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		});
	},

	jobsContent: function(jobs) {
		var self = this;
		var ids = Object.keys(jobs || {}).filter(function(k) { return k != 'error'; });
		ids.sort(function(a, b) { return (jobs[b].started || 0) - (jobs[a].started || 0); });

		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Started')),
			E('div', { 'class': 'th' }, _('Type')),
			E('div', { 'class': 'th' }, _('Target')),
			E('div', { 'class': 'th' }, _('Status')),
			E('div', { 'class': 'th cbi-section-actions' }, _('Actions'))
		]) ];

		if (!ids.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No jobs.')))));

		ids.forEach(function(id) {
			var j = jobs[id];
			var acts = [ E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, function() { return self.viewJobLog(id); }) }, _('Log')) ];
			if (j.running && !j.cancelled)
				acts.push(' ', E('button', { 'class': 'btn cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(self, function() { return uxcd.jobCancel(id).then(function() { return self.refresh(); }); }) }, _('Cancel')));
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Started') }, self.fmtTime(j.started)),
				E('div', { 'class': 'td', 'data-title': _('Type') }, (j.kind || '-') + (j.upgrade ? ' (' + _('upgrade') + ')' : '')),
				E('div', { 'class': 'td', 'data-title': _('Target') }, (j.name || j.label || '-')),
				E('div', { 'class': 'td', 'data-title': _('Status') }, self.jobBadge(j)),
				E('div', { 'class': 'td cbi-section-actions' }, acts)
			]));
		});
		return E('div', { 'class': 'table' }, rows);
	},

	// --- events ---
	eventBadge: function(ev) {
		var kind = ({
			healthy:         'healthy',
			update_verified: 'healthy',
			started:         'running',
			adopted:         'running',
			starting:        'starting',
			unhealthy:       'unhealthy',
			exited:          'down',
			rolled_back:     'down',
			rollback_failed: 'down',
			infra_failed:    'down',
			upgraded:        'up',
			update_available: 'up',
			update_check:    'running',
			scheduled_restart: 'starting',
			scheduled_stop:  'starting',
			scheduled_start: 'starting'
		})[ev] || 'unknown';
		return uxcd.badge(ev || '-', kind);
	},

	eventsContent: function(events) {
		var self = this;
		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Time')),
			E('div', { 'class': 'th' }, _('Container')),
			E('div', { 'class': 'th' }, _('Event')),
			E('div', { 'class': 'th' }, _('State'))
		]) ];

		if (!events.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No events yet.')))));

		events.forEach(function(e) {
			var state = (e.running != null ? (e.running ? _('running') : _('stopped')) : '') +
			            (e.health ? ((e.running != null ? ' / ' : '') + e.health) : '');
			if (e.event == 'exited') {
				var why = e.oom ? _('OOM-killed') : (e.signal ? _('killed by %s').format(uxcd.signalName(e.signal)) : (e.exit_code != null ? _('exit %d').format(e.exit_code) : ''));
				if (why) state = why + (state ? ' / ' + state : '');
			}
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Time') }, self.fmtTime(e.ts)),
				E('div', { 'class': 'td', 'data-title': _('Container') }, e.name || '-'),
				E('div', { 'class': 'td', 'data-title': _('Event') }, self.eventBadge(e.event)),
				E('div', { 'class': 'td', 'data-title': _('State') }, state || '-')
			]));
		});
		return E('div', { 'class': 'table' }, rows);
	},

	inner: function(events, jobs) {
		var self = this;
		return [
			E('h3', {}, _('Jobs')),
			this.jobsContent(jobs),
			E('div', { 'style': 'margin-top:1em;display:flex;align-items:center;gap:1em' }, [
				E('h3', { 'style': 'margin:0' }, _('Events')),
				E('button', { 'class': 'btn cbi-button',
					'click': ui.createHandlerFn(self, function() { return uxcd.eventsClear().then(function() { return self.refresh(); }); }) }, _('Clear'))
			]),
			this.eventsContent(events)
		];
	},

	refresh: function() {
		var self = this;
		return Promise.all([ uxcd.events(50), uxcd.jobList() ]).then(function(r) {
			var el = document.getElementById('uxcd-activity');
			if (el)
				dom.content(el, self.inner(r[0], r[1]));
			return r;
		});
	},

	render: function(data) {
		var self = this;
		poll.add(function() { return self.refresh(); }, 5);
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Activity')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Recent jobs (pull / build / upgrade) and the daemon event timeline. In-memory - resets when uxcd restarts.')),
			E('div', { 'id': 'uxcd-activity' }, self.inner(data[0], data[1]))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
