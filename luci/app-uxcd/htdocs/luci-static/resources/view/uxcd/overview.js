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

return view.extend({
	// name -> { cpu: <usec>, t: <ms> } for sampling %CPU between polls
	cpuPrev: {},
	// name -> { mem: [bytes...], cpu: [pct...] } ring buffers for the detail sparklines.
	// Browser-side only (resets on reload) - filled by the overview refresh loop, like
	// OpenWrt's own live traffic charts that start drawing when you open the page.
	statsHist: {},
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

	STATS_MAX: 120,   // ~10 min of history at the 5s refresh cadence
	// Append one memory/CPU sample per container to its ring (called each refresh, after
	// tableContent has already sampled cpuPct so cpuLast is current). Prunes gone names.
	recordStats: function(containers) {
		var self = this, live = {};
		self.runByName = self.runByName || {};
		containers.forEach(function(c) {
			live[c.name] = true;
			self.runByName[c.name] = !!c.running;
			var h = self.statsHist[c.name] || (self.statsHist[c.name] = { mem: [], cpu: [] });
			h.mem.push(c.running ? (c.memory || 0) : 0);
			h.cpu.push(c.running ? (self.cpuLast[c.name] || 0) : 0);
			if (h.mem.length > self.STATS_MAX) h.mem.shift();
			if (h.cpu.length > self.STATS_MAX) h.cpu.shift();
		});
		Object.keys(self.statsHist).forEach(function(n) { if (!live[n]) delete self.statsHist[n]; });
	},

	// Render a ring buffer as an inline SVG sparkline string (+ now/peak label). Scaled
	// min..max so variation is visible; the label carries the absolute values. Returns a
	// "collecting…" note until there are at least two samples.
	sparkSVG: function(values, opts) {
		opts = opts || {};
		var vals = (values || []).filter(function(v) { return v != null && !isNaN(v); });
		if (vals.length < 2)
			return '<span style="opacity:.6">' + _('collecting…') + '</span>';
		var w = opts.width || 200, h = opts.height || 40, pad = 3;
		var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
		var flat = (mx === mn), range = (mx - mn) || 1;
		var n = vals.length, iw = w - pad * 2, ih = h - pad * 2;
		var pts = vals.map(function(v, i) {
			var x = pad + (i / (n - 1)) * iw;
			var y = flat ? (pad + ih / 2) : (pad + ih - ((v - mn) / range) * ih);   // flat series -> centered line, not glued to the bottom
			return x.toFixed(1) + ',' + y.toFixed(1);
		}).join(' ');
		var fmt = (opts.unit === 'bytes') ? uxcd.fmtBytes : function(v) { return Math.round(v) + '%'; };
		var color = opts.color || '#4a90d9';
		// label peak = the ring's max, floored to an all-time peak (e.g. cgroup
		// memory.peak) when given, so "peak" keeps history the ~10-min ring dropped
		// and can never read below "now".
		var peak = (opts.floorPeak != null) ? Math.max(mx, opts.floorPeak) : mx;
		var area = pad + ',' + (h - pad) + ' ' + pts + ' ' + (pad + iw).toFixed(1) + ',' + (h - pad);
		return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="vertical-align:middle;width:' + w + 'px;max-width:100%">' +
			'<polygon points="' + area + '" fill="' + color + '" opacity="0.12"/>' +
			'<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.4"/>' +
			'</svg>' +
			'<span style="margin-left:.6em;opacity:.8">' + _('now') + ' ' + fmt(vals[n - 1]) + ' · ' + _('peak') + ' ' + fmt(peak) + '</span>';
	},

	actionButtons: function(c, compact) {
		var self = this;
		// mid-upgrade the container is locked (the daemon refuses lifecycle/config
		// actions anyway) - show the state instead of buttons that would just error
		if (c.upgrading)
			return [ E('em', { 'style': 'color:#888' }, _('upgrading…')) ];
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
				hint ? E('div', { 'class': 'cbi-value-description', 'style': 'padding-top:.5em' }, hint) : ''
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

	// Prompt to restart a container after an edit whose fields only take effect on
	// relaunch (the daemon flags this via config_changed). "Restart now" relaunches
	// it; "Restart later" dismisses - the ⟳ badge / "Pending" row stay as reminders.
	confirmRestart: function(name) {
		var self = this;
		ui.showModal(_('Restart to apply'), [
			E('p', {}, _('Some changes to %s take effect only when the container restarts.').format(name)),
			E('p', { 'style': 'color:#888;font-size:90%;margin-top:.3em' },
				_('Restart now, or later - the ⟳ badge marks it pending until you do.')),
			E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
				E('button', { 'class': 'btn', 'click': function() { ui.hideModal(); } }, _('Restart later')),
				' ',
				E('button', { 'class': 'btn cbi-button cbi-button-action', 'click': ui.createHandlerFn(self, function() {
					return uxcd.action('restart', name).then(function() {
						ui.hideModal();
						return self.refresh();
					});
				}) }, _('Restart now'))
			])
		]);
	},

	// A reference list of Linux capability names (for the Drop/Add fields), shown as a
	// self-managed overlay ON TOP of the editor modal so opening it doesn't discard the
	// user's edits (ui.showModal would replace the current modal). Close returns to the
	// editor untouched. Esc / backdrop click also close it.
	capsReference: function() {
		var groups = [
			{ g: _('Files & ownership'), items: [
				['CAP_CHOWN', _('change file UID/GID ownership')],
				['CAP_DAC_OVERRIDE', _('bypass file read/write/execute permission checks')],
				['CAP_DAC_READ_SEARCH', _('bypass file-read and directory-search checks')],
				['CAP_FOWNER', _('bypass owner checks (chmod, utime, …) on any file')],
				['CAP_FSETID', _('keep setuid/setgid bits across file edits')],
				['CAP_MKNOD', _('create device / special files (mknod)')],
				['CAP_LEASE', _('take file leases')],
				['CAP_SETFCAP', _('set capabilities on files')]
			]},
			{ g: _('Processes & IDs'), items: [
				['CAP_KILL', _('send signals to any process')],
				['CAP_SETUID', _('change UIDs (setuid)')],
				['CAP_SETGID', _('change GIDs and supplementary groups')],
				['CAP_SETPCAP', _('grant or drop capabilities to others')],
				['CAP_SYS_PTRACE', _('trace / inspect other processes (ptrace)')],
				['CAP_SYS_NICE', _('raise scheduling priority / set CPU affinity')],
				['CAP_SYS_RESOURCE', _('exceed resource limits and quotas')]
			]},
			{ g: _('Network'), items: [
				['CAP_NET_BIND_SERVICE', _('bind to privileged ports (<1024)')],
				['CAP_NET_RAW', _('raw and packet sockets (ping, sniffing)')],
				['CAP_NET_ADMIN', _('configure interfaces, routes, firewall')],
				['CAP_NET_BROADCAST', _('send broadcast / multicast')]
			]},
			{ g: _('System'), items: [
				['CAP_SYS_ADMIN', _('broad admin: mount, sethostname, many syscalls — very powerful, and what lets a container remount the root writable')],
				['CAP_SYS_CHROOT', _('use chroot()')],
				['CAP_SYS_BOOT', _('reboot the host')],
				['CAP_SYS_MODULE', _('load / unload kernel modules')],
				['CAP_SYS_RAWIO', _('raw I/O ports and /dev/mem')],
				['CAP_SYS_TIME', _('set the system clock')],
				['CAP_SYS_PACCT', _('toggle process accounting')],
				['CAP_SYS_TTY_CONFIG', _('configure tty devices')],
				['CAP_SYSLOG', _('privileged syslog / kernel address access')],
				['CAP_MAC_OVERRIDE', _('bypass MAC (AppArmor/SMACK) policy')],
				['CAP_MAC_ADMIN', _('configure MAC policy')],
				['CAP_AUDIT_WRITE', _('write kernel audit records')],
				['CAP_AUDIT_CONTROL', _('configure kernel auditing')],
				['CAP_IPC_LOCK', _('lock memory (mlock)')],
				['CAP_IPC_OWNER', _('bypass System V IPC ownership checks')],
				['CAP_BLOCK_SUSPEND', _('block system suspend')],
				['CAP_WAKE_ALARM', _('arm wake-from-suspend alarms')],
				['CAP_BPF', _('load BPF programs')],
				['CAP_PERFMON', _('performance monitoring (perf)')],
				['CAP_CHECKPOINT_RESTORE', _('checkpoint / restore process state')]
			]}
		];
		var body = [];
		groups.forEach(function(sec) {
			body.push(E('tr', {}, E('td', { 'colspan': 2, 'style': 'padding:.7em 0 .2em;font-weight:bold' }, sec.g)));
			sec.items.forEach(function(it) {
				body.push(E('tr', {}, [
					E('td', { 'style': 'padding:.1em .9em .1em 0;white-space:nowrap;font-family:monospace;vertical-align:top' }, it[0]),
					E('td', { 'style': 'padding:.1em 0;opacity:.75' }, it[1])
				]));
			});
		});
		var close;
		function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
		var overlay = E('div', {
			'style': 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100000;overflow:auto;padding:4vh 2vw'
		}, E('div', {
			'style': 'background:var(--background-color-high,#fff);color:var(--text-color-high,#333);' +
			         'border:1px solid var(--border-color-medium,#ccc);border-radius:4px;max-width:660px;' +
			         'margin:0 auto;padding:1em 1.3em;box-shadow:0 2px 14px rgba(0,0,0,.4)'
		}, [
			E('h3', { 'style': 'margin-top:0' }, _('Linux capabilities')),
			E('p', { 'style': 'opacity:.75;margin:.2em 0 .6em' }, _('Names for the Drop / Add capability lists. "ALL" in Drop removes everything; add back only what the container needs.')),
			E('table', { 'style': 'width:100%;border-collapse:collapse;font-size:92%' }, body),
			E('div', { 'class': 'right', 'style': 'margin-top:.9em' },
				E('button', { 'class': 'btn', 'click': function() { close(); } }, _('Dismiss')))
		]));
		close = function() {
			document.removeEventListener('keydown', onKey, true);
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
		};
		overlay.addEventListener('click', function(ev) { if (ev.target === overlay) close(); });
		document.addEventListener('keydown', onKey, true);
		document.body.appendChild(overlay);
	},

	// confirm + unregister a container (leaves the bundle directory in place).
	confirmRemove: function(name) {
		var self = this;
		ui.showModal(_('Remove container'), [
			E('br'),
			E('p', [_('Remove "%s" from uxcd - deletes its registry entry (/etc/uxc/%s.json).').format(name, name), E('br'), _('The bundle directory (image + data) is left untouched.'), E('br'), E('br')]),
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
		ui.showModal(_('Rename container'), [
			E('br'),
			E('p', [_('Rename a stopped container. The bundle directory is left as-is; depends_on references'), E('br'), _('in other containers are updated automatically to match with new name.'), E('br')]),
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
					E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Dismiss')))
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
					E('button', { 'class': 'btn', 'click': function() { stop(); ui.hideModal(); } }, _('Dismiss'))
				])
			], 'cbi-modal');
			iv = setInterval(function() {
				uxcd.consoleActive(r.port).then(function(active) {
					if (!active) { stop(); if (modal && document.body.contains(modal)) ui.hideModal(); }
				});
			}, 2000);
		});
	},

	// progress modal for a docker2uxcd job: polls its log until it finishes.
	watchJob: function(id, onDone) {
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
					else if (r.exit_code === 0) { status.textContent = _('Completed successfully.'); if (onDone) onDone(); self.refresh(); }
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
				E('button', { 'class': 'btn', 'click': stop }, _('Dismiss')), ' ',
				cancelBtn
			])
		]);
		poll.add(pollFn, 2);
		pollFn();
	},

	// "Upgrade to…": version/tag jump - pull an explicitly different ref for an
	// existing container through the same health-gated safe-update (auto-rollback
	// if the new version does not become healthy). Registry overrides carry over.
	openUpgradeTo: function(name, current) {
		var self = this;
		var wRef = new ui.Textfield(current || '', { placeholder: 'ghcr.io/blakeblackshear/frigate:0.18.0' });
		ui.showModal(_('Upgrade %s to…').format(name), [
			E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.1em;margin-bottom:1.5em' },
				_('Pull a different version/tag and restart through the health-gated safe-update. If the new version does not become healthy, it is rolled back automatically. Volumes, devices and other settings carry over.')),
			self.field(_('Image'), wRef, [_('Edit the tag, e.g.'), E('br'), _('…/frigate:0.17.2 → …/frigate:0.18.0')]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var ref = (wRef.getValue() || '').trim();
						if (!ref) { uxcd.notify(null, E('p', _('Image is required.')), 'warning'); return; }
						return uxcd.upgrade(name, ref).then(function(res) {
							if (res && res.error) { uxcd.notify(null, E('p', _('upgrade failed: %s').format(res.error)), 'danger'); return; }
							if (res && res.job) self.watchJob(res.job);
						});
					})
				}, _('Upgrade'))
			])
		]);
	},

	// "New container…": a light wizard - pick a base image + basic tools and it
	// composes a Dockerfile (the recipe, saved as <bundle>.Dockerfile: edit it
	// and rebuild to evolve the container), builds it, and maps plain-language
	// choices onto existing knobs (dev/cntrinit idle init, devices, autostart,
	// notes). The user finishes the box inside (console / uxe). NOTE: openCreate
	// is the "Add container" (existing bundle) modal - keep the names distinct.
	openWizard: function() {
		var self = this;
		uxcd.hostDevices().then(function(hd) {
			hd = hd || {};
			var BASES = [ 'alpine:latest', 'alpine:3.22', 'debian:bookworm-slim', 'debian:bookworm', 'ubuntu:24.04', 'ubuntu:22.04' ];
			var TOOLS = [
				{ label: 'git',         apk: 'git',        apt: 'git' },
				{ label: 'curl',        apk: 'curl',       apt: 'curl' },
				{ label: 'nano',        apk: 'nano',       apt: 'nano' },
				{ label: 'htop',        apk: 'htop',       apt: 'htop' },
				{ label: 'tmux',        apk: 'tmux',       apt: 'tmux' },
				{ label: 'python3',     apk: 'python3',    apt: 'python3' },
				{ label: _('build tools'), apk: 'build-base', apt: 'build-essential' }
			];
			var serial = hd.serial || [], apex = hd.apex || [];
			var wName    = new ui.Textfield('', { placeholder: 'devbox' });
			var wPurpose = new ui.Textfield('', { placeholder: _('what is this container for?') });
			var bch = {}; BASES.forEach(function(b) { bch[b] = b; });
			var wBase   = new ui.Select(BASES[0], bch, { widget: 'select' });
			var wCustom = new ui.Textfield('', { placeholder: _('(overrides the list, e.g. fedora:41)') });
			function cb(on) { return new ui.Checkbox(on ? '1' : '0'); }
			var tChecks = TOOLS.map(function() { return cb(false); });
			var wAwake = cb(true), wGpu = cb(false), wUsb = cb(false), wSer = cb(false),
			    wTun = cb(false), wApex = cb(false), wBoot = cb(false), wStart = cb(true);
			function devRow(label, w, avail, desc) {
				if (avail) return self.field(label, w, desc);
				// field() calls widget.render() - a plain DOM node would throw, so
				// compose the unavailable-device row directly
				return E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, label),
					E('div', { 'class': 'cbi-value-field' },
						E('em', { 'style': 'color:#888' }, _('(not detected on this device)')))
				]);
			}
			ui.showModal(_('New container'), [
				E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.1em;margin-bottom:1.5em' },
					_('Builds a starter container from a generated Dockerfile. The recipe is saved next to the bundle as <name>.Dockerfile - edit it and rebuild to evolve the container - and you finish the box by installing whatever else you need inside (Console / uxe).')),
				self.field(_('Name'), wName),
				self.field(_('Purpose'), wPurpose, _('Saved to the Notes tab.')),
				self.field(_('Base image'), wBase),
				self.field(_('Custom image'), wCustom, [_('Any registry ref; apk vs apt is'), E('br'), _('guessed from the name.')]),
				E('hr', { 'style': 'margin:.8em 0' }),
				E('p', { 'class': 'cbi-section-descr' }, _('Basic tools baked into the image:')),
				E('div', { 'style': 'display:grid;grid-template-columns:1fr 1fr;gap:.35em 1.2em;margin:0 0 .4em .2em' },
					TOOLS.map(function(t, i) {
						return E('div', { 'style': 'display:flex;align-items:center;gap:.5em' },
							[ tChecks[i].render(), E('span', {}, t.label) ]);
					})),
				E('hr', { 'style': 'margin:.8em 0' }),
				devRow(_('GPU acceleration'), wGpu, hd.gpu, _('/dev/dri (VA-API etc.)')),
				devRow(_('USB devices'), wUsb, hd.usb, [_('/dev/bus/usb as a live bind -'), E('br'), _('USB Coral, dongles, …')]),
				devRow(_('Serial stick'), wSer, serial.length > 0, serial.length ? _('Zigbee/Z-Wave etc.: %s').format(serial.join(', ')) : ''),
				devRow(_('VPN support'), wTun, hd.tun, _('/dev/net/tun (WireGuard, Tailscale, …)')),
				devRow(_('Coral PCIe'), wApex, apex.length > 0, apex.length ? apex.join(', ') : ''),
				E('hr', { 'style': 'margin:.8em 0' }),
				self.field(_('Keep awake'), wAwake, [_('An idle init (cntrinit) keeps the container'), E('br'), _('running with no service of its own - shell in'), E('br'), _('with Console or uxe. Adds a writable overlay.')]),
				self.field(_('Start on boot'), wBoot),
				self.field(_('Start after create'), wStart),
				E('div', { 'class': 'right', 'style': 'margin-top:1em' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							var name = (wName.getValue() || '').trim();
							if (!name) { uxcd.notify(null, E('p', _('Name is required.')), 'warning'); return; }
							var base = (wCustom.getValue() || '').trim() || wBase.getValue();
							var apk = base.indexOf('alpine') >= 0;
							var pkgs = [];
							TOOLS.forEach(function(t, i) { if (tChecks[i].getValue() == '1') pkgs.push(apk ? t.apk : t.apt); });
							var df = 'FROM ' + base + '\n';
							if (pkgs.length)
								df += apk
									? 'RUN apk add --no-cache ' + pkgs.join(' ') + '\n'
									: 'RUN apt-get update && apt-get install -y --no-install-recommends ' + pkgs.join(' ') + ' && rm -rf /var/lib/apt/lists/*\n';
							var devs = [];
							if (hd.gpu && wGpu.getValue() == '1') devs.push('/dev/dri');
							if (hd.usb && wUsb.getValue() == '1') devs.push('/dev/bus/usb');
							if (serial.length && wSer.getValue() == '1') devs = devs.concat(serial);
							if (hd.tun && wTun.getValue() == '1') devs.push('/dev/net/tun');
							if (apex.length && wApex.getValue() == '1') devs = devs.concat(apex);
							var purpose = (wPurpose.getValue() || '').trim();
							var startAfter = (wStart.getValue() == '1');
							return uxcd.build({ name: name, dockerfile_content: df, dev: wAwake.getValue() == '1', autostart: wBoot.getValue() == '1' })
								.then(function(res) {
									if (res && res.error) { uxcd.notify(null, E('p', _('create failed: %s').format(res.error)), 'danger'); return; }
									if (res && res.job) self.watchJob(res.job, function() {
										// registered by the build - apply the wizard's registry extras
										uxcd.getconfig(name).then(function(cfg) {
											if (!cfg || cfg.error) return;
											if (purpose) cfg.notes = purpose;
											if (devs.length) cfg.devices = devs;
											uxcd.save(name, cfg).then(function(ok) {
												if (ok && startAfter) uxcd.action('start', name).then(function() { return self.refresh(); });
											});
										});
									});
								});
						})
					}, _('Create'))
				])
			]);
		});
	},

	// "Pull image": fetch + convert a registry image, then register it (async job).
	openPull: function() {
		var self = this;
		uxcd.listProfiles().then(function(profiles) {
			var wImage = new ui.Textfield('', { placeholder: 'docker.io/library/nginx:alpine' });
				var wDev   = new ui.Checkbox('0');
			var wName  = new ui.Textfield('', { placeholder: _('optional; derived from the image if empty') });
			var wInfra = self.infraWidget('');
			var wAuto  = new ui.Checkbox('0');
			var choices = { '': _('(none)') };
			(profiles || []).forEach(function(p) { choices[p] = p; });
			var wProfile = new ui.Select('', choices, { widget: 'select' });
			ui.showModal(_('Pull image'), [
				E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.1em;margin-bottom:1.5em' },
					_('Fetch and convert a registry image, then register it.')),
				self.field(_('Image'), wImage, [_('Registry reference e.g.'), E('br'), _('docker.io/library/nginx:alpine')]),
					self.field(_('Dev container'), wDev, [_('Idle init + writable overlay: a daemonless'), E('br'), _('image stays up so you can shell in (Console'), E('br'), _('or `uxe <name> sh`) and build inside.')]),
				E('div', { 'style': 'height:.6em' }),
				self.field(_('Name'), wName),
				self.field(_('Profile'), wProfile, [_('Optional profiles/<name>.json overlay applied'), E('br'), _('to the bundle config (e.g. frigate)')]),
				E('div', { 'style': 'height:.6em' }),
				self.field(_('Network'), wInfra, [
					_('Network namespace to join.'),
					E('br'),
					_('Caution: Host shared includes all host'),
					E('br'),
					_('interfaces, including WAN.')
				]),
				self.field(_('Start on boot'), wAuto),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							var image = (wImage.getValue() || '').trim();
							if (!image) { uxcd.notify(null, E('p', _('Image is required.')), 'warning'); return; }
							return uxcd.pull({ image: image, name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1', profile: wProfile.getValue(), dev: wDev.getValue() == '1' })
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

	// "Build Dockerfile": build a host-arch image from a Dockerfile (no Docker
	// daemon; multi-stage FROM..AS + COPY --from supported).
	openBuild: function() {
		var self = this;
		uxcd.listProfiles().then(function(profiles) {
			var wDf    = new ui.Textfield('', { placeholder: '/root/myapp/Dockerfile' });
				var wDev   = new ui.Checkbox('0');
			var wCtx   = new ui.Textfield('', { placeholder: _('build context dir (optional)') });
			var wName  = new ui.Textfield('');
			var wInfra = self.infraWidget('');
			var wAuto  = new ui.Checkbox('0');
			var choices = { '': _('(none)') };
			(profiles || []).forEach(function(p) { choices[p] = p; });
			var wProfile = new ui.Select('', choices, { widget: 'select' });
			ui.showModal(_('Build from Dockerfile'), [
				E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.1em;margin-bottom:1.5em' },
					_('Build a host-architecture image from a Dockerfile (no Docker daemon).')),
				self.field(_('Dockerfile'), wDf, _('Path to the Dockerfile on this device.')),
					self.field(_('Dev container'), wDev, [_('Idle init + writable overlay: a daemonless'), E('br'), _('image stays up so you can shell in (Console'), E('br'), _('or `uxe <name> sh`) and build inside.')]),
				self.field(_('Context'), wCtx, [_('Directory for COPY/ADD; defaults to'), E('br'), _('the Dockerfile directory.')]),
				E('div', { 'style': 'height:.6em' }),
				self.field(_('Name'), wName),
				self.field(_('Profile'), wProfile, [_('Optional profiles/<name>.json overlay applied'), E('br'), _('to the bundle config (e.g. frigate)')]),
				E('div', { 'style': 'height:.6em' }),
				self.field(_('Network'), wInfra, [
					_('Network namespace to join.'),
					E('br'),
					_('Caution: Host shared includes all host'),
					E('br'),
					_('interfaces, including WAN.')
				]),
				self.field(_('Start on boot'), wAuto),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							var df = (wDf.getValue() || '').trim();
							if (!df) { uxcd.notify(null, E('p', _('Dockerfile path is required.')), 'warning'); return; }
							return uxcd.build({ dockerfile: df, context: wCtx.getValue(), name: wName.getValue(), infra: wInfra.getValue(), autostart: wAuto.getValue() == '1', profile: wProfile.getValue(), dev: wDev.getValue() == '1' })
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
			E('p', { 'class': 'cbi-section-descr', 'style': 'margin-top:1.1em;margin-bottom:1.5em' },
				_('Register an existing OCI bundle directory. To fetch an image or build from a Dockerfile, use the "Pull image" / "Build Dockerfile" buttons.')),
			self.field(_('Name'), wName),
			self.field(_('Bundle path'), wPath, _('Directory holding the OCI config.json + rootfs.')),
			E('div', { 'style': 'height:.6em' }),
			self.field(_('Network'), wInfra, [
				_('Network namespace to join.'),
				E('br'),
				_('Caution: Host shared includes all host'),
				E('br'),
				_('interfaces, including WAN.')
			]),
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
		var emptyNote = E('div', { 'style': 'font-style:italic;color:#999;margin:.3em 0' }, _('No schedules'));
		function updateEmpty() { emptyNote.style.display = rows.childNodes.length ? 'none' : ''; }
		function addRow(s) {
			s = s || {};
			var cron   = new ui.Textfield(s.cron || '', { placeholder: '0 3 * * *' });
			var action = new ui.Select(s.action || 'restart', { 'restart': _('restart'), 'stop': _('stop'), 'start': _('start') }, { widget: 'select' });
			var en     = new ui.Checkbox(s.enabled === false ? '0' : '1');
			var row = E('div', { 'style': 'display:flex;gap:.5em;align-items:center;margin-bottom:.4em' }, [
				E('div', { 'style': 'flex:2' }, cron.render()),
				E('div', { 'style': 'flex:1' }, action.render()),
				E('div', { 'title': _('enabled') }, en.render()),
				E('button', { 'class': 'btn cbi-button cbi-button-remove', 'click': function() { rows.removeChild(row); updateEmpty(); } }, '✕')
			]);
			row._cron = cron; row._action = action; row._en = en;
			rows.appendChild(row);
			updateEmpty();
		}
		(schedules || []).forEach(addRow);
		updateEmpty();
		return {
			node: E('div', {}, [
				E('div', { 'style': 'display:flex;gap:.5em;font-weight:bold;margin-bottom:.3em' }, [
					E('div', { 'style': 'flex:2;text-decoration:underline' }, _('Schedule')),
					E('div', { 'style': 'flex:1;text-decoration:underline' }, _('Action')),
					E('div', { 'style': 'text-decoration:underline' }, _('Enabled'))
				]),
				rows,
				emptyNote,
				E('button', { 'class': 'btn cbi-button', 'style': 'margin-bottom:.8em', 'click': function() { addRow(); } }, _('+ add schedule'))
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
			var wReadonly  = new ui.Checkbox(cfg.readonly_root === true ? '1' : '0');
			var wMounts  = new ui.DynamicList(cfg.mounts || [], null, { placeholder: '/mnt/usb' });
			var cpuQ = parseInt(res(['cpu', 'quota']), 10), cpuP = parseInt(res(['cpu', 'period']), 10);
			var wCpu = new ui.Textfield(( cpuQ > 0 && cpuP > 0 ) ? String(Math.round(cpuQ / cpuP * 100)) : '',
				{ placeholder: _('% of a core (100 = 1 core, 200 = 2)') });
			var hc = cfg.healthcheck || {};
			var wHcInt    = new ui.Textfield(hc.interval != null ? String(hc.interval) : '', { placeholder: _('seconds, e.g. 30') });
			var wHcRetry  = new ui.Textfield(hc.retries != null ? String(hc.retries) : '', { placeholder: _('e.g. 3') });
			var wHcGrace  = new ui.Textfield(hc.start_period != null ? String(hc.start_period) : '', { placeholder: _('seconds, 0 = off') });
			var wHcAction = new ui.Select(hc.on_unhealthy || '', { '': _('(report only)'), 'restart': _('restart'), 'stop': _('stop') }, { widget: 'select' });
			var wHcChecks = new ui.Textarea(hc.checks ? JSON.stringify(hc.checks, null, 2) : '',
				{ rows: 6, placeholder: _('json array of healthchecks') });
			var wSched    = self.scheduleWidget(cfg.schedule || []);
			var wWeb      = self.webPortsWidget(cfg.web_ports || []);
			var wAutoUpg  = new ui.Checkbox(cfg.auto_upgrade ? '1' : '0');
			var wNotes = new ui.Textarea(cfg.notes || '', { 'rows': 5, 'placeholder': _('What this container is for, who it serves…') });
			var wUrls  = new ui.DynamicList(cfg.urls || [], null, { placeholder: 'https://…' });
			// --- A-cluster compatibility knobs ---
			var wUser    = new ui.Textfield(cfg.user || '', { placeholder: 'uid[:gid][,gid...]' });
			var wStopSig = new ui.Textfield(cfg.stop_signal || '', { placeholder: 'SIGTERM (default)' });
			var wStopGr  = new ui.Textfield(cfg.stop_grace != null ? String(cfg.stop_grace) : '', { placeholder: _('seconds') });
			var wShm     = new ui.Textfield(cfg.shm_size || '', { placeholder: '256m' });
			var wSwap    = new ui.Textfield(cfg.swap_max || '', { placeholder: _('0 / 256m / max') });
			var wOom     = new ui.Textfield(cfg.oom_score_adj != null ? String(cfg.oom_score_adj) : '', { placeholder: '-500' });
			var wTmpfs   = new ui.DynamicList(cfg.tmpfs || [], null, { placeholder: '/run:16m' });
			var wEnvFile = new ui.DynamicList(cfg.env_file || [], null, { placeholder: '/etc/uxc/app.env' });
			// rlimits: JSON [{type,soft,hard}] <-> "TYPE=soft:hard" strings
			var rlimList = (cfg.rlimits || []).map(function(r) { return r.type + '=' + (r.soft != null ? r.soft : '') + ':' + (r.hard != null ? r.hard : ''); });
			var wRlim    = new ui.DynamicList(rlimList, null, { placeholder: 'RLIMIT_NOFILE=4096:8192' });
			// sysctl: {key:val} <-> "key=val" strings
			var sysList  = Object.keys(cfg.sysctl || {}).map(function(k) { return k + '=' + cfg.sysctl[k]; });
			var wSysctl  = new ui.DynamicList(sysList, null, { placeholder: 'net.core.somaxconn=1024' });

			var running = !!(self.runByName && self.runByName[name]);
			ui.showModal(E('div', { 'style': 'display:flex;align-items:center' }, [
				E('span', {}, _('Configure') + ': ' + name),
				E('button', {
					'class': 'btn cbi-button',
					'style': 'margin-left:auto;padding:.1em .45em;font-size:80%',
					'title': running ? _('Renaming is only available when the container is stopped') : _('Rename container (only while stopped)'),
					'disabled': running ? 'disabled' : null,
					'click': running ? null : ui.createHandlerFn(self, function() { return self.confirmRename(name); })
				}, '✎')
			]), [
				self.tabs([
					{ title: _('General'), fields: [
						self.field(_('Start on boot'), wAuto),
						self.field(_('Auto-restart (respawn)'), wRespawn),
						self.field(_('Stop signal'), wStopSig, [_('Signal sent to stop the container, e.g.'), E('br'), _('SIGINT, SIGQUIT or a number value.'), E('br'), _('Default: SIGTERM.')]),
						self.field(_('Stop grace'), wStopGr, [_('Seconds to wait before SIGKILL or cgroup-kill'), E('br'), _('Default: 5')]),
						self.field(_('Network'), wInfra, [
							_('Network namespace to join.'),
							E('br'),
							_('Caution: Host shared includes all host'),
							E('br'),
							_('interfaces, including WAN.')
						]),
						E('div', { 'class': 'cbi-value' }, [
							E('label', { 'class': 'cbi-value-title' }, _('Web UIs')),
							E('div', { 'class': 'cbi-value-field' }, [
								wWeb.node,
								E('div', { 'class': 'cbi-value-description', 'style': 'padding-top:.5em' }, [_('Web interfaces this container serves - the globe button'), E('br'), _('opens these URLs. No port mapping; route/firewall it'), E('br'), _('manually (fw4).')])
							])
						]),
						self.field(_('Overlay path'), wOvPath, _('Persistent read-write overlay directory (optional).')),
						self.field(_('Overlay size'), wOvSize, _('tmpfs overlay size, e.g. 64M (optional).'))
					] },
					{ title: _('Storage'), fields: [
						self.field(_('Volumes'), wVols, _('Bind mounts as src:dst[:ro].')),
						self.field(_('/dev/shm size'), wShm, _('Optional size of /dev/shm tmpfs.')),
						self.field(_('tmpfs mounts'), wTmpfs, [_('Extra tmpfs mounts as dest:size, e.g. /run:16m.'), E('br'), _('Replaces any same-path default.')]),
						self.field(_('Required mounts'), wMounts, [_('Host paths that must be mounted before'), E('br'), _('starting this container. e.g. external'), E('br'), _('storage holding its volumes.')]),
						self.field(_('Devices'), wDevs, [_('Device node paths. Each gets a'), E('br'), _('node + cgroup allow.')]),
					] },
					{ title: _('Runtime'), fields: [
						self.field(_('Environment'), wEnv, _('Init scripts can override set values.')),
						self.field(_('Env files'), wEnvFile, [_('Env files (KEY=VALUE per line), loaded at launch.'), E('br'), _('Inline Environment above wins on conflict.')]),
						self.field(_('Resource limits'), wRlim, _('Per-type ulimits as TYPE=soft:hard, e.g. RLIMIT_NOFILE=4096:8192 or RLIMIT_MEMLOCK=infinity:infinity.')),
						self.field(_('Sysctls'), wSysctl, [_('Kernel sysctls as key=value. net.* requires'), E('br'), _('infra netns, sysctl values are ignored when'), E('br'), _('host shared network is used.')]),
						self.field(_('Depends on'), wDeps, [_('Containers required to start before'), E('br'), _('this container.')]),
						self.field(_('Memory limit'), wMem),
						self.field(_('Swap limit'), wSwap, [_('cgroup swap cap: 0 keeps the container out'), E('br'), _('of swap entirely; empty = kernel default.')]),
						self.field(_('OOM priority'), wOom, [_('-1000…1000: negative = protect from the'), E('br'), _('OOM killer, positive = sacrifice first.'), E('br'), _('Applied at container start.')]),
						self.field(_('PID limit'), wPids),
						self.field(_('CPU limit'), wCpu, [_('CPU capacity as a percentage'), E('br'), _('one core; default = unlimited.')]),
					] },
					{ title: _('Health'), fields: [
						self.field(_('Interval'), wHcInt, [_('Seconds between health checks.'), E('br'), _('Leave empty to disable healthcheck.')]),
						self.field(_('Retries'), wHcRetry, _('Failed cycles before marking unhealthy.')),
						self.field(_('Start period'), wHcGrace, [_('Startup grace after container start.'), E('br'), _('Probe failures within it don\'t count toward retries; 0 = off.')]),
						self.field(_('On unhealthy'), wHcAction),
						E('hr', { 'style': 'margin:1em 0 .6em' }),
						E('div', { 'class': 'cbi-value' }, [
							E('label', { 'class': 'cbi-value-title' }, _('Checks')),
							E('div', { 'class': 'cbi-value-field' }, [
								E('div', {}, [_('Checks as a JSON array. Format for each entry:'), E('br'), _('type, tcp/http (target), resource (memory_max/cpu_max)'), E('br'), _('or exec format: command, timeout.'), E('br'), E('br')]),
								wHcChecks.render(),
								E('div', { 'class': 'cbi-value-description', 'style': 'padding-top:.5em' }, [_('Example:'), E('br'), _('[ { "type": "tcp", "target": "127.0.0.1:80" },'), E('br'), _('  { "type": "http", "target": "127.0.0.1:5000/health" },'), E('br'), _('  { "type": "resource", "memory_max": "80%" },'), E('br'), _('  { "type": "exec", "command": ["/hc.sh"], "timeout": 5 } ]')])
							])
						]),
						E('div', { 'style': 'height:.8em' }),
					] },
					{ title: _('Security'), fields: [
						self.field(_('Run as user'), wUser, [_("Override container's user."), E('br'), _('Format: uid[:gid],[gid,...]'), E('br'), _('Accepts numeric values and overrides'), E('br'), _('bind-mount ownerships - extra gids add'), E('br'), _('supplementary groups, such as'), E('br'), _('render/video for GPU.')]),
						self.field(_('Drop capabilities'), wCapDrop, _('"ALL" drops everything, then add back below.')),
						self.field(_('Add capabilities'), wCapAdd),
						E('div', { 'class': 'cbi-value', 'style': 'margin-top:-.4em' }, [
							E('label', { 'class': 'cbi-value-title' }, ''),
							E('div', { 'class': 'cbi-value-field' },
								E('button', { 'class': 'btn cbi-button', 'click': function(ev) { ev.preventDefault(); self.capsReference(); } }, _('Capability reference')))
						]),
						self.field(_('Seccomp'), wSeccomp, [_('OCI seccomp profile path or unconfined to'), E('br'), _('disable filtering. Default: bundle defined.')]),
						self.field(_('No new privileges'), wNoNewPriv, [_('Blocks setuid/privilege gain (OCI noNewPrivileges).'), E('br'), _('Uncheck only for privileged workloads.')]),
						self.field(_('Read-only root'), wReadonly, [_('Mount the container rootfs read-only.'), E('br'), _('Add writable paths as tmpfs (e.g. /tmp:16m).'), E('br'), _('Drops CAP_SYS_ADMIN so root cannot be'), E('br'), _('remounted writable; restore it above if needed.')]),
						E('div', { 'style': 'height:.8em' }),
					] },
					{ title: _('Schedule'), fields: [
						self.field(_('Auto-upgrade'), wAutoUpg, [
							_('Upgrade this container automatically when the scheduled update check (Settings → Safe-update) finds a new image.'),
							E('br'),
							_('Health-gated: rolls back if the new image does not become healthy (needs a healthcheck).'),
							E('br'),
							_('Off = notify only.')
						]),
						E('hr', { 'style': 'margin:1em 0' }),
						E('p', { 'class': 'cbi-section-descr' }, [
							_('Cron-driven actions run by the uxcd scheduler.'),
							E('br'),
							_('Fields: <minute> <hour> <day-of-month> <month> <day-of-week>'),
							E('br'),
							_('Examples:'),
							E('br'),
							_('"0 3 * * *" = 03:00 daily'),
							E('br'),
							_('"0 2 * * 0" = Sun 02:00'),
							E('br'),
							_('"*/30 * * * *" = every 30 min')
						]),
						wSched.node
					] },
					{ title: _('Notes'), fields: [
						self.field(_('Notes'), wNotes, [_('Free-form memo: what this container is,'), E('br'), _('who it serves, anything worth remembering.')]),
						self.field(_('Links'), wUrls, [_('Related URLs: project page, documentation,'), E('br'), _('the service itself. Shown in the details view.')])
					] },
				]),

				E('div', { 'style': 'display:flex;align-items:center;gap:.6em;margin-top:1em' }, [
					E('button', { 'class': 'btn cbi-button cbi-button-negative', 'click': ui.createHandlerFn(self, function() { return self.confirmRemove(name); }) }, _('Remove container')),
					E('button', { 'class': 'btn', 'style': 'margin-left:auto', 'click': ui.hideModal }, _('Cancel')),
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
							var nv = (wNotes.getValue() || '').trim(); if (nv) cfg.notes = nv; else delete cfg.notes;
							setOrDel('urls', list(wUrls).map(function(s) { return s.trim(); }));
							// A-cluster knobs
							if (wUser.getValue().trim()) cfg.user = wUser.getValue().trim(); else delete cfg.user;
							if (wStopSig.getValue().trim()) cfg.stop_signal = wStopSig.getValue().trim(); else delete cfg.stop_signal;
							var sg = parseInt(wStopGr.getValue(), 10); if (!isNaN(sg) && sg > 0) cfg.stop_grace = sg; else delete cfg.stop_grace;
							if (wShm.getValue().trim()) cfg.shm_size = wShm.getValue().trim(); else delete cfg.shm_size;
							if (wSwap.getValue().trim()) cfg.swap_max = wSwap.getValue().trim(); else delete cfg.swap_max;
							var oa = wOom.getValue().trim(); if (oa !== '' && !isNaN(parseInt(oa, 10))) cfg.oom_score_adj = parseInt(oa, 10); else delete cfg.oom_score_adj;
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
							// The Drop list already reflects the user's intent: ticking read-only
							// root live-adds CAP_SYS_ADMIN (see the wiring after showModal), and
							// the user can remove it there. So just save the lists as-is.
							setOrDel('cap_drop', list(wCapDrop));
							setOrDel('cap_add', list(wCapAdd));
							if (wSeccomp.getValue().trim()) cfg.seccomp = wSeccomp.getValue().trim(); else delete cfg.seccomp;
						if (wNoNewPriv.getValue() == '1') delete cfg.no_new_privileges; else cfg.no_new_privileges = false;
						if (wReadonly.getValue() == '1') cfg.readonly_root = true; else delete cfg.readonly_root;

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
							var hcGrace = parseInt(wHcGrace.getValue(), 10);
							if (hcChecks.length || (!isNaN(hcInt) && hcInt > 0) || hcAct) {
								var h = {};
								if (!isNaN(hcInt) && hcInt > 0) h.interval = hcInt;
								if (!isNaN(hcRetry) && hcRetry > 0) h.retries = hcRetry;
								if (!isNaN(hcGrace) && hcGrace > 0) h.start_period = hcGrace;
								if (hcAct) h.on_unhealthy = hcAct;
								if (hcChecks.length) h.checks = hcChecks;
								cfg.healthcheck = h;
							} else delete cfg.healthcheck;

							return uxcd.save(name, cfg).then(function(ok) {
								if (!ok) return;
								ui.hideModal();
								// Only some fields need a restart (the daemon flags it via
								// config_changed); live edits like web UIs apply at once. When a
								// restart is needed, prompt for it in a modal (confirmRestart).
								uxcd.info(name).then(function(n) {
									if (n && n.config_changed)
										self.confirmRestart(name);
									else
										uxcd.notify(null, E('p', _('Saved - applied to %s.').format(name)), 'info');
								});
								return self.refresh();
							});
						})
					}, _('Save'))
				])
			]);
			// Interactive read-only-root <-> CAP_SYS_ADMIN. Ticking read-only root adds
			// CAP_SYS_ADMIN to the Drop list at once (a read-only root the container can
			// `mount -o remount,rw /` is no protection). Unticking removes it again ONLY
			// if WE added it and the user hasn't edited the Drop list since (snapshot
			// compare - if they already had it, or changed the list in between, it stays).
			(function() {
				var cb = wReadonly.node && wReadonly.node.querySelector('input[type="checkbox"]');
				if (!cb) return;
				var autoAdded = false, snapshot = null;
				function drops() { return (wCapDrop.getValue() || []).filter(function(x) { return x != null && x !== ''; }); }
				function eq(a, b) { return a && b && a.length === b.length && a.every(function(v, i) { return v === b[i]; }); }
				cb.addEventListener('change', function() {
					var d = drops();
					if (cb.checked) {
						if (d.indexOf('CAP_SYS_ADMIN') < 0 && (wCapAdd.getValue() || []).indexOf('CAP_SYS_ADMIN') < 0) {
							d.push('CAP_SYS_ADMIN');
							wCapDrop.setValue(d);
							autoAdded = true; snapshot = drops();
						}
					} else if (autoAdded && eq(d, snapshot)) {
						wCapDrop.setValue(d.filter(function(x) { return x !== 'CAP_SYS_ADMIN'; }));
						autoAdded = false; snapshot = null;
					} else { autoAdded = false; snapshot = null; }
				});
			})();
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

		function th(field, label, center) {
			var arrow = (self._sortField === field) ? (self._sortDir === 'asc' ? ' ▲' : ' ▼') : '';
			return E('div', { 'class': 'th', 'style': 'cursor:pointer;user-select:none' + (center ? ';text-align:center' : ''), 'click': ui.createHandlerFn(self, 'sortBy', field) }, label + arrow);
		}

		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			th('name', _('Name')),
			E('div', { 'class': 'th', 'style': 'width:2.5em' }, ''),
			th('status', _('Status')),
			th('memory', _('Memory'), true),
			th('cpu', _('CPU'), true),
			th('pids', _('PIDs'), true),
			E('div', { 'class': 'th', 'style': 'text-align:center' }, _('Network')),
			E('div', { 'class': 'th cbi-section-actions', 'style': 'text-align:center' }, _('Actions'))
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
				E('div', { 'class': 'td', 'style': 'text-align:center;width:2.5em' },
					(c.running && c.web_ports && c.web_ports.length) ? uxcd.webBtn(c) : ''),
				E('div', { 'class': 'td', 'data-title': _('Status') }, [
					uxcd.statusBadge(c),
					(c.running && c.uptime) ? E('span', { 'style': 'margin-left:.4em;color:#888;font-size:90%' }, '· ' + uxcd.fmtUptime(c.uptime)) : '',
					c.config_changed ? E('span', { 'style': 'margin-left:.4em;color:#f0ad4e;cursor:help', 'title': _('Config changed since launch - restart to apply') }, '⟳') : '',
					c.upgrading ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('upgrading'), 'starting')) : '',
					(c.update_available && !c.upgrading) ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('update'), 'up')) : '',
					(c.new_version && !c.upgrading) ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('new %s').format(c.new_version), 'up')) : '',
					(c.oom_killed && !c.running) ? E('span', { 'style': 'margin-left:.4em', 'title': _('last run was OOM-killed') }, uxcd.badge(_('OOM'), 'down')) : '',
						(c.fault && !c.running) ? E('span', { 'style': 'margin-left:.4em;cursor:help', 'title': c.fault }, uxcd.badge(_('port in use'), 'down')) : '',
					c.last_update == 'rolled_back' ? E('span', { 'style': 'margin-left:.4em', 'title': _('Auto-rolled back: the updated image did not become healthy') }, uxcd.badge(_('rolled back'), 'down')) : ''
				]),
				E('div', { 'class': 'td', 'data-title': _('Memory'), 'style': 'text-align:center' }, c.running ? uxcd.fmtBytes(c.memory) : '-'),
				E('div', { 'class': 'td', 'data-title': _('CPU'), 'style': 'text-align:center' }, (c.running && pct != null) ? pct.toFixed(0) + '%' : '-'),
				E('div', { 'class': 'td', 'data-title': _('PIDs'), 'style': 'text-align:center' }, c.running ? (c.pids || 0) : '-'),
				E('div', { 'class': 'td', 'data-title': _('Network'), 'style': 'text-align:center' },
					c.infra ? c.infra
						: E('span', { 'style': 'color:#f0ad4e;cursor:help', 'title': _('Host network: shares ALL host interfaces including the WAN/public IP - reachable from anywhere the firewall permits. Use an infra netns to isolate.') }, _('host ⚠'))),
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
				dom.content(el, self.tableContent(containers));   // samples cpuPct -> cpuLast
			self.recordStats(containers);                          // then ring-buffer the sample
			var sel = document.getElementById('uxcd-summary');
			if (sel)
				dom.content(sel, self.summaryContent(containers));
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
					E('div', { 'class': 'td', 'style': 'width:25%;font-weight:bold' }, k),
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
				row(_('Autostart'), n.autostart ? _('yes') : _('no')),
				row(_('Respawn'), n.respawn ? _('yes') : _('no')),
				row(_('Image'), n.image),
				row(_('Digest'), dig(n.digest)),
				row(_('Created'), n.created ? new Date(n.created * 1000).toLocaleString() : null),
				row(_('Upgraded'), n.upgraded ? new Date(n.upgraded * 1000).toLocaleString() : null),
				row(_('Update'), n.upgrading ? E('em', {}, _('upgrading…')) : (n.update_available ? E('span', {}, [ _('available') + ' ', dig(n.update_digest) ]) : null)),
				row(_('New version'), (n.new_version && !n.upgrading) ? n.new_version : null),
				row(_('Last update'), n.last_update ? ({ 'verified': _('verified healthy'), 'rolled_back': _('rolled back (new image stayed unhealthy)'), 'rollback_failed': _('update failed; rollback also failed') }[n.last_update] || n.last_update) : null),
				row(_('Last exit'), n.exited_at ? E('span', {}, [
					(n.oom_killed
						? E('span', { 'style': 'color:#d9534f;font-weight:bold' }, _('OOM-killed'))
						: (n.term_signal ? _('killed by %s').format(uxcd.signalName(n.term_signal))
							: (n.exit_code != null ? _('exit code %d').format(n.exit_code) : _('exited')))),
					' — ' + new Date(n.exited_at * 1000).toLocaleString()
				]) : null),
				(n.fault && !n.running) ? row(_('Likely cause'), n.fault) : null,
				row(_('Bundle'), n.bundle),
				row(_('Config'), n.config),
				row(_('Hostname'), n.hostname),
				row(_('Command'), arr(n.command)),
				row(_('Working dir'), n.cwd),
				row(_('Network'), n.infra ? (_('infra netns') + ': ' + n.infra)
					: (n.netns ? n.netns
						: E('span', { 'style': 'color:#f0ad4e' }, [
							E('span', { 'style': 'font-weight:bold' }, '⚠ '),
							_('Host network: the container shares every host interface, WAN included - so any port it listens on is reachable straight from the internet, with no firewall redirect needed.'),
							E('br'),
							_('Use an infra netns to isolate it.')
						]))),
				row((n.infra || n.netns) ? _('Addresses') : _('Host addresses (incl. WAN)'), arr(n.ipaddr)),
				(n.ip6addr && n.ip6addr.length) ? row(_('IPv6 addresses'), arr(n.ip6addr)) : '',
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
			var actions = n.upgrading
				? [ E('em', { 'style': 'color:#888' }, _('upgrading… the container is locked until the update finishes')) ]
				: (n.running
					? [ modalBtn('restart', _('Restart'), 'action'), ' ', modalBtn('stop', _('Stop'), 'reset') ]
					: [ modalBtn('start', _('Start'), 'positive') ]);
			if (n.running && self._consoleEnabled && !n.upgrading)
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
			if (n.new_image && !n.upgrading)
				actions.push(' ', E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'title': _('Pull %s through the health-gated safe-update (auto-rollback if it does not become healthy)').format(n.new_image),
					'click': ui.createHandlerFn(self, function() {
						return uxcd.upgrade(name, n.new_image).then(function(res) {
							if (res && res.error) { uxcd.notify(null, E('p', _('upgrade failed: %s').format(res.error)), 'danger'); return; }
							if (res && res.job) { ui.hideModal(); self.watchJob(res.job); }
						});
					})
				}, _('Upgrade to %s').format(n.new_version)));
			if (n.image && !n.upgrading)
				actions.push(' ', E('button', {
					'class': 'btn cbi-button',
					'title': _('Pull a different version/tag of this image through the same health-gated safe-update'),
					'click': ui.createHandlerFn(self, function() { return self.openUpgradeTo(name, n.image); })
				}, _('Upgrade to…')));
				if (n.has_prev && !n.upgrading)
					actions.push(' ', E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'title': (n.prev_image ? _('Swap back to the previous bundle (%s) and restart. Reversible.').format(n.prev_image)
							: _('Swap back to the previous bundle (.prev) and restart. Reversible.')),
						'click': ui.createHandlerFn(self, function() {
							ui.hideModal();   // close first: no other action can race the swap+restart
							return uxcd.rollback(name).then(function() { return self.refresh(); });
						})
					}, _('Rollback')));

			// Stats tab: live resource usage (like `docker stats`) + trend sparklines,
			// kept out of Info so that view stays short. Panes all render up-front (the
			// tabs() helper only toggles display), so the spark divs exist for the redraw.
			var stats = [
				row(_('PIDs'), n.running ? n.pids : null),
				row(_('Memory trend'), n.running ? E('div', { 'id': 'uxcd-spark-mem', 'style': 'min-height:42px' }) : null),
				row(_('CPU trend'), n.running ? E('div', { 'id': 'uxcd-spark-cpu', 'style': 'min-height:42px' }) : null),
				n.cpu_pressure ? row(_('CPU pressure'), _('some avg10 %s / avg60 %s').format(n.cpu_pressure.avg10, n.cpu_pressure.avg60)) : null,
				n.memory_pressure ? row(_('Memory pressure'), _('some avg10 %s / avg60 %s').format(n.memory_pressure.avg10, n.memory_pressure.avg60)) : null,
				n.io_pressure ? row(_('IO pressure'), _('some avg10 %s / avg60 %s').format(n.io_pressure.avg10, n.io_pressure.avg60)) : null,
				n.running ? null : row(_('Live stats'), E('span', { 'style': 'color:#888' }, _('shown while the container is running')))
			];

			var dlg = ui.showModal(_('Container') + ': ' + name, [
				self.tabs([
					{ title: _('Info'), fields: [ E('div', { 'class': 'table' }, info) ] },
					{ title: _('Stats'), fields: [ E('div', { 'class': 'table' }, stats) ] },
					{ title: _('Notes'), fields: [
						E('div', { 'style': 'white-space:pre-wrap;margin-bottom:.8em' },
							n.notes ? n.notes : E('em', { 'style': 'color:#888' }, _('(no notes - add some behind Configure → Notes)'))),
						E('div', {}, (n.urls || []).map(function(u) {
							// only link http(s) - a hand-edited registry must not inject e.g. javascript: URLs
							var safe = /^https?:\/\//i.test(u);
							return E('div', { 'style': 'margin:.15em 0' },
								safe ? E('a', { 'href': u, 'target': '_blank', 'rel': 'noopener' }, u) : u);
						}))
					] },
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
				E('div', { 'class': 'right', 'style': 'margin-top:1.1em' }, [
					E('span', { 'style': 'float:left' }, actions),
					E('button', { 'class': 'btn', 'click': function() {
						if (self._detailFollow) { poll.remove(self._detailFollow); self._detailFollow = null; }
						if (self._detailSpark) { poll.remove(self._detailSpark); self._detailSpark = null; }
						ui.hideModal();
					} }, _('Dismiss'))
				])
			]);
			dlg.style.maxWidth = '56em';   // fit the grown action row on one line

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

			// redraw the memory/CPU sparklines from the ring buffers every 5s while open
			// (the overview refresh loop keeps filling them). Self-removes when gone.
			if (self._detailSpark) poll.remove(self._detailSpark);
			self._detailSpark = function spark() {
				var mel = document.getElementById('uxcd-spark-mem');
				if (!mel) { poll.remove(spark); return; }
				var h = self.statsHist[name] || { mem: [], cpu: [] };
				mel.innerHTML = self.sparkSVG(h.mem, { unit: 'bytes', color: '#4a90d9', floorPeak: n.memory_peak });
				var cel = document.getElementById('uxcd-spark-cpu');
				if (cel) cel.innerHTML = self.sparkSVG(h.cpu, { unit: 'pct', color: '#5cb85c' });
			};
			self._detailSpark();          // draw at once, don't wait for the first tick
			poll.add(self._detailSpark, 5);
		});
	},

	// one-line health summary above the table: running / stopped, with unhealthy and
	// crashed called out (in colour) only when present. Refreshed alongside the table.
	summaryContent: function(containers) {
		if (!containers.length)
			return [ E('span', { 'style': 'color:#888' }, _('No containers registered.')) ];
		var running = 0, stopped = 0, unhealthy = 0, crashed = 0;
		containers.forEach(function(c) {
			if (c.running) { running++; if (c.health === 'unhealthy') unhealthy++; }
			else { stopped++; if (c.fault || c.oom_killed) crashed++; }
		});
		var parts = [
			E('span', {}, running + ' ' + _('running')),
			E('span', { 'style': 'color:#888' }, ' · ' + stopped + ' ' + _('stopped'))
		];
		if (unhealthy) parts.push(E('span', { 'style': 'color:#f0ad4e' }, ' · ' + unhealthy + ' ' + _('unhealthy')));
		if (crashed)   parts.push(E('span', { 'style': 'color:#d9534f' }, ' · ' + crashed + ' ' + _('crashed')));
		return parts;
	},

	render: function(containers) {
		var self = this;

		var table = E('div', { 'class': 'table cbi-section-table', 'id': 'uxcd-table' },
			this.tableContent(containers));   // samples cpuPct -> cpuLast
		this.recordStats(containers);         // seed the sparkline rings with the first sample

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
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(self, 'openWizard') }, _('New container…')),
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
			E('div', { 'id': 'uxcd-summary', 'style': 'margin:.2em 0 .6em;font-size:95%' }, this.summaryContent(containers)),
			table
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
