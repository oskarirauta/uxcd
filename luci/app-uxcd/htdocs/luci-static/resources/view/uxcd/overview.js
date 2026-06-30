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

// inline globe icon for the web-UI button (no font/emoji dependency)
var SVG_GLOBE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" style="vertical-align:-2px"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13"/><path d="M8 1.5c2.2 2 2.2 11 0 13M8 1.5c-2.2 2-2.2 11 0 13"/></svg>';

return view.extend({
	// name -> { cpu: <usec>, t: <ms> } for sampling %CPU between polls
	cpuPrev: {},
	_sortField: 'name',   // session-only sort state (resets on reload, survives refresh)
	_sortDir: 'asc',

	load: function() {
		var self = this;
		return Promise.all([ uxcd.listArray(), uci.load('network').catch(function() {}), uci.load('uxcd').catch(function() {}) ]).then(function(r) {
			self._netns = self.netnsList();
			self._consoleEnabled = (uci.get('uxcd', 'main', 'console_enabled') == '1');   // opt-in uxcd-console package
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

	confirmRename: function(name) {
		var self = this;
		var w = new ui.Textfield(name, { placeholder: _('new name') });
		ui.showModal(_('Rename container') + ': ' + name, [
			E('p', _('Rename a stopped container. The bundle directory is left as-is; depends_on references in other containers are updated.')),
			E('div', { 'class': 'cbi-value', 'style': 'margin:1em 0' }, w.render()),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.createHandlerFn(self, function() { return self.openEditor(name); }) }, _('Cancel')),
				' ',
				E('button', { 'class': 'btn cbi-button cbi-button-positive', 'click': ui.createHandlerFn(self, function() {
					var nn = (w.getValue() || '').trim();
					if (!nn || nn == name) { ui.hideModal(); return; }
					return uxcd.rename(name, nn).then(function(ok) { if (ok) { ui.hideModal(); return self.refresh(); } });
				}) }, _('Rename'))
			])
		]);
	},

	// open an in-browser shell (ttyd) into a running container, or show the uxe
	// command if ttyd is not installed. Binds ttyd to the browser-facing IP.
	openConsole: function(name) {
		var host = location.hostname;
		// only forward an IP literal as the bind address (a DNS name -> all
		// interfaces, firewall-gated); ttyd's -i takes an interface or IP.
		var bind = (/^[0-9.]+$/.test(host) || /^[0-9a-f:]+$/i.test(host)) ? host : '';
		var tls = (location.protocol == 'https:');   // serve the console over the same scheme as this page
		return uxcd.console(name, bind, tls).then(function(r) {
			if (!r || !r.port) {
				ui.showModal(_('Console') + ': ' + name, [
					E('p', (r && r.command)
						? _('ttyd is not installed - run this in a terminal:')
						: _('Could not open a console: %s').format((r && r.error) || _('unknown error'))),
					(r && r.command) ? E('pre', { 'style': 'user-select:all' }, r.command) : E('div'),
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
				]);
				return;
			}
			// embed ttyd in the SAME tab, scheme matching the LuCI page (https reuses the
			// LuCI cert -> no mixed content; http needs no self-signed-cert exception). No
			// auth -> works in Safari, which breaks on basic-auth-over-WS. The poll closes
			// the modal when the one-shot session exits - same tab, so no Chrome bg-tab
			// throttling and no tab to close.
			var url = (r.scheme || 'http') + '://' + host + ':' + r.port + '/';
			var iv;
			var stop = function() { if (iv) { clearInterval(iv); iv = null; } };
			var modal = ui.showModal(_('Console') + ': ' + name, [
				E('iframe', { 'src': url, 'style': 'width:100%;height:70vh;border:0;border-radius:3px' }),
				E('div', { 'class': 'right', 'style': 'margin-top:.5em' }, [
					E('span', { 'style': 'float:left;color:#888;font-size:90%' }, _('Type %s to close. Unauthenticated terminal.').format('exit')),
					E('button', { 'class': 'btn', 'click': function() { stop(); ui.hideModal(); } }, _('Close'))
				])
			], 'cbi-modal');
			iv = setInterval(function() {
				uxcd.consoleActive(r.port).then(function(active) {
					if (!active) { stop(); if (modal && document.body.contains(modal)) ui.hideModal(); }
				});
			}, 2000);
		});
	},

	// a small globe button that opens the container's web UI(s) in a new tab.
	webBtn: function(c) {
		var self = this, name = c.name, ports = c.web_ports;
		var one = ports.length === 1;
		var b = E('button', {
			'class': 'btn cbi-button',
			'style': 'padding:.05em .35em;line-height:1',
			'title': one ? _('Open %s (port %d)').format(ports[0].label || _('web UI'), ports[0].port)
			             : _('Open web UI (%d services)').format(ports.length),
			'click': ui.createHandlerFn(self, function() { return self.openWebUI(name, ports); })
		});
		b.innerHTML = SVG_GLOBE;
		return b;
	},

	// resolve the container IP (netns addr, else the browser host for host-net) and
	// open the web UI; a single port goes straight to a new tab, several show a picker.
	// uxcd does no port mapping - reaching the IP:port is the admin's routing/firewall job.
	openWebUI: function(name, ports) {
		function go(host, p) {
			window.open((p.scheme || 'http') + '://' + host + ':' + p.port + (p.path || '/'), '_blank', 'noopener');
		}
		return uxcd.info(name).then(function(d) {
			var host = (d && d.ipaddr && d.ipaddr.length) ? d.ipaddr[0] : location.hostname;
			if (ports.length === 1) { go(host, ports[0]); return; }
			ui.showModal(_('Web UI') + ': ' + name, [
				E('p', _('Open which service?')),
				E('div', {}, ports.map(function(p) {
					return E('div', { 'style': 'margin:.4em 0' }, E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'click': function() { ui.hideModal(); go(host, p); }
					}, (p.label || (_('Port') + ' ' + p.port)) + '  —  ' + (p.scheme || 'http') + '://' + host + ':' + p.port + (p.path || '/')));
				})),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		});
	},

	// progress modal for a docker2uxcd job: polls its log until it finishes.
	watchJob: function(id) {
		var self = this;
		var pre    = E('pre', { 'style': 'max-height:24em;overflow:auto;white-space:pre-wrap' }, _('starting...'));
		var status = E('p', {}, _('Running...'));
		var pollFn;
		// plain handler (not createHandlerFn, which re-enables the button when the
		// fast jobCancel resolves): disable on click and STAY disabled - the poll
		// loop reflects the cancelling/cancelled state from here on.
		var cancelBtn = E('button', { 'class': 'btn cbi-button-negative',
			'click': function() {
				if (cancelBtn.disabled) return;
				cancelBtn.disabled = true;
				status.textContent = _('Cancelling...');
				uxcd.jobCancel(id);
			} }, _('Cancel job'));
		function stop() { if (pollFn) poll.remove(pollFn); ui.hideModal(); }
		pollFn = function() {
			return uxcd.jobLog(id, 300).then(function(r) {
				if (r && r.error) {   // job no longer tracked (reaped, or daemon restarted)
					poll.remove(pollFn);
					cancelBtn.disabled = true;
					status.textContent = _('Job no longer tracked (%s).').format(r.error);
					return;
				}
				var lines = (r && r.lines) || [];
				pre.textContent = lines.length ? lines.join('\n') : _('(no output yet)');
				pre.scrollTop = pre.scrollHeight;
				if (r && r.cancelled && r.running) { status.textContent = _('Cancelling...'); cancelBtn.disabled = true; }
				if (r && r.running === false) {
					poll.remove(pollFn);
					cancelBtn.disabled = true;   // job finished (done/failed/cancelled) - nothing left to cancel
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
				// Close first so Escape (triggers the first button) closes the modal
				// rather than cancelling the running job.
				E('button', { 'class': 'btn', 'click': stop }, _('Close')), ' ',
				cancelBtn
			])
		]);
		poll.add(pollFn, 2);
		pollFn();
	},

	// "Pull image": fetch + convert a registry image, then register it (async job).
	openPull: function() {
		var self = this;
		uxcd.listProfiles().then(function(profiles) {
			var wImage = new ui.Textfield('', { placeholder: 'docker.io/library/nginx:alpine' });
			var wName  = new ui.Textfield('', { placeholder: _('optional; derived from the image if empty') });
			var wInfra = self.infraWidget('');
			var wAuto  = new ui.Checkbox('0');
			var choices = { '': _('(none)') };
			(profiles || []).forEach(function(p) { choices[p] = p; });
			var wProfile = new ui.Select('', choices, { widget: 'select' });
			ui.showModal(_('Pull image'), [
				E('p', { 'class': 'cbi-section-descr' },
					_('Fetch and convert a registry image, then register it.')),
				self.field(_('Image'), wImage, _('Registry reference, e.g. docker.io/library/nginx:alpine.')),
				self.field(_('Name'), wName),
				self.field(_('Profile'), wProfile, _('Optional profiles/<name>.json overlay applied to the bundle config (e.g. frigate).')),
				self.field(_('Network (infra)'), wInfra),
				self.field(_('Start on boot'), wAuto),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							var image = (wImage.getValue() || '').trim();
							if (!image) { uxcd.notify(null, E('p', _('Image is required.')), 'warning'); return; }
							return uxcd.pull({ image: image, name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1', profile: wProfile.getValue() })
								.then(function(res) {
									if (res && res.error) { uxcd.notify(null, E('p', _('pull failed: %s').format(res.error)), 'danger'); return; }
									if (res && res.job) self.watchJob(res.job);
								});
						})
					}, _('Pull'))
				])
			]);
		});
	},

	// "Build Dockerfile": build a single-stage host-arch image (no Docker daemon).
	openBuild: function() {
		var self = this;
		uxcd.listProfiles().then(function(profiles) {
			var wDf    = new ui.Textfield('', { placeholder: '/root/myapp/Dockerfile' });
			var wCtx   = new ui.Textfield('', { placeholder: _('build context dir (optional)') });
			var wName  = new ui.Textfield('');
			var wInfra = self.infraWidget('');
			var wAuto  = new ui.Checkbox('0');
			var choices = { '': _('(none)') };
			(profiles || []).forEach(function(p) { choices[p] = p; });
			var wProfile = new ui.Select('', choices, { widget: 'select' });
			ui.showModal(_('Build from Dockerfile'), [
				E('p', { 'class': 'cbi-section-descr' },
					_('Build a single-stage, host-architecture image from a Dockerfile (no Docker daemon).')),
				self.field(_('Dockerfile'), wDf, _('Path to the Dockerfile on this device.')),
				self.field(_('Context'), wCtx, _('Directory for COPY/ADD; defaults to the Dockerfile directory.')),
				self.field(_('Name'), wName),
				self.field(_('Profile'), wProfile, _('Optional profiles/<name>.json overlay applied to the bundle config.')),
				self.field(_('Network (infra)'), wInfra),
				self.field(_('Start on boot'), wAuto),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							var df = (wDf.getValue() || '').trim();
							if (!df) { uxcd.notify(null, E('p', _('Dockerfile path is required.')), 'warning'); return; }
							return uxcd.build({ dockerfile: df, context: wCtx.getValue(), name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1', profile: wProfile.getValue() })
								.then(function(res) {
									if (res && res.error) { uxcd.notify(null, E('p', _('build failed: %s').format(res.error)), 'danger'); return; }
									if (res && res.job) self.watchJob(res.job);
								});
						})
					}, _('Build'))
				])
			]);
		});
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
							uxcd.notify(null, E('p', _('Name and bundle path are required.')), 'warning');
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
	// row editor for web_ports: [{ port, label?, scheme?, path? }]. Returns
	// { node, read() } like scheduleWidget so openEditor places + collects it.
	webPortsWidget: function(ports) {
		var rows = E('div', {});
		function addRow(p) {
			p = p || {};
			var port   = new ui.Textfield(p.port != null ? String(p.port) : '', { placeholder: _('port'), maxlength: 5, datatype: 'port' });
			var label  = new ui.Textfield(p.label || '', { placeholder: _('label') });
			var scheme = new ui.Select(p.scheme || 'http', { 'http': 'http', 'https': 'https' }, { widget: 'select' });
			var path   = new ui.Textfield(p.path || '', { placeholder: _('path /') });
			// two compact lines per port: [port][label] then [scheme][path], with port and
			// scheme the same narrow width (a port is <=5 digits, a scheme is http/https -
			// neither needs a full-width field). An <hr> ends each port block so they read
			// as distinct entries (and sets a lone port apart from the + add button).
			var COL = 'flex:0 0 6em', GROW = 'flex:1 1 auto';
			var row = E('div', { 'style': 'margin:.2em 0 .4em' }, [
				E('div', { 'style': 'display:flex;gap:.4em;align-items:center;margin-bottom:.3em' }, [
					E('div', { 'style': COL }, port.render()),
					E('div', { 'style': GROW }, label.render()),
					E('button', { 'class': 'btn cbi-button cbi-button-remove', 'style': 'flex:0 0 auto', 'click': function() { rows.removeChild(row); } }, '✕')
				]),
				E('div', { 'style': 'display:flex;gap:.4em;align-items:center' }, [
					E('div', { 'style': COL }, scheme.render()),
					E('div', { 'style': GROW }, path.render())
				]),
				E('hr', { 'style': 'margin:.5em 0 0' })
			]);
			row._port = port; row._label = label; row._scheme = scheme; row._path = path;
			rows.appendChild(row);
		}
		(ports || []).forEach(addRow);
		return {
			node: E('div', {}, [
				rows,
				E('button', { 'class': 'btn cbi-button', 'click': function() { addRow(); } }, _('+ add web UI'))
			]),
			read: function() {
				var out = [];
				Array.prototype.forEach.call(rows.childNodes, function(row) {
					if (!row._port) return;
					var pt = parseInt((row._port.getValue() || '').trim(), 10);
					if (!pt || pt < 1 || pt > 65535) return;
					var o = { port: pt };
					var l = (row._label.getValue() || '').trim();  if (l) o.label = l;
					var sc = row._scheme.getValue();               if (sc && sc != 'http') o.scheme = sc;
					var pa = (row._path.getValue() || '').trim();   if (pa && pa != '/') o.path = pa;
					out.push(o);
				});
				return out;
			}
		};
	},

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
				uxcd.notify(null, E('p', (cfg && cfg.error) || _('cannot load config')), 'danger');
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
			var wWeb      = self.webPortsWidget(cfg.web_ports || []);
			var wAutoUpg  = new ui.Checkbox(cfg.auto_upgrade ? '1' : '0');
			// --- A-cluster compatibility knobs ---
			var wUser    = new ui.Textfield(cfg.user || '', { placeholder: 'uid[:gid][,gid...]' });
			var wStopSig = new ui.Textfield(cfg.stop_signal || '', { placeholder: 'SIGTERM (default)' });
			var wStopGr  = new ui.Textfield(cfg.stop_grace != null ? String(cfg.stop_grace) : '', { placeholder: _('seconds (default 5)') });
			var wShm     = new ui.Textfield(cfg.shm_size || '', { placeholder: '256m' });
			var wTmpfs   = new ui.DynamicList(cfg.tmpfs || [], null, { placeholder: '/run:16m' });
			var wEnvFile = new ui.DynamicList(cfg.env_file || [], null, { placeholder: '/etc/uxc/app.env' });
			// rlimits: JSON [{type,soft,hard}] <-> "TYPE=soft:hard" strings
			var rlimList = (cfg.rlimits || []).map(function(r) { return r.type + '=' + (r.soft != null ? r.soft : '') + ':' + (r.hard != null ? r.hard : ''); });
			var wRlim    = new ui.DynamicList(rlimList, null, { placeholder: 'RLIMIT_NOFILE=4096:8192' });
			// sysctl: {key:val} <-> "key=val" strings
			var sysList  = Object.keys(cfg.sysctl || {}).map(function(k) { return k + '=' + cfg.sysctl[k]; });
			var wSysctl  = new ui.DynamicList(sysList, null, { placeholder: 'net.core.somaxconn=1024' });

			ui.showModal(_('Configure') + ': ' + name, [
				self.tabs([
					{ title: _('General'), fields: [
						self.field(_('Start on boot'), wAuto),
						self.field(_('Auto-restart (respawn)'), wRespawn),
						self.field(_('Stop signal'), wStopSig, _('Signal sent to stop the container (e.g. SIGINT, SIGQUIT, or a number); default SIGTERM. Postgres wants SIGINT, nginx SIGQUIT.')),
						self.field(_('Stop grace'), wStopGr, _('Seconds to wait before SIGKILL/cgroup-kill (default 5).')),
						self.field(_('Network (infra)'), wInfra, _('Network namespace to join. "Host (shared)" puts the container on ALL host interfaces incl. WAN - prefer a netns to isolate.')),
						E('div', { 'class': 'cbi-value' }, [
							E('label', { 'class': 'cbi-value-title' }, _('Web UIs')),
							E('div', { 'class': 'cbi-value-field' }, [
								wWeb.node,
								E('div', { 'class': 'cbi-value-description' }, _('Web interfaces this container serves - a globe button in the overview opens http(s)://<container-ip>:<port><path>. uxcd does no port mapping; reaching it is your routing/firewall job.'))
							])
						]),
						self.field(_('Overlay path'), wOvPath, _('Persistent read-write overlay directory (optional).')),
						self.field(_('Overlay size'), wOvSize, _('tmpfs overlay size, e.g. 64M (optional).')),
						E('hr', { 'style': 'margin:1.2em 0 .6em' }),
						E('div', {}, [
							E('button', {
								'class': 'btn cbi-button',
								'click': ui.createHandlerFn(self, function() { return self.confirmRename(name); })
							}, _('Rename')),
							' ',
							E('button', {
								'class': 'btn cbi-button cbi-button-negative',
								'click': ui.createHandlerFn(self, function() { return self.confirmRemove(name); })
							}, _('Remove container')),
							E('span', { 'style': 'margin-left:.6em;color:#999' }, _('Permanently remove this container from uxcd.'))
						])
					] },
					{ title: _('Storage'), fields: [
						self.field(_('Volumes'), wVols, _('Bind mounts as src:dst[:ro].')),
						self.field(_('/dev/shm size'), wShm, _('Sized /dev/shm tmpfs, e.g. 256m (Chromium/Frigate/Postgres). Empty = ujail default.')),
						self.field(_('tmpfs mounts'), wTmpfs, _('Extra tmpfs mounts as dest:size, e.g. /run:16m. Replaces any same-path default.')),
						self.field(_('Required mounts'), wMounts, _('Host paths that must be mounted before this container starts (e.g. external storage holding its volumes).')),
						self.field(_('Devices'), wDevs, _('Device node paths; each gets a node + cgroup allow.')),
					] },
					{ title: _('Runtime'), fields: [
						self.field(_('Environment'), wEnv),
						self.field(_('Env files'), wEnvFile, _('Files of KEY=VALUE lines loaded at launch (inline Environment above wins on conflict).')),
						self.field(_('Resource limits'), wRlim, _('Per-type ulimits as TYPE=soft:hard, e.g. RLIMIT_NOFILE=4096:8192 or RLIMIT_MEMLOCK=infinity:infinity.')),
						self.field(_('Sysctls'), wSysctl, _('Kernel sysctls as key=value. net.* requires an infra netns (refused in host-net mode to protect the router).')),
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
						self.field(_('Run as user'), wUser, _('Override the image USER as uid[:gid][,gid...] (numeric). Fixes bind-mount ownership; extra gids add supplementary groups (e.g. render/video for GPU).')),
						self.field(_('Drop capabilities'), wCapDrop, _('"ALL" drops everything, then add back below.')),
						self.field(_('Add capabilities'), wCapAdd),
						self.field(_('Seccomp'), wSeccomp, _("OCI profile path; \"unconfined\" disables filtering.")),
					self.field(_('No new privileges'), wNoNewPriv, _('Block setuid/privilege gain (OCI noNewPrivileges). Uncheck only for privileged workloads.')),
					] },
					{ title: _('Schedule'), fields: [
						self.field(_('Auto-upgrade'), wAutoUpg, _('When the daemon-wide scheduled update check (Settings → Safe-update) finds a new image, upgrade this container automatically via the health-gated safe-update (rolls back if the new image does not become healthy, when a healthcheck is defined). Off = notify only. Good for e.g. a web/PHP server; leave off for a dev container you do not want changing silently.')),
						E('hr', { 'style': 'margin:1em 0' }),
						E('p', { 'class': 'cbi-section-descr' }, _('Cron-driven actions run by the uxcd scheduler (host local time). Fields: minute hour day-of-month month day-of-week. Examples: "0 3 * * *" = 03:00 daily; "0 2 * * 0" = Sun 02:00; "*/30 * * * *" = every 30 min.')),
						wSched.node
					] },
				]),

				E('div', { 'class': 'right' }, [
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
							setOrDel('web_ports', wWeb.read());
							if (wAutoUpg.getValue() == '1') cfg.auto_upgrade = true; else delete cfg.auto_upgrade;
							// A-cluster knobs
							if (wUser.getValue().trim()) cfg.user = wUser.getValue().trim(); else delete cfg.user;
							if (wStopSig.getValue().trim()) cfg.stop_signal = wStopSig.getValue().trim(); else delete cfg.stop_signal;
							var sg = parseInt(wStopGr.getValue(), 10); if (!isNaN(sg) && sg > 0) cfg.stop_grace = sg; else delete cfg.stop_grace;
							if (wShm.getValue().trim()) cfg.shm_size = wShm.getValue().trim(); else delete cfg.shm_size;
							setOrDel('tmpfs', list(wTmpfs));
							setOrDel('env_file', list(wEnvFile));
							// rlimits: "TYPE=soft:hard" -> [{type,soft,hard}]
							var rl = list(wRlim).map(function(s) {
								var eq = s.indexOf('='); if (eq < 0) return null;
								var type = s.slice(0, eq).trim(); if (!type) return null;
								var sh = s.slice(eq + 1).split(':'), o = { type: type };
								if (sh[0] != null && sh[0].trim() !== '') o.soft = (sh[0].trim() === 'infinity') ? 'infinity' : parseInt(sh[0], 10);
								var h = (sh[1] != null && sh[1].trim() !== '') ? sh[1].trim() : (sh[0] || '').trim();
								if (h !== '') o.hard = (h === 'infinity') ? 'infinity' : parseInt(h, 10);
								return o;
							}).filter(Boolean);
							if (rl.length) cfg.rlimits = rl; else delete cfg.rlimits;
							// sysctl: "key=value" -> {key:value}
							var sc = {}; list(wSysctl).forEach(function(s) { var eq = s.indexOf('='); if (eq > 0) sc[s.slice(0, eq).trim()] = s.slice(eq + 1).trim(); });
							if (Object.keys(sc).length) cfg.sysctl = sc; else delete cfg.sysctl;
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
								catch (e) { uxcd.notify(null, E('p', _('Healthcheck "Checks" must be valid JSON: %s').format(e)), 'danger'); return; }
								if (!Array.isArray(hcChecks)) { uxcd.notify(null, E('p', _('Healthcheck "Checks" must be a JSON array.')), 'danger'); return; }
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
								// Only some fields need a restart (the daemon decides via
								// config_changed); live edits like web UIs apply at once.
								uxcd.info(name).then(function(n) {
									uxcd.notify(null, E('p', (n && n.config_changed)
										? _('Saved. Restart %s to apply the changes.').format(name)
										: _('Saved - applied to %s.').format(name)), 'info');
								});
								return self.refresh();
							});
						})
					}, _('Save'))
				])
			]);
		}).catch(function(e) {
			uxcd.notify(null, E('p', 'uxcd editor: ' + (e && (e.stack || e.message) || e)), 'danger');
		});
	},

	// Sort the container list by the current column. Session-only (resets on reload).
	// Numeric columns keep stopped containers at the bottom either way; Status ranks
	// worst-first (a crashed/unhealthy container floats up where it gets noticed).
	sortContainers: function(containers, pcts) {
		var self = this, f = self._sortField, mul = (self._sortDir === 'asc') ? 1 : -1;
		function sev(c) {
			if (c.fault && !c.running) return 0;       // crashed (e.g. port already in use)
			if (c.oom_killed && !c.running) return 1;  // OOM-killed
			if (!c.running) return 2;                   // stopped / exited
			if (c.health === 'unhealthy') return 3;
			if (c.upgrading || c.health === 'starting') return 4;
			return 5;                                   // running, healthy/unknown
		}
		function byName(a, b) { return (a.name || '').localeCompare(b.name || ''); }
		var out = containers.slice();
		out.sort(function(a, b) {
			if (f === 'name')   return mul * byName(a, b);
			if (f === 'status') { var ds = sev(a) - sev(b); return ds ? mul * ds : byName(a, b); }
			// numeric columns: stopped containers always sink below running ones
			if (!a.running && !b.running) return byName(a, b);
			if (!a.running) return 1;
			if (!b.running) return -1;
			var va, vb;
			if (f === 'memory')   { va = a.memory || 0;       vb = b.memory || 0; }
			else if (f === 'cpu') { va = pcts[a.name] || 0;   vb = pcts[b.name] || 0; }
			else                  { va = a.pids || 0;         vb = b.pids || 0; }   // pids
			var d = va - vb;
			return d ? mul * d : byName(a, b);
		});
		return out;
	},

	// Header click: same column toggles direction; a new column gets a sensible default
	// (name/status ascending, numeric columns descending = biggest first). Re-renders
	// from the cached list, no refetch.
	sortBy: function(field) {
		var self = this;
		if (self._sortField === field)
			self._sortDir = (self._sortDir === 'asc') ? 'desc' : 'asc';
		else {
			self._sortField = field;
			self._sortDir = (field === 'name' || field === 'status') ? 'asc' : 'desc';
		}
		var el = document.getElementById('uxcd-table');
		if (el) dom.content(el, self.tableContent(self._containers || []));
	},

	tableContent: function(containers) {
		var self = this;
		self._containers = containers;   // keep for re-sort on header click (no refetch)

		// CPU% carries delta state, so sample it once per container here; both the sort
		// comparator and the rows read from this map (calling cpuPct in both would
		// double-sample inside the <2s reuse window and skew the figure).
		var pcts = {};
		containers.forEach(function(c) { pcts[c.name] = self.cpuPct(c.name, c.cpu_usec || 0); });
		var sorted = self.sortContainers(containers, pcts);

		function th(field, label) {
			var arrow = (self._sortField === field) ? (self._sortDir === 'asc' ? ' ▲' : ' ▼') : '';
			return E('div', { 'class': 'th', 'style': 'cursor:pointer;user-select:none', 'click': ui.createHandlerFn(self, 'sortBy', field) }, label + arrow);
		}

		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			th('name', _('Name')),
			th('status', _('Status')),
			th('memory', _('Memory')),
			th('cpu', _('CPU')),
			th('pids', _('PIDs')),
			E('div', { 'class': 'th' }, _('Network')),
			E('div', { 'class': 'th cbi-section-actions' }, _('Actions'))
		]) ];

		if (!sorted.length) {
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No containers registered.')))));
			return rows;
		}

		sorted.forEach(function(c) {
			var pct = pcts[c.name];
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
						(c.fault && !c.running) ? E('span', { 'style': 'margin-left:.4em;cursor:help', 'title': c.fault }, uxcd.badge(_('port in use'), 'down')) : '',
					c.last_update == 'rolled_back' ? E('span', { 'style': 'margin-left:.4em', 'title': _('Auto-rolled back: the updated image did not become healthy') }, uxcd.badge(_('rolled back'), 'down')) : '',
					(c.running && c.web_ports && c.web_ports.length) ? E('span', { 'style': 'margin-left:.5em' }, self.webBtn(c)) : ''
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
			// drop CPU-sampling state for containers that no longer exist (avoid a
			// slow map leak + a stale delta if the name is later reused)
			var live = {};
			containers.forEach(function(c) { live[c.name] = true; });
			Object.keys(self.cpuPrev).forEach(function(n) {
				if (!live[n]) { delete self.cpuPrev[n]; delete self.cpuLast[n]; }
			});
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
				uxcd.notify(null, E('p', n.error), 'danger');
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
				(n.fault && !n.running) ? row(_('Likely cause'), n.fault) : null,
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
				}))) : null,
				n.auto_upgrade ? row(_('Auto-upgrade'), _('on scheduled update check')) : null
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
			if (n.running && self._consoleEnabled)
				actions.push(' ', E('button', {
					'class': 'btn cbi-button',
					'title': _('Open a browser terminal inside this container (unauthenticated TLS ttyd, in a modal)'),
					'click': ui.createHandlerFn(self, function() { return self.openConsole(name); })
				}, _('Console')));
			if (n.update_available && !n.upgrading)
				actions.push(' ', E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						return uxcd.upgrade(name).then(function(res) {
							if (res && res.error) { uxcd.notify(null, E('p', _('upgrade failed: %s').format(res.error)), 'danger'); return; }
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
					{ title: _('Exec'), fields: [
						E('div', { 'style': 'margin-bottom:.5em' }, [
							E('input', { 'id': 'uxcd-exec-cmd', 'type': 'text', 'placeholder': 'nginx -t', 'style': 'width:65%', 'keydown': function(ev) { if (ev.keyCode === 13) ev.target.parentNode.querySelector('button').click(); } }),
							' ',
							E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': function() {
								var c = (document.getElementById('uxcd-exec-cmd').value || '').trim();
								var out = document.getElementById('uxcd-exec-out');
								if (!c) return;
								out.textContent = _('running...');
								uxcd.exec(name, ['/bin/sh', '-c', c], 30).then(function(r) {
									if (r.error) { out.textContent = 'error: ' + r.error; return; }
									out.textContent = (r.output || '') + '\n[exit ' + (r.exit_code != null ? r.exit_code : '?') + (r.timed_out ? ', timed out' : '') + ']';
								});
							} }, _('Run'))
						]),
						E('p', { 'style': 'color:#888;font-size:90%' }, _('Runs as root in the container via /bin/sh -c (30s timeout). The same power as the console, scriptable.')),
						E('pre', { 'id': 'uxcd-exec-out', 'style': 'max-height:18em;overflow:auto;white-space:pre-wrap' }, '')
					] },
					{ title: _('Log'), fields: [
				E('div', { 'style': 'margin-bottom:.5em' }, [
					E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, function() {
						return uxcd.logClear(name).then(function() { var el = document.getElementById('uxcd-detail-log'); if (el) el.textContent = _('(no log output)'); });
					}) }, _('Clear log')),
					' ',
					E('button', { 'class': 'btn cbi-button', 'click': function() {
						// full retained buffer over one authenticated rpc -> client-side download
						return uxcd.log(name, 0).then(function(r) {
							var txt = ((r && r.lines) || []).join('\n') + '\n';
							var url = URL.createObjectURL(new Blob([txt], { 'type': 'text/plain' }));
							var a = E('a', { 'href': url, 'download': name + '.log' });
							document.body.appendChild(a); a.click(); document.body.removeChild(a);
							URL.revokeObjectURL(url);
						});
					} }, _('Download'))
				]),
				E('pre', { 'id': 'uxcd-detail-log', 'style': 'max-height:20em;overflow:auto;white-space:pre-wrap' },
					lines.length ? lines.join('\n') : _('(no log output)')),
					] }
				]),
				E('div', { 'class': 'right' }, [
					E('span', { 'style': 'float:left' }, actions),
					E('button', { 'class': 'btn', 'click': function() {
						if (self._detailFollow) { poll.remove(self._detailFollow); self._detailFollow = null; }
						ui.hideModal();
					} }, _('Close'))
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
								uxcd.notify(null, prov === 0
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
