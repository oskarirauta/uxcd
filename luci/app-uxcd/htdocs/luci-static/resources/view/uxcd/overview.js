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
		if (!compact) {
			b.push(' ');
			b.push(E('button', {
				'class': 'btn cbi-button',
				'click': ui.createHandlerFn(self, function() { return self.openEditor(c.name); })
			}, _('Configure')));
		}
		return E('div', { 'style': 'white-space:nowrap' }, b);
	},

	// one labelled form row: a ui widget (already rendered) with a left-hand label.
	field: function(label, widget, hint) {
		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				widget.render(),
				hint ? E('div', { 'class': 'cbi-value-description' }, hint) : ''
			])
		]);
	},

	// confirm + unregister a container (leaves the bundle directory in place).
	confirmRemove: function(name) {
		var self = this;
		ui.showModal(_('Remove container'), [
			E('p', _('Unregister "%s"? This deletes /etc/uxc/%s.json; the bundle directory is left untouched.').format(name, name)),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.createHandlerFn(self, function() { return self.openEditor(name); }) }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(self, function() {
						return uxcd.remove(name).then(function(ok) {
							if (!ok) return;
							ui.hideModal();
							return self.refresh();
						});
					})
				}, _('Remove'))
			])
		]);
	},

	// "Add container": register an existing OCI bundle, then open its editor.
	openCreate: function() {
		var self = this;
		var wName  = new ui.Textfield('', { placeholder: _('e.g. web') });
		var wPath  = new ui.Textfield('', { placeholder: '/srv/web' });
		var wInfra = new ui.Textfield('', { placeholder: _('optional shared netns') });
		var wAuto  = new ui.Checkbox('0');

		ui.showModal(_('Add container'), [
			E('p', { 'class': 'cbi-section-descr' },
				_('Register an existing OCI bundle directory. To pull an image or build a Dockerfile, use the uxc CLI for now.')),
			self.field(_('Name'), wName),
			self.field(_('Bundle path'), wPath, _('Directory holding the OCI config.json + rootfs.')),
			self.field(_('Network (infra)'), wInfra, _('Shared netns to join; leave empty for own/host network.')),
			self.field(_('Start on boot'), wAuto),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var name = (wName.getValue() || '').trim();
						var path = (wPath.getValue() || '').trim();
						if (!name || !path) {
							ui.addNotification(null, E('p', _('Name and bundle path are required.')), 'warning');
							return;
						}
						return uxcd.create({ name: name, bundle: path, autostart: wAuto.getValue() == '1', infra: wInfra.getValue() })
							.then(function(ok) {
								if (!ok) return;
								ui.hideModal();
								return self.refresh().then(function() { return self.openEditor(name); });
							});
					})
				}, _('Create'))
			])
		]);
	},

	// Per-container settings editor: load the raw registry config, edit known
	// fields, save the whole object back (full replace preserves untouched fields).
	openEditor: function(name) {
		var self = this;
		return uxcd.getconfig(name).then(function(cfg) {
			if (!cfg || cfg.error) {
				ui.addNotification(null, E('p', (cfg && cfg.error) || _('cannot load config')), 'danger');
				return;
			}
			function res(path) {
				var o = cfg.resources;
				for (var i = 0; o && i < path.length; i++) o = o[path[i]];
				return (o === undefined || o === null) ? '' : String(o);
			}

			var wAuto    = new ui.Checkbox(cfg.autostart ? '1' : '0');
			var wRespawn = new ui.Checkbox((cfg.respawn === false) ? '0' : '1');
			var wInfra   = new ui.Textfield(cfg.infra || '');
			var wOvPath  = new ui.Textfield(cfg.write_overlay_path || '');
			var wOvSize  = new ui.Textfield(cfg.temp_overlay_size || '');
			var wVols    = new ui.DynamicList(cfg.volumes || [], null, { placeholder: 'src:dst[:ro]' });
			var wDevs    = new ui.DynamicList(cfg.devices || [], null, { placeholder: '/dev/dri' });
			var wEnv     = new ui.DynamicList(cfg.env || [], null, { placeholder: 'KEY=VALUE' });
			var wDeps    = new ui.DynamicList(cfg.depends_on || [], null, { placeholder: _('container name') });
			var wMem     = new ui.Textfield(res(['memory', 'limit']), { placeholder: _('bytes, e.g. 2147483648') });
			var wPids    = new ui.Textfield(res(['pids', 'limit']), { placeholder: _('max processes') });
			var wCapDrop = new ui.DynamicList(cfg.cap_drop || [], null, { placeholder: 'ALL / CAP_NET_RAW' });
			var wCapAdd  = new ui.DynamicList(cfg.cap_add || [], null, { placeholder: 'CAP_NET_BIND_SERVICE' });
			var wSeccomp = new ui.Textfield(cfg.seccomp || '', { placeholder: _("profile path, or 'unconfined'") });

			function hdr(t) { return E('h4', { 'style': 'margin:1em 0 .3em' }, t); }

			ui.showModal(_('Configure') + ': ' + name, [
				hdr(_('General')),
				self.field(_('Start on boot'), wAuto),
				self.field(_('Auto-restart (respawn)'), wRespawn),
				self.field(_('Network (infra)'), wInfra, _('Shared netns to join; empty = own/host.')),
				self.field(_('Overlay path'), wOvPath, _('Persistent read-write overlay directory (optional).')),
				self.field(_('Overlay size'), wOvSize, _('tmpfs overlay size, e.g. 64M (optional).')),

				hdr(_('Mounts & devices')),
				self.field(_('Volumes'), wVols, _('Bind mounts as src:dst[:ro].')),
				self.field(_('Devices'), wDevs, _('Device node paths; each gets a node + cgroup allow.')),

				hdr(_('Environment & dependencies')),
				self.field(_('Environment'), wEnv),
				self.field(_('Depends on'), wDeps, _('Containers started before this one.')),

				hdr(_('Resources')),
				self.field(_('Memory limit'), wMem),
				self.field(_('PID limit'), wPids),

				hdr(_('Security')),
				self.field(_('Drop capabilities'), wCapDrop, _('"ALL" drops everything, then add back below.')),
				self.field(_('Add capabilities'), wCapAdd),
				self.field(_('Seccomp'), wSeccomp, _("OCI profile path; \"unconfined\" disables filtering.")),

				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-negative',
						'style': 'float:left',
						'click': ui.createHandlerFn(self, function() { return self.confirmRemove(name); })
					}, _('Remove')),
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							function list(w) { return (w.getValue() || []).filter(function(x) { return x != null && x !== ''; }); }
							function setOrDel(key, arr) { if (arr.length) cfg[key] = arr; else delete cfg[key]; }

							cfg.autostart = (wAuto.getValue() == '1');
							cfg.respawn   = (wRespawn.getValue() == '1');
							if (wInfra.getValue().trim()) cfg.infra = wInfra.getValue().trim(); else delete cfg.infra;
							if (wOvPath.getValue().trim()) cfg.write_overlay_path = wOvPath.getValue().trim(); else delete cfg.write_overlay_path;
							if (wOvSize.getValue().trim()) cfg.temp_overlay_size = wOvSize.getValue().trim(); else delete cfg.temp_overlay_size;
							setOrDel('volumes', list(wVols));
							setOrDel('devices', list(wDevs));
							setOrDel('env', list(wEnv));
							setOrDel('depends_on', list(wDeps));
							setOrDel('cap_drop', list(wCapDrop));
							setOrDel('cap_add', list(wCapAdd));
							if (wSeccomp.getValue().trim()) cfg.seccomp = wSeccomp.getValue().trim(); else delete cfg.seccomp;

							// resources.memory.limit / pids.limit, preserving the rest
							var mem = parseInt(wMem.getValue(), 10), pids = parseInt(wPids.getValue(), 10);
							cfg.resources = cfg.resources || {};
							if (!isNaN(mem) && mem > 0) { cfg.resources.memory = cfg.resources.memory || {}; cfg.resources.memory.limit = mem; }
							else if (cfg.resources.memory) delete cfg.resources.memory.limit;
							if (!isNaN(pids) && pids > 0) { cfg.resources.pids = cfg.resources.pids || {}; cfg.resources.pids.limit = pids; }
							else if (cfg.resources.pids) delete cfg.resources.pids.limit;
							if (cfg.resources.memory && !Object.keys(cfg.resources.memory).length) delete cfg.resources.memory;
							if (cfg.resources.pids && !Object.keys(cfg.resources.pids).length) delete cfg.resources.pids;
							if (!Object.keys(cfg.resources).length) delete cfg.resources;

							return uxcd.save(name, cfg).then(function(ok) {
								if (!ok) return;
								ui.hideModal();
								ui.addNotification(null, E('p', _('Saved. Restart %s to apply the changes.').format(name)), 'info');
								return self.refresh();
							});
						})
					}, _('Save'))
				])
			]);
		});
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
			E('div', { 'style': 'margin:.5em 0' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-add',
					'click': ui.createHandlerFn(self, 'openCreate')
				}, _('Add container'))
			]),
			table
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
