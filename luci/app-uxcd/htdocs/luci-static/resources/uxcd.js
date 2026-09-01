'use strict';
'require baseclass';
'require rpc';
'require ui';

// Shared helper for the uxcd LuCI app: the ubus calls, lifecycle actions and
// formatters used by BOTH the "Containers" page and the index/overview widget.
// LuCI's browser side cannot subscribe to ubus events, so everything here is
// request/response and the views poll it - this module is the one place that
// knows the uxcd ubus contract.

var callList    = rpc.declare({ object: 'uxcd', method: 'list' });
var callInfo    = rpc.declare({ object: 'uxcd', method: 'info',    params: [ 'name' ] });
var callLog     = rpc.declare({ object: 'uxcd', method: 'log',     params: [ 'name', 'lines' ] });
var callLogClear = rpc.declare({ object: 'uxcd', method: 'log_clear', params: [ 'name' ] });
var callStart   = rpc.declare({ object: 'uxcd', method: 'start',   params: [ 'name' ] });
var callStop    = rpc.declare({ object: 'uxcd', method: 'stop',    params: [ 'name' ] });
var callRestart = rpc.declare({ object: 'uxcd', method: 'restart', params: [ 'name' ] });
var callGetconfig = rpc.declare({ object: 'uxcd', method: 'getconfig', params: [ 'name' ] });
var callSetconfig = rpc.declare({ object: 'uxcd', method: 'setconfig', params: [ 'name', 'config' ] });
var callCreate    = rpc.declare({ object: 'uxcd', method: 'create',    params: [ 'name', 'bundle', 'autostart', 'respawn', 'infra' ] });
var callRemove    = rpc.declare({ object: 'uxcd', method: 'remove',    params: [ 'name' ] });
var callRename    = rpc.declare({ object: 'uxcd', method: 'rename',    params: [ 'name', 'new_name' ] });
var callConsole   = rpc.declare({ object: 'uxcd', method: 'console',   params: [ 'name', 'bind', 'tls' ] });
var callExec      = rpc.declare({ object: 'uxcd', method: 'exec',      params: [ 'name', 'command', 'timeout' ] });
var callConsoleActive = rpc.declare({ object: 'uxcd', method: 'console_active', params: [ 'port' ] });
var callRegistryList   = rpc.declare({ object: 'uxcd', method: 'registry_list' });
var callRegistrySet    = rpc.declare({ object: 'uxcd', method: 'registry_set',    params: [ 'registry', 'username', 'password' ] });
var callRegistryRemove = rpc.declare({ object: 'uxcd', method: 'registry_remove', params: [ 'registry' ] });
var callPull      = rpc.declare({ object: 'uxcd', method: 'pull',      params: [ 'image', 'name', 'autostart', 'infra', 'profile', 'dev', 'out' ] });
var callBuild     = rpc.declare({ object: 'uxcd', method: 'build',     params: [ 'dockerfile', 'context', 'name', 'autostart', 'infra', 'profile', 'dev', 'dockerfile_content', 'out' ] });
var callListProfiles = rpc.declare({ object: 'uxcd', method: 'list_profiles' });
var callHostDevices  = rpc.declare({ object: 'uxcd', method: 'host_devices' });
var callJobLog    = rpc.declare({ object: 'uxcd', method: 'job_log',    params: [ 'id', 'lines' ] });
var callImages    = rpc.declare({ object: 'uxcd', method: 'images' });
var callPrune     = rpc.declare({ object: 'uxcd', method: 'prune',     params: [ 'target' ] });
var callCheckUpdates = rpc.declare({ object: 'uxcd', method: 'check_updates' });
var callUpgrade      = rpc.declare({ object: 'uxcd', method: 'upgrade',      params: [ 'name', 'image' ] });
var callEvents       = rpc.declare({ object: 'uxcd', method: 'events',       params: [ 'limit' ] });
var callEventsClear  = rpc.declare({ object: 'uxcd', method: 'events_clear' });
var callRollback     = rpc.declare({ object: 'uxcd', method: 'rollback',     params: [ 'name' ] });
var callJobCancel    = rpc.declare({ object: 'uxcd', method: 'job_cancel',   params: [ 'id' ] });
var callJobList      = rpc.declare({ object: 'uxcd', method: 'job_list' });

// Auto-dismissing notification: LuCI's ui.addNotification stacks and never
// clears on its own, so repeated actions (save, check-updates, restart) pile up.
// Wrap it to auto-remove after a few seconds - errors linger a little longer so
// they are not missed. Uses ui['addNotification'] (bracket form) so the in-file
// rewrite of autoNotify(...) calls does not recurse into this wrapper.
function autoNotify(title, content, type) {
	var n = ui['addNotification'](title, content, type);
	var ms = (type === 'danger' || type === 'error') ? 8000 : 4000;
	if (n) setTimeout(function() { try { if (n.parentNode) n.parentNode.removeChild(n); } catch (e) {} }, ms);
	return n;
}

// globe icon for the web-UI launch button (shared by the Containers page + widget)
var SVG_GLOBE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" style="vertical-align:-2px"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13"/><path d="M8 1.5c2.2 2 2.2 11 0 13M8 1.5c-2.2 2-2.2 11 0 13"/></svg>';

return baseclass.extend({
	// Auto-dismissing notification, shared with the views (see autoNotify above).
	notify: autoNotify,

	// --- raw ubus calls; never reject (resolveDefault) so a transient failure
	//     does not break the poll loop ---
	list: function() {
		return L.resolveDefault(callList(), {});
	},

	info: function(name) {
		return L.resolveDefault(callInfo(name), {});
	},

	// web-UI launch: a globe button that resolves the container IP and opens the
	// served port(s) - one port opens directly, several show a picker. Shared by
	// the Containers page and the index widget.
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

	openWebUI: function(name, ports) {
		function go(host, p) {
			window.open((p.scheme || 'http') + '://' + host + ':' + p.port + (p.path || '/'), '_blank', 'noopener');
		}
		return L.resolveDefault(callInfo(name), {}).then(function(d) {
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
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Dismiss')))
			]);
		});
	},

	log: function(name, lines) {
		return L.resolveDefault(callLog(name, lines || 0), { lines: [] });
	},
	// truncate a container's captured log; toast-free, resolve to bool.
	logClear: function(name) {
		return callLogClear(name).then(function() { return true; }, function() { return false; });
	},

	// attachable devices present on this box (the New container wizard)
	hostDevices: function() {
		return L.resolveDefault(callHostDevices(), {});
	},

	// raw registry file for the editor (load -> edit -> save round-trip)
	getconfig: function(name) {
		return L.resolveDefault(callGetconfig(name), {});
	},

	// write helpers: resolve to true/false and toast on failure.
	save: function(name, config) {
		return callSetconfig(name, config).then(function(res) {
			if (res && res.error) {
				autoNotify(null, E('p', _('uxcd: save failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: save failed: %s').format(err)), 'danger');
			return false;
		});
	},

	create: function(opts) {
		return callCreate(opts.name, opts.bundle, !!opts.autostart, opts.respawn !== false, opts.infra || '').then(function(res) {
			if (res && res.error) {
				autoNotify(null, E('p', _('uxcd: create failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: create failed: %s').format(err)), 'danger');
			return false;
		});
	},

	remove: function(name) {
		return callRemove(name).then(function(res) {
			if (res && res.error) {
				autoNotify(null, E('p', _('uxcd: remove failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: remove failed: %s').format(err)), 'danger');
			return false;
		});
	},

	rename: function(name, newName) {
		return callRename(name, newName).then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: rename failed: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: rename failed: %s').format(err)), 'danger'); return false;
		});
	},

	// browser console: returns { port, scheme } to open a ttyd terminal, or
	// { command } / { error } if ttyd is absent. bind = browser-facing host (ttyd
	// binds there); tls = serve https (pass when the LuCI page is https so the
	// console scheme matches). Never toasts (the caller renders it in a modal).
	console: function(name, bind, tls) {
		return callConsole(name, bind || '', tls ? 1 : 0).then(function(r) { return r || {}; },
			function(err) { return { error: '' + err }; });
	},
	// true while the console ttyd on <port> is still alive (LuCI polls to close the tab)
	consoleActive: function(port) {
		return callConsoleActive(port).then(function(r) { return !!(r && r.active); }, function() { return false; });
	},

	// run a non-interactive command in <name>; resolves { exit_code, output,
	// signal?, timed_out? } or { error }. command is an argv array.
	exec: function(name, command, timeout) {
		return callExec(name, command, timeout || 0).then(function(r) { return r || {}; },
			function(err) { return { error: '' + err }; });
	},

	// registry credentials (private/auth registries). registryList returns
	// [{registry, username}] - never passwords.
	registryList: function() {
		return L.resolveDefault(callRegistryList(), { registries: [] }).then(function(r) { return (r && r.registries) ? r.registries : []; });
	},
	registrySet: function(registry, username, password) {
		return callRegistrySet(registry, username, password).then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) { autoNotify(null, E('p', _('uxcd: registry save failed: %s').format(err)), 'danger'); return false; });
	},
	registryRemove: function(registry) {
		return callRegistryRemove(registry).then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) { autoNotify(null, E('p', _('uxcd: registry remove failed: %s').format(err)), 'danger'); return false; });
	},

	// pull/build: start a long-running docker2uxcd job; resolve to {job:id}|{error}
	// (a transport rejection is folded into {error} so callers never see a silent
	// unhandled rejection).
	pull: function(opts) {
		return callPull(opts.image, opts.name || '', !!opts.autostart, opts.infra || '', opts.profile || '', !!opts.dev, opts.out || '')
			.catch(function(e) { return { error: '' + e }; });
	},
	build: function(opts) {
		return callBuild(opts.dockerfile || '', opts.context || '', opts.name || '', !!opts.autostart, opts.infra || '', opts.profile || '', !!opts.dev, opts.dockerfile_content || '', opts.out || '')
			.catch(function(e) { return { error: '' + e }; });
	},
	// docker2uxc profiles for the pull/build dropdown: { names: [...], details:
	// { name: { description, needs[], missing[], devices[], caps_add[],
	// shm_size?, healthcheck } } } so the UI can say what picking one does.
	// Empty on error.
	listProfiles: function() {
		return callListProfiles()
			.then(function(r) { return { names: (r && r.profiles) || [], details: (r && r.details) || {} }; })
			.catch(function() { return { names: [], details: {} }; });
	},
	jobLog: function(id, lines) {
		return L.resolveDefault(callJobLog(id, lines || 0), { lines: [] });
	},
	jobList: function() {
		return L.resolveDefault(callJobList(), {});
	},
	// cancel a running pull/build/upgrade job; toast on failure, resolve to bool.
	jobCancel: function(id) {
		return callJobCancel(id).then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: cancel failed: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: cancel failed: %s').format(err)), 'danger'); return false;
		});
	},

	// disk: bundle + cache listing, and prune (target "cache"|"prev"|"all").
	images: function() {
		return L.resolveDefault(callImages(), { bundles: {}, cache: {} });
	},

	// recent daemon events (newest first) for the Activity timeline
	events: function(limit) {
		return L.resolveDefault(callEvents(limit || 0), { events: [] }).then(function(r) {
			return (r && r.events) ? r.events : [];
		});
	},
	eventsClear: function() {
		return callEventsClear().then(function() { return true; }, function() { return false; });
	},
	prune: function(target) {
		return callPrune(target).then(function(res) {
			if (res && res.error) {
				autoNotify(null, E('p', _('uxcd: prune failed: %s').format(res.error)), 'danger');
				return null;
			}
			return res;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: prune failed: %s').format(err)), 'danger');
			return null;
		});
	},

	// start an on-demand image-update check; results appear as update_available
	// in list/info on the next poll (resolve to true on success).
	checkUpdates: function() {
		return callCheckUpdates().then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: %s').format(res.error)), 'warning'); return false; }
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: update check failed: %s').format(err)), 'danger');
			return false;
		});
	},

	// re-pull the recorded image (or an explicit new ref - a version/tag jump)
	// + health-gated restart; resolves to {job:id}|{error}.
	upgrade: function(name, image) {
		return callUpgrade(name, image || '').catch(function(e) { return { error: '' + e }; });
	},

	// roll a container back to its .prev bundle; toast, resolve to bool.
	rollback: function(name) {
		return callRollback(name).then(function(res) {
			if (res && res.error) { autoNotify(null, E('p', _('uxcd: rollback failed: %s').format(res.error)), 'danger'); return false; }
			autoNotify(null, E('p', _('Rolled %s back to its previous bundle.').format(name)), 'info');
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: rollback failed: %s').format(err)), 'danger'); return false;
		});
	},

	// uxcd.list returns an object keyed by container name; fold the name in and
	// sort, so the views get a stable, ready-to-render array.
	listArray: function() {
		return this.list().then(function(res) {
			var out = [];
			for (var k in (res || {})) {
				if (k == 'error')
					continue;
				var c = res[k];
				c.name = k;
				out.push(c);
			}
			out.sort(function(a, b) { return a.name > b.name ? 1 : a.name < b.name ? -1 : 0; });
			return out;
		});
	},

	// lifecycle: returns Promise<bool> and surfaces a failure as a toast, so the
	// Containers page and the index widget share identical button behaviour.
	action: function(verb, name) {
		var fn = ({ start: callStart, stop: callStop, restart: callRestart })[verb];
		if (!fn)
			return Promise.resolve(false);
		return fn(name).then(function(res) {
			if (res && res.error) {
				autoNotify(null, E('p', _('uxcd: %s %s failed: %s').format(verb, name, res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			autoNotify(null, E('p', _('uxcd: %s %s failed: %s').format(verb, name, err)), 'danger');
			return false;
		});
	},

	// --- formatters shared by the views ---
	fmtBytes: function(n) {
		n = n || 0;
		var u = [ 'B', 'kB', 'MB', 'GB', 'TB' ], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i == 0 ? n : n.toFixed(1)) + ' ' + u[i];
	},

	fmtUptime: function(s) {
		s = s || 0;
		if (s <= 0)
			return '-';
		var d = Math.floor(s / 86400); s %= 86400;
		var h = Math.floor(s / 3600);  s %= 3600;
		var m = Math.floor(s / 60);    var sec = s % 60;
		if (d) return '%dd %dh %dm'.format(d, h, m);
		if (h) return '%dh %dm'.format(h, m);
		if (m) return '%dm %ds'.format(m, sec);
		return '%ds'.format(sec);
	},

	// common signal numbers -> names (for "Last exit" and exit events)
	signalName: function(n) {
		return ({ 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' })[n] || ('SIG' + n);
	},

	stateText: function(c) {
		return c.running ? _('running') : _('stopped');
	},

	// a small coloured state/health pill
	badge: function(text, kind) {
		var color = ({
			running:   '#5bc0de',
			healthy:   '#5cb85c',
			up:        '#5bc0de',
			starting:  '#f0ad4e',
			unhealthy: '#d9534f',
			down:      '#d9534f',
			stopped:   '#999',
			unknown:   '#999'
		})[kind] || '#999';
		return E('span', {
			'style': 'display:inline-block;min-width:4em;text-align:center;padding:1px 8px;' +
			         'border-radius:10px;color:#fff;font-size:90%;background:' + color
		}, text);
	},

	// concern-aware single badge: red = needs attention (unhealthy, or down while
	// it should be up = crashed/backing off), green = healthy, blue = running,
	// grey = intentionally stopped. Shared so the Containers page and the index
	// "remote control" widget flag trouble identically and at a glance.
	statusBadge: function(c) {
		if (c.running) {
			if (c.health == 'unhealthy') return this.badge(_('unhealthy'), 'unhealthy');
			if (c.health == 'starting')  return this.badge(_('starting'), 'starting');
			if (c.health == 'healthy')   return this.badge(_('healthy'), 'healthy');
			return this.badge(_('running'), 'running');
		}
		if (c.desired == 'up')           return this.badge(_('down'), 'down');
		return this.badge(_('stopped'), 'stopped');
	}
});
