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
var callRegistryList   = rpc.declare({ object: 'uxcd', method: 'registry_list' });
var callRegistrySet    = rpc.declare({ object: 'uxcd', method: 'registry_set',    params: [ 'registry', 'username', 'password' ] });
var callRegistryRemove = rpc.declare({ object: 'uxcd', method: 'registry_remove', params: [ 'registry' ] });
var callPull      = rpc.declare({ object: 'uxcd', method: 'pull',      params: [ 'image', 'name', 'autostart', 'infra' ] });
var callBuild     = rpc.declare({ object: 'uxcd', method: 'build',     params: [ 'dockerfile', 'context', 'name', 'autostart', 'infra' ] });
var callJobStatus = rpc.declare({ object: 'uxcd', method: 'job_status', params: [ 'id' ] });
var callJobLog    = rpc.declare({ object: 'uxcd', method: 'job_log',    params: [ 'id', 'lines' ] });
var callImages    = rpc.declare({ object: 'uxcd', method: 'images' });
var callPrune     = rpc.declare({ object: 'uxcd', method: 'prune',     params: [ 'target' ] });
var callCheckUpdates = rpc.declare({ object: 'uxcd', method: 'check_updates' });
var callUpgrade      = rpc.declare({ object: 'uxcd', method: 'upgrade',      params: [ 'name' ] });
var callEvents       = rpc.declare({ object: 'uxcd', method: 'events',       params: [ 'limit' ] });
var callEventsClear  = rpc.declare({ object: 'uxcd', method: 'events_clear' });
var callRollback     = rpc.declare({ object: 'uxcd', method: 'rollback',     params: [ 'name' ] });
var callJobCancel    = rpc.declare({ object: 'uxcd', method: 'job_cancel',   params: [ 'id' ] });
var callJobList      = rpc.declare({ object: 'uxcd', method: 'job_list' });

return baseclass.extend({
	// --- raw ubus calls; never reject (resolveDefault) so a transient failure
	//     does not break the poll loop ---
	list: function() {
		return L.resolveDefault(callList(), {});
	},

	info: function(name) {
		return L.resolveDefault(callInfo(name), {});
	},

	log: function(name, lines) {
		return L.resolveDefault(callLog(name, lines || 0), { lines: [] });
	},
	// truncate a container's captured log; toast-free, resolve to bool.
	logClear: function(name) {
		return callLogClear(name).then(function() { return true; }, function() { return false; });
	},

	// raw registry file for the editor (load -> edit -> save round-trip)
	getconfig: function(name) {
		return L.resolveDefault(callGetconfig(name), {});
	},

	// write helpers: resolve to true/false and toast on failure.
	save: function(name, config) {
		return callSetconfig(name, config).then(function(res) {
			if (res && res.error) {
				ui.addNotification(null, E('p', _('uxcd: save failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: save failed: %s').format(err)), 'danger');
			return false;
		});
	},

	create: function(opts) {
		return callCreate(opts.name, opts.bundle, !!opts.autostart, opts.respawn !== false, opts.infra || '').then(function(res) {
			if (res && res.error) {
				ui.addNotification(null, E('p', _('uxcd: create failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: create failed: %s').format(err)), 'danger');
			return false;
		});
	},

	remove: function(name) {
		return callRemove(name).then(function(res) {
			if (res && res.error) {
				ui.addNotification(null, E('p', _('uxcd: remove failed: %s').format(res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: remove failed: %s').format(err)), 'danger');
			return false;
		});
	},

	rename: function(name, newName) {
		return callRename(name, newName).then(function(res) {
			if (res && res.error) { ui.addNotification(null, E('p', _('uxcd: rename failed: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: rename failed: %s').format(err)), 'danger'); return false;
		});
	},

	// registry credentials (private/auth registries). registryList returns
	// [{registry, username}] - never passwords.
	registryList: function() {
		return L.resolveDefault(callRegistryList(), { registries: [] }).then(function(r) { return (r && r.registries) ? r.registries : []; });
	},
	registrySet: function(registry, username, password) {
		return callRegistrySet(registry, username, password).then(function(res) {
			if (res && res.error) { ui.addNotification(null, E('p', _('uxcd: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) { ui.addNotification(null, E('p', _('uxcd: registry save failed: %s').format(err)), 'danger'); return false; });
	},
	registryRemove: function(registry) {
		return callRegistryRemove(registry).then(function() { return true; }, function() { return false; });
	},

	// pull/build: start a long-running docker2uxcd job; resolve to {job:id}|{error}
	// (a transport rejection is folded into {error} so callers never see a silent
	// unhandled rejection).
	pull: function(opts) {
		return callPull(opts.image, opts.name || '', !!opts.autostart, opts.infra || '')
			.catch(function(e) { return { error: '' + e }; });
	},
	build: function(opts) {
		return callBuild(opts.dockerfile, opts.context || '', opts.name || '', !!opts.autostart, opts.infra || '')
			.catch(function(e) { return { error: '' + e }; });
	},
	jobStatus: function(id) {
		return L.resolveDefault(callJobStatus(id), {});
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
			if (res && res.error) { ui.addNotification(null, E('p', _('uxcd: cancel failed: %s').format(res.error)), 'danger'); return false; }
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: cancel failed: %s').format(err)), 'danger'); return false;
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
				ui.addNotification(null, E('p', _('uxcd: prune failed: %s').format(res.error)), 'danger');
				return null;
			}
			return res;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: prune failed: %s').format(err)), 'danger');
			return null;
		});
	},

	// start an on-demand image-update check; results appear as update_available
	// in list/info on the next poll (resolve to true on success).
	checkUpdates: function() {
		return callCheckUpdates().then(function(res) {
			if (res && res.error) { ui.addNotification(null, E('p', _('uxcd: %s').format(res.error)), 'warning'); return false; }
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: update check failed: %s').format(err)), 'danger');
			return false;
		});
	},

	// re-pull the recorded image + restart; resolves to {job:id}|{error}.
	upgrade: function(name) {
		return callUpgrade(name).catch(function(e) { return { error: '' + e }; });
	},

	// roll a container back to its .prev bundle; toast, resolve to bool.
	rollback: function(name) {
		return callRollback(name).then(function(res) {
			if (res && res.error) { ui.addNotification(null, E('p', _('uxcd: rollback failed: %s').format(res.error)), 'danger'); return false; }
			ui.addNotification(null, E('p', _('Rolled %s back to its previous bundle.').format(name)), 'info');
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: rollback failed: %s').format(err)), 'danger'); return false;
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
				ui.addNotification(null, E('p', _('uxcd: %s %s failed: %s').format(verb, name, res.error)), 'danger');
				return false;
			}
			return true;
		}, function(err) {
			ui.addNotification(null, E('p', _('uxcd: %s %s failed: %s').format(verb, name, err)), 'danger');
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
