'use strict';
'require view';
'require poll';
'require ui';
'require dom';
'require uci';
'require uxcd';

// The "Containers" tab: a live table of every uxcd-supervised container with
// start/stop/restart buttons and a per-container detail+log modal. The index
// widget (view/status/include/30_containers.js) deep-links here as
// admin/containers/overview#<name> and we auto-open that container's detail.

return view.extend({
	// name -> { cpu: <usec>, t: <ms> } for sampling %CPU between polls
	cpuPrev: {},

	load: function() {
		var self = this;
		return Promise.all([ uxcd.listArray(), uci.load('network').catch(function() {}) ]).then(function(r) {
			self._netns = self.netnsList();
			return r[0];
		});
	},

	// netns interfaces (proto 'netns') from /etc/config/network = the valid infra targets
	netnsList: function() {
		var out = [];
		(uci.sections('network', 'interface') || []).forEach(function(s) {
			if (s.proto === 'netns') out.push(s.name || s['.name']);
		});
		return out;
	},

	// infra picker: existing netns + an explicit, warned "Host (shared)" option + free text
	infraWidget: function(current) {
		var choices = { '': _('Host (shared - all interfaces incl. WAN) ⚠') };
		(this._netns || []).forEach(function(n) { choices[n] = n; });
		if (current && !choices[current]) choices[current] = current;
		return new ui.Combobox(current || '', choices, {
			create: true,
			placeholder: _('netns name, or Host (shared)')
		});
	},

	cpuLast: {},
	cpuPct: function(name, cpu_usec) {
		var now = Date.now(), p = this.cpuPrev[name];
		// Too soon since the last sample (e.g. a manual refresh right after a poll)
		// makes a tiny dt blow the % up - reuse the last value instead of spiking.
		if (p && now - p.t < 2000)
			return (name in this.cpuLast) ? this.cpuLast[name] : null;
		var pct = (p && now > p.t) ? (cpu_usec - p.cpu) / ((now - p.t) * 1000) * 100 : null;
		if (pct != null && pct < 0) pct = 0;
		this.cpuPrev[name] = { cpu: cpu_usec, t: now };
		this.cpuLast[name] = pct;
		return pct;
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

	// Group field nodes into LuCI-styled tabs. The editor is long; tabs keep it
	// usable on small screens. tabs = [{ title, fields: [nodes] }].
	tabs: function(tabs) {
		var panes = tabs.map(function(t, i) {
			return E('div', { 'class': 'cbi-tabcontainer', 'style': i ? 'display:none' : '' }, t.fields);
		});
		var menu = tabs.map(function(t, i) {
			return E('li', { 'class': i ? 'cbi-tab-disabled' : 'cbi-tab' },
				E('a', { 'href': '#', 'click': function(ev) {
					ev.preventDefault();
					panes.forEach(function(p, j) { p.style.display = (j === i) ? '' : 'none'; });
					menu.forEach(function(m, j) { m.className = (j === i) ? 'cbi-tab' : 'cbi-tab-disabled'; });
				} }, t.title));
		});
		return E('div', {}, [ E('ul', { 'class': 'cbi-tabmenu' }, menu), E('div', {}, panes) ]);
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

	// progress modal for a docker2uxcd job: polls its log until it finishes.
	watchJob: function(id) {
		var self = this;
		var pre    = E('pre', { 'style': 'max-height:24em;overflow:auto;white-space:pre-wrap' }, _('starting...'));
		var status = E('p', {}, _('Running...'));
		var pollFn;
		var cancelBtn = E('button', { 'class': 'btn cbi-button-negative',
			'click': ui.createHandlerFn(self, function() { cancelBtn.disabled = true; status.textContent = _('Cancelling...'); return uxcd.jobCancel(id); }) }, _('Cancel job'));
		function stop() { if (pollFn) poll.remove(pollFn); ui.hideModal(); }
		pollFn = function() {
			return uxcd.jobLog(id, 300).then(function(r) {
				if (r && r.error) {   // job no longer tracked (reaped, or daemon restarted)
					poll.remove(pollFn);
					status.textContent = _('Job no longer tracked (%s).').format(r.error);
					return;
				}
				var lines = (r && r.lines) || [];
				pre.textContent = lines.length ? lines.join('\n') : _('(no output yet)');
				pre.scrollTop = pre.scrollHeight;
				if (r && r.cancelled && r.running) { status.textContent = _('Cancelling...'); cancelBtn.disabled = true; }
				if (r && r.running === false) {
					poll.remove(pollFn);
					if (r.cancelled) { status.textContent = _('Cancelled.'); self.refresh(); }
					else if (r.exit_code === 0) { status.textContent = _('Completed successfully.'); self.refresh(); }
					else status.textContent = _('Failed (exit %d). See the log below.').format(r.exit_code);
				}
			});
		};
		ui.showModal(_('docker2uxcd job'), [
			E('p', _('This can take a while (download / extraction / build); the job keeps running even if you close this.')),
			status,
			pre,
			E('div', { 'class': 'right' }, [
				cancelBtn, ' ',
				E('button', { 'class': 'btn', 'click': stop }, _('Close'))
			])
		]);
		poll.add(pollFn, 2);
		pollFn();
	},

	// "Pull image": fetch + convert a registry image via docker2uxcd (async job).
	openPull: function() {
		var self = this;
		var wImage = new ui.Textfield('', { placeholder: 'docker.io/library/nginx:alpine' });
		var wName  = new ui.Textfield('', { placeholder: _('optional; derived from the image if empty') });
		var wInfra = self.infraWidget('');
		var wAuto  = new ui.Checkbox('0');
		ui.showModal(_('Pull image'), [
			E('p', { 'class': 'cbi-section-descr' },
				_('Fetch and convert a registry image with docker2uxcd, then register it. Requires the docker2uxcd package.')),
			self.field(_('Image'), wImage, _('Registry reference, e.g. docker.io/library/nginx:alpine.')),
			self.field(_('Name'), wName),
			self.field(_('Network (infra)'), wInfra),
			self.field(_('Start on boot'), wAuto),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var image = (wImage.getValue() || '').trim();
						if (!image) { ui.addNotification(null, E('p', _('Image is required.')), 'warning'); return; }
						return uxcd.pull({ image: image, name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1' })
							.then(function(res) {
								if (res && res.error) { ui.addNotification(null, E('p', _('pull failed: %s').format(res.error)), 'danger'); return; }
								if (res && res.job) self.watchJob(res.job);
							});
					})
				}, _('Pull'))
			])
		]);
	},

	// "Build Dockerfile": build a single-stage host-arch image via docker2uxcd.
	openBuild: function() {
		var self = this;
		var wDf    = new ui.Textfield('', { placeholder: '/root/myapp/Dockerfile' });
		var wCtx   = new ui.Textfield('', { placeholder: _('build context dir (optional)') });
		var wName  = new ui.Textfield('');
		var wInfra = self.infraWidget('');
		var wAuto  = new ui.Checkbox('0');
		ui.showModal(_('Build from Dockerfile'), [
			E('p', { 'class': 'cbi-section-descr' },
				_('Build a single-stage, host-architecture image from a Dockerfile with docker2uxcd (no Docker daemon). Requires the docker2uxcd package.')),
			self.field(_('Dockerfile'), wDf, _('Path to the Dockerfile on this device.')),
			self.field(_('Context'), wCtx, _('Directory for COPY/ADD; defaults to the Dockerfile directory.')),
			self.field(_('Name'), wName),
			self.field(_('Network (infra)'), wInfra),
			self.field(_('Start on boot'), wAuto),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var df = (wDf.getValue() || '').trim();
						if (!df) { ui.addNotification(null, E('p', _('Dockerfile path is required.')), 'warning'); return; }
						return uxcd.build({ dockerfile: df, context: wCtx.getValue(), name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1' })
							.then(function(res) {
								if (res && res.error) { ui.addNotification(null, E('p', _('build failed: %s').format(res.error)), 'danger'); return; }
								if (res && res.job) self.watchJob(res.job);
							});
					})
				}, _('Build'))
			])
		]);
	},

	// "Add container": register an existing OCI bundle, then open its editor.
	openCreate: function() {
		var self = this;
		var wName  = new ui.Textfield('', { placeholder: _('e.g. web') });
		var wPath  = new ui.Textfield('', { placeholder: '/srv/web' });
		var wInfra = self.infraWidget('');
		var wAuto  = new ui.Checkbox('0');

		ui.showModal(_('Add container'), [
			E('p', { 'class': 'cbi-section-descr' },
				_('Register an existing OCI bundle directory. To fetch an image or build from a Dockerfile, use the "Pull image" / "Build Dockerfile" buttons.')),
			self.field(_('Name'), wName),
			self.field(_('Bundle path'), wPath, _('Directory holding the OCI config.json + rootfs.')),
			self.field(_('Network (infra)'), wInfra, _('Network namespace to join. "Host (shared)" = all host interfaces incl. WAN; prefer a netns.')),
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
	// row-editor for cron schedules: [{cron, action, enabled}]. Not a single ui.*
	// widget, so it returns { node, read() } for openEditor to place and collect.
	scheduleWidget: function(schedules) {
		var rows = E('div', {});
		function addRow(s) {
			s = s || {};
			var cron   = new ui.Textfield(s.cron || '', { placeholder: '0 3 * * *' });
			var action = new ui.Select(s.action || 'restart', { 'restart': _('restart'), 'stop': _('stop'), 'start': _('start') }, { widget: 'select' });
			var en     = new ui.Checkbox(s.enabled === false ? '0' : '1');
			var row = E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin-bottom:.4em' }, [
				E('div', { 'style': 'flex:2' }, cron.render()),
				E('div', { 'style': 'flex:1' }, action.render()),
				E('div', { 'title': _('enabled') }, en.render()),
				E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': function() { rows.removeChild(row); } }, '✕')
			]);
			row._cron = cron; row._action = action; row._en = en;
			rows.appendChild(row);
		}
		(schedules || []).forEach(addRow);
		return {
			node: E('div', {}, [
				E('div', { 'style': 'display:flex;gap:.5em;font-weight:bold;margin-bottom:.3em' }, [
					E('div', { 'style': 'flex:2' }, _('Cron (min hour dom mon dow)')),
					E('div', { 'style': 'flex:1' }, _('Action')),
					E('div', {}, _('On'))
				]),
				rows,
				E('button', { 'class': 'btn cbi-button', 'click': function() { addRow(); } }, _('+ add schedule'))
			]),
			read: function() {
				var out = [];
				Array.prototype.forEach.call(rows.childNodes, function(row) {
					var c = (row._cron.getValue() || '').trim();
					if (!c) return;
					out.push({ cron: c, action: row._action.getValue(), enabled: row._en.getValue() == '1' });
				});
				return out;
			}
		};
	},

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
			var wInfra   = self.infraWidget(cfg.infra || '');
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
			var wNoNewPriv = new ui.Checkbox(cfg.no_new_privileges === false ? '0' : '1');
			var wMounts  = new ui.DynamicList(cfg.mounts || [], null, { placeholder: '/mnt/usb' });
			var cpuQ = parseInt(res(['cpu', 'quota']), 10), cpuP = parseInt(res(['cpu', 'period']), 10);
			var wCpu = new ui.Textfield(( cpuQ > 0 && cpuP > 0 ) ? String(Math.round(cpuQ / cpuP * 100)) : '',
				{ placeholder: _('% of a core (100 = 1 core, 200 = 2)') });
			var hc = cfg.healthcheck || {};
			var wHcInt    = new ui.Textfield(hc.interval != null ? String(hc.interval) : '', { placeholder: _('seconds, e.g. 30') });
			var wHcRetry  = new ui.Textfield(hc.retries != null ? String(hc.retries) : '', { placeholder: _('e.g. 3') });
			var wHcAction = new ui.Select(hc.on_unhealthy || '', { '': _('(report only)'), 'restart': _('restart'), 'stop': _('stop') }, { widget: 'select' });
			var wHcChecks = new ui.Textarea(hc.checks ? JSON.stringify(hc.checks, null, 2) : '',
				{ rows: 6, placeholder: '[ { "type": "http", "target": "127.0.0.1:5000/api/version" } ]' });
			var wSched    = self.scheduleWidget(cfg.schedule || []);

			ui.showModal(_('Configure') + ': ' + name, [
				self.tabs([
					{ title: _('General'), fields: [
						self.field(_('Start on boot'), wAuto),
						self.field(_('Auto-restart (respawn)'), wRespawn),
						self.field(_('Network (infra)'), wInfra, _('Network namespace to join. "Host (shared)" puts the container on ALL host interfaces incl. WAN - prefer a netns to isolate.')),
						self.field(_('Overlay path'), wOvPath, _('Persistent read-write overlay directory (optional).')),
						self.field(_('Overlay size'), wOvSize, _('tmpfs overlay size, e.g. 64M (optional).')),
					] },
					{ title: _('Storage'), fields: [
						self.field(_('Volumes'), wVols, _('Bind mounts as src:dst[:ro].')),
						self.field(_('Required mounts'), wMounts, _('Host paths that must be mounted before this container starts (e.g. external storage holding its volumes).')),
						self.field(_('Devices'), wDevs, _('Device node paths; each gets a node + cgroup allow.')),
					] },
					{ title: _('Runtime'), fields: [
						self.field(_('Environment'), wEnv),
						self.field(_('Depends on'), wDeps, _('Containers started before this one.')),
						self.field(_('Memory limit'), wMem),
						self.field(_('PID limit'), wPids),
						self.field(_('CPU limit'), wCpu, _('CPU cap as a percentage of one core (empty = unlimited).')),
					] },
					{ title: _('Health'), fields: [
						self.field(_('Interval'), wHcInt, _('Seconds between health probes (empty = no healthcheck).')),
						self.field(_('Retries'), wHcRetry, _('Failed cycles before marking unhealthy.')),
						self.field(_('On unhealthy'), wHcAction),
						self.field(_('Checks'), wHcChecks, _('JSON array of checks - type tcp/http (target), resource (memory_max/cpu_max), or exec (command, timeout).')),
					] },
					{ title: _('Security'), fields: [
						self.field(_('Drop capabilities'), wCapDrop, _('"ALL" drops everything, then add back below.')),
						self.field(_('Add capabilities'), wCapAdd),
						self.field(_('Seccomp'), wSeccomp, _("OCI profile path; \"unconfined\" disables filtering.")),
					self.field(_('No new privileges'), wNoNewPriv, _('Block setuid/privilege gain (OCI noNewPrivileges). Uncheck only for privileged workloads.')),
					] },
					{ title: _('Schedule'), fields: [
						E('p', { 'class': 'cbi-section-descr' }, _('Cron-driven actions run by the uxcd scheduler (host local time). Fields: minute hour day-of-month month day-of-week. Examples: "0 3 * * *" = 03:00 daily; "0 2 * * 0" = Sun 02:00; "*/30 * * * *" = every 30 min.')),
						wSched.node
					] },
				]),

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
							setOrDel('mounts', list(wMounts));
							setOrDel('devices', list(wDevs));
							setOrDel('env', list(wEnv));
							setOrDel('depends_on', list(wDeps));
							setOrDel('schedule', wSched.read());
							setOrDel('cap_drop', list(wCapDrop));
							setOrDel('cap_add', list(wCapAdd));
							if (wSeccomp.getValue().trim()) cfg.seccomp = wSeccomp.getValue().trim(); else delete cfg.seccomp;
						if (wNoNewPriv.getValue() == '1') delete cfg.no_new_privileges; else cfg.no_new_privileges = false;

							// resources.memory.limit / pids.limit, preserving the rest
							var mem = parseInt(wMem.getValue(), 10), pids = parseInt(wPids.getValue(), 10);
							cfg.resources = cfg.resources || {};
							if (!isNaN(mem) && mem > 0) { cfg.resources.memory = cfg.resources.memory || {}; cfg.resources.memory.limit = mem; }
							else if (cfg.resources.memory) delete cfg.resources.memory.limit;
							if (!isNaN(pids) && pids > 0) { cfg.resources.pids = cfg.resources.pids || {}; cfg.resources.pids.limit = pids; }
							else if (cfg.resources.pids) delete cfg.resources.pids.limit;
							var cpu = parseInt(wCpu.getValue(), 10);
							if (!isNaN(cpu) && cpu > 0) { cfg.resources.cpu = cfg.resources.cpu || {}; cfg.resources.cpu.quota = cpu * 1000; cfg.resources.cpu.period = 100000; }
							else if (cfg.resources.cpu) { delete cfg.resources.cpu.quota; delete cfg.resources.cpu.period; }
							if (cfg.resources.memory && !Object.keys(cfg.resources.memory).length) delete cfg.resources.memory;
							if (cfg.resources.pids && !Object.keys(cfg.resources.pids).length) delete cfg.resources.pids;
							if (cfg.resources.cpu && !Object.keys(cfg.resources.cpu).length) delete cfg.resources.cpu;
							if (!Object.keys(cfg.resources).length) delete cfg.resources;

							// healthcheck: interval/retries/on_unhealthy + checks (edited as a JSON array)
							var hcChecksStr = (wHcChecks.getValue() || '').trim();
							var hcChecks = [];
							if (hcChecksStr) {
								try { hcChecks = JSON.parse(hcChecksStr); }
								catch (e) { ui.addNotification(null, E('p', _('Healthcheck "Checks" must be valid JSON: %s').format(e)), 'danger'); return; }
								if (!Array.isArray(hcChecks)) { ui.addNotification(null, E('p', _('Healthcheck "Checks" must be a JSON array.')), 'danger'); return; }
							}
							var hcInt = parseInt(wHcInt.getValue(), 10), hcRetry = parseInt(wHcRetry.getValue(), 10), hcAct = wHcAction.getValue();
							if (hcChecks.length || (!isNaN(hcInt) && hcInt > 0) || hcAct) {
								var h = {};
								if (!isNaN(hcInt) && hcInt > 0) h.interval = hcInt;
								if (!isNaN(hcRetry) && hcRetry > 0) h.retries = hcRetry;
								if (hcAct) h.on_unhealthy = hcAct;
								if (hcChecks.length) h.checks = hcChecks;
								cfg.healthcheck = h;
							} else delete cfg.healthcheck;

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
		}).catch(function(e) {
			ui.addNotification(null, E('p', 'uxcd editor: ' + (e && (e.stack || e.message) || e)), 'danger');
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
				E('div', { 'class': 'td', 'data-title': _('Status') }, [
					uxcd.statusBadge(c),
					(c.running && c.uptime) ? E('span', { 'style': 'margin-left:.4em;color:#888;font-size:90%' }, '· ' + uxcd.fmtUptime(c.uptime)) : '',
					c.config_changed ? E('span', { 'style': 'margin-left:.4em;color:#f0ad4e;cursor:help', 'title': _('Config changed since launch - restart to apply') }, '⟳') : '',
					c.upgrading ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('upgrading'), 'starting')) : '',
					(c.update_available && !c.upgrading) ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('update'), 'up')) : '',
					(c.oom_killed && !c.running) ? E('span', { 'style': 'margin-left:.4em', 'title': _('last run was OOM-killed') }, uxcd.badge(_('OOM'), 'down')) : '',
					c.last_update == 'rolled_back' ? E('span', { 'style': 'margin-left:.4em', 'title': _('Auto-rolled back: the updated image did not become healthy') }, uxcd.badge(_('rolled back'), 'down')) : ''
				]),
				E('div', { 'class': 'td', 'data-title': _('Memory') }, c.running ? uxcd.fmtBytes(c.memory) : '-'),
				E('div', { 'class': 'td', 'data-title': _('CPU') }, (c.running && pct != null) ? pct.toFixed(0) + '%' : '-'),
				E('div', { 'class': 'td', 'data-title': _('PIDs') }, c.running ? (c.pids || 0) : '-'),
				E('div', { 'class': 'td', 'data-title': _('Network') },
					c.infra ? c.infra
						: E('span', { 'style': 'color:#d9534f;cursor:help', 'title': _('Host network: shares ALL host interfaces including the WAN/public IP - reachable from anywhere the firewall permits. Use an infra netns to isolate.') }, _('host ⚠'))),
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
			function dig(s) { return s ? E('span', { 'style': 'font-family:monospace;display:inline-block;max-width:26em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom', 'title': s }, s) : null; }

			var info = [
				row(_('State'), uxcd.badge(uxcd.stateText(n), n.running ? 'running' : 'stopped')),
				row(_('Health'), (n.health && n.health != 'unknown') ? n.health : null),
				row(_('Pending'), n.config_changed ? _('config changed since launch - restart to apply') : null),
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
				row(_('Image'), n.image),
				row(_('Digest'), dig(n.digest)),
				row(_('Update'), n.upgrading ? E('em', {}, _('upgrading…')) : (n.update_available ? E('span', {}, [ _('available') + ' ', dig(n.update_digest) ]) : null)),
				row(_('Last update'), n.last_update ? ({ 'verified': _('verified healthy'), 'rolled_back': _('rolled back (new image stayed unhealthy)'), 'rollback_failed': _('update failed; rollback also failed') }[n.last_update] || n.last_update) : null),
				row(_('Last exit'), n.exited_at ? E('span', {}, [
					(n.oom_killed
						? E('span', { 'style': 'color:#d9534f;font-weight:bold' }, _('OOM-killed'))
						: (n.term_signal ? _('killed by %s').format(uxcd.signalName(n.term_signal))
							: (n.exit_code != null ? _('exit code %d').format(n.exit_code) : _('exited')))),
					' — ' + new Date(n.exited_at * 1000).toLocaleString()
				]) : null),
				n.cpu_pressure ? row(_('CPU pressure'), _('some avg10 %s / avg60 %s').format(n.cpu_pressure.avg10, n.cpu_pressure.avg60)) : null,
				n.memory_pressure ? row(_('Memory pressure'), _('some avg10 %s / avg60 %s').format(n.memory_pressure.avg10, n.memory_pressure.avg60)) : null,
				n.io_pressure ? row(_('IO pressure'), _('some avg10 %s / avg60 %s').format(n.io_pressure.avg10, n.io_pressure.avg60)) : null,
				row(_('Bundle'), n.bundle),
				row(_('Config'), n.config),
				row(_('Hostname'), n.hostname),
				row(_('Command'), arr(n.command)),
				row(_('Working dir'), n.cwd),
				row(_('Network'), n.infra ? (_('infra netns') + ': ' + n.infra)
					: (n.netns ? n.netns
						: E('span', { 'style': 'color:#d9534f' }, _('host network - shares ALL host interfaces incl. WAN; the firewall is the only protection. Use an infra netns to isolate.')))),
				row((n.infra || n.netns) ? _('Addresses') : _('Host addresses (incl. WAN)'), arr(n.ipaddr)),
				row(_('Volumes'), arr(n.volumes)),
				row(_('Devices'), arr(n.devices)),
				row(_('Environment'), arr(n.env)),
				row(_('Depends on'), arr(n.depends_on)),
				(n.schedules && n.schedules.length) ? row(_('Schedules'), E('div', {}, n.schedules.map(function(s) {
					return E('div', { 'style': s.enabled === false ? 'color:#999' : '' },
						s.cron + '  →  ' + s.action + (s.enabled === false ? ' (' + _('disabled') + ')' : ''));
				}))) : null
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
			if (n.update_available && !n.upgrading)
				actions.push(' ', E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						return uxcd.upgrade(name).then(function(res) {
							if (res && res.error) { ui.addNotification(null, E('p', _('upgrade failed: %s').format(res.error)), 'danger'); return; }
							if (res && res.job) { ui.hideModal(); self.watchJob(res.job); }
						});
					})
				}, _('Upgrade')));
				if (n.has_prev)
					actions.push(' ', E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'title': _('Swap back to the previous bundle (.prev) and restart. Reversible.'),
						'click': ui.createHandlerFn(self, function() {
							return uxcd.rollback(name).then(function(ok) { if (ok) { ui.hideModal(); return self.refresh(); } });
						})
					}, _('Rollback')));

			ui.showModal(_('Container') + ': ' + name, [
				self.tabs([
					{ title: _('Info'), fields: [ E('div', { 'class': 'table' }, info) ] },
					{ title: _('Log (live)'), fields: [
				E('pre', { 'id': 'uxcd-detail-log', 'style': 'max-height:20em;overflow:auto;white-space:pre-wrap' },
					lines.length ? lines.join('\n') : _('(no log output)')),
					] }
				]),
				E('div', { 'class': 'right' }, [
					E('span', { 'style': 'float:left' }, actions),
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
				])
			]);

			// follow the log tail every 2s while the modal is open (live debugging);
			// replace any prior follower and stop when the <pre> leaves the DOM.
			if (self._detailFollow) poll.remove(self._detailFollow);
			self._detailFollow = function follow() {
				var el = document.getElementById('uxcd-detail-log');
				if (!el) { poll.remove(follow); return; }
				return uxcd.log(name, 200).then(function(lr) {
					var ls = (lr && lr.lines) || [];
					var atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
					el.textContent = ls.length ? ls.join(String.fromCharCode(10)) : _('(no log output)');
					if (atBottom) el.scrollTop = el.scrollHeight;
				});
			};
			poll.add(self._detailFollow, 2);
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
				}, _('Add container')),
				' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'openPull') }, _('Pull image')),
				' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'openBuild') }, _('Build Dockerfile')),
				' ',
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, function() {
					return uxcd.checkUpdates().then(function(ok) {
						if (ok) uxcd.listArray().then(function(arr) {
								var prov = arr.filter(function(c) { return c.image; }).length;
								ui.addNotification(null, prov === 0
									? E('p', _('No containers have a recorded image yet - nothing to check. Pull (or re-pull) a container via the UI to record provenance and enable update checks.'))
									: E('p', _('Checking %d container(s) for updates - any update badges appear shortly.').format(prov)),
									prov === 0 ? 'warning' : 'info');
								});
						return self.refresh();
					});
				}) }, _('Check for updates'))
			]),
			table
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
