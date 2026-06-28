'use strict';
'require view';
'require poll';
'require dom';
'require uxcd';

// "Activity": the daemon's recent event timeline (an in-memory ring buffer) -
// container starts and exits/crashes, health transitions, and safe-update
// rollbacks/verifications. Resets when uxcd restarts. Shares uxcd.js.

return view.extend({
	load: function() {
		return uxcd.events(200);
	},

	// colour an event by concern, reusing uxcd.badge's kinds
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
			infra_failed:    'down'
		})[ev] || 'unknown';
		return uxcd.badge(ev || '-', kind);
	},

	fmtTime: function(ts) {
		if (!ts) return '-';
		var d = new Date(ts * 1000);
		return d.toLocaleString();
	},

	content: function(events) {
		var self = this;
		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Time')),
			E('div', { 'class': 'th' }, _('Container')),
			E('div', { 'class': 'th' }, _('Event')),
			E('div', { 'class': 'th' }, _('State'))
		]) ];

		if (!events.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No events yet. The timeline resets when uxcd restarts.')))));

		events.forEach(function(e) {
			var state = (e.running != null ? (e.running ? _('running') : _('stopped')) : '') +
			            (e.health ? ((e.running != null ? ' / ' : '') + e.health) : '');
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Time') }, self.fmtTime(e.ts)),
				E('div', { 'class': 'td', 'data-title': _('Container') }, e.name || '-'),
				E('div', { 'class': 'td', 'data-title': _('Event') }, self.eventBadge(e.event)),
				E('div', { 'class': 'td', 'data-title': _('State') }, state || '-')
			]));
		});

		return E('div', { 'class': 'table', 'id': 'uxcd-activity-tbl' }, rows);
	},

	refresh: function() {
		var self = this;
		return uxcd.events(200).then(function(events) {
			var el = document.getElementById('uxcd-activity');
			if (el)
				dom.content(el, self.content(events));
			return events;
		});
	},

	render: function(events) {
		var self = this;
		poll.add(function() { return self.refresh(); }, 5);
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Activity')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Recent uxcd events: container starts and exits, health changes, and safe-update rollbacks. In-memory - resets when uxcd restarts.')),
			E('div', { 'id': 'uxcd-activity' }, this.content(events))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
