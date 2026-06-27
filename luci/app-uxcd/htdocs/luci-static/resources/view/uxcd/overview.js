'use strict';
'require view';
'require poll';
'require ui';
'require dom';
'require uxcd';

// The "Containers" tab: a live table of every uxcd-supervised container with
// start/stop/restart buttons and a per-container detail+log modal. The index
// widget (view/status/include/30_containers.js) deep-links here as
// admin/containers/overview#<name> and we auto-open that container's detail.

return view.extend({
	// name -> { cpu: <usec>, t: <ms> } for sampling %CPU between polls
	cpuPrev: {},

	load: function() {
		return uxcd.listArray();
	},

	cpuPct: function(name, cpu_usec) {
		var now = Date.now(), p = this.cpuPrev[name];
		this.cpuPrev[name] = { cpu: cpu_usec, t: now };
		if (!p || now <= p.t)
			return null;
		var pct = (cpu_usec - p.cpu) / ((now - p.t) * 1000) * 100;  // usec / (ms*1000) * 100
		return pct < 0 ? 0 : pct;
	},

	actionButtons: function(c, compact) {
		var self = this;
		function btn(verb, label, style) {
			return E('button', {
				'class': 'btn cbi-button cbi-button-' + style,
				'title': verb,
				'click': ui.createHandlerFn(self, function() {
					return uxcd.action(verb, c.name).then(function() { return self.refresh(); });
				})
			}, label);
		}
		var b;
		if (c.running)
			b = [ btn('restart', compact ? '↻' : _('Restart'), 'action'), ' ',
			      btn('stop', compact ? '■' : _('Stop'), 'reset') ];
		else
			b = [ btn('start', compact ? '▶' : _('Start'), 'positive') ];
		return E('div', { 'style': 'white-space:nowrap' }, b);
	},

	tableContent: function(containers) {
		var self = this;

		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Name')),
			E('div', { 'class': 'th' }, _('Status')),
			E('div', { 'class': 'th' }, _('Memory')),
			E('div', { 'class': 'th' }, _('CPU')),
			E('div', { 'class': 'th' }, _('PIDs')),
			E('div', { 'class': 'th' }, _('Network')),
			E('div', { 'class': 'th cbi-section-actions' }, _('Actions'))
		]) ];

		if (!containers.length) {
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No containers registered.')))));
			return rows;
		}

		containers.forEach(function(c) {
			var pct = self.cpuPct(c.name, c.cpu_usec || 0);
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Name') },
					E('a', { 'href': '#', 'click': ui.createHandlerFn(self, function() { return self.openDetail(c.name); }) }, c.name)),
				E('div', { 'class': 'td', 'data-title': _('Status') }, uxcd.statusBadge(c)),
				E('div', { 'class': 'td', 'data-title': _('Memory') }, c.running ? uxcd.fmtBytes(c.memory) : '-'),
				E('div', { 'class': 'td', 'data-title': _('CPU') }, (c.running && pct != null) ? pct.toFixed(0) + '%' : '-'),
				E('div', { 'class': 'td', 'data-title': _('PIDs') }, c.running ? (c.pids || 0) : '-'),
				E('div', { 'class': 'td', 'data-title': _('Network') },
					c.infra ? c.infra : (c.running ? _('own/host') : '-')),
				E('div', { 'class': 'td cbi-section-actions' }, self.actionButtons(c, false))
			]));
		});
		return rows;
	},

	refresh: function() {
		var self = this;
		return uxcd.listArray().then(function(containers) {
			var el = document.getElementById('uxcd-table');
			if (el)
				dom.content(el, self.tableContent(containers));
			return containers;
		});
	},

	openDetail: function(name) {
		var self = this;
		return Promise.all([ uxcd.info(name), uxcd.log(name, 200) ]).then(function(r) {
			var n = r[0] || {}, lines = (r[1] && r[1].lines) || [];
			if (n.error) {
				ui.addNotification(null, E('p', n.error), 'danger');
				return;
			}

			function row(k, v) {
				if (v === undefined || v === null || v === '')
					return null;
				return E('div', { 'class': 'tr' }, [
					E('div', { 'class': 'td', 'style': 'width:30%;font-weight:bold' }, k),
					E('div', { 'class': 'td' }, v)
				]);
			}
			function arr(a) { return Array.isArray(a) ? a.join(' ') : (a || ''); }

			var info = [
				row(_('State'), uxcd.badge(uxcd.stateText(n), n.running ? 'running' : 'stopped')),
				row(_('Health'), (n.health && n.health != 'unknown') ? n.health : null),
				row(_('Desired state'), n.desired),
				row(_('PID'), n.pid),
				row(_('Init PID'), n.init_pid),
				row(_('Uptime'), n.uptime ? uxcd.fmtUptime(n.uptime) : null),
				row(_('Restarts'), n.restarts),
				row(_('Adopted'), n.adopted ? _('yes (re-adopted across a uxcd restart)') : null),
				row(_('Memory'), n.running ? (uxcd.fmtBytes(n.memory) + ' (' + _('peak') + ' ' + uxcd.fmtBytes(n.memory_peak) + ')') : null),
				row(_('PIDs'), n.running ? n.pids : null),
				row(_('Autostart'), n.autostart ? _('yes') : _('no')),
				row(_('Respawn'), n.respawn ? _('yes') : _('no')),
				row(_('Bundle'), n.bundle),
				row(_('Config'), n.config),
				row(_('Hostname'), n.hostname),
				row(_('Command'), arr(n.command)),
				row(_('Working dir'), n.cwd),
				row(_('Network'), n.infra ? (_('infra netns') + ': ' + n.infra) : (n.netns || _('own / host'))),
				row(_('Addresses'), arr(n.ipaddr)),
				row(_('Volumes'), arr(n.volumes)),
				row(_('Devices'), arr(n.devices)),
				row(_('Environment'), arr(n.env)),
				row(_('Depends on'), arr(n.depends_on))
			].filter(function(x) { return x != null; });

			function modalBtn(verb, label, style) {
				return E('button', {
					'class': 'btn cbi-button cbi-button-' + style,
					'click': ui.createHandlerFn(self, function() {
						return uxcd.action(verb, name).then(function() { ui.hideModal(); return self.refresh(); });
					})
				}, label);
			}
			var actions = n.running
				? [ modalBtn('restart', _('Restart'), 'action'), ' ', modalBtn('stop', _('Stop'), 'reset') ]
				: [ modalBtn('start', _('Start'), 'positive') ];

			ui.showModal(_('Container') + ': ' + name, [
				E('div', { 'class': 'table' }, info),
				E('h4', {}, _('Recent log')),
				E('pre', { 'style': 'max-height:18em;overflow:auto;white-space:pre-wrap' },
					lines.length ? lines.join('\n') : _('(no log output)')),
				E('div', { 'class': 'right' }, [
					E('span', { 'style': 'float:left' }, actions),
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);
		});
	},

	render: function(containers) {
		var self = this;

		var table = E('div', { 'class': 'table cbi-section-table', 'id': 'uxcd-table' },
			this.tableContent(containers));

		poll.add(function() { return self.refresh(); }, 5);

		// deep-link from the index widget: admin/containers/overview#<name>
		if (location.hash && location.hash.length > 1)
			this.openDetail(decodeURIComponent(location.hash.substring(1)));

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Containers')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Containers supervised by uxcd. Click a name for full details and recent log output.')),
			table
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
