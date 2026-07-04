'use strict';
'require baseclass';
'require poll';
'require ui';
'require dom';
'require uxcd';

// Index/overview "remote control" widget: a compact card on Status -> Overview
// showing each container's state plus quick start/stop/restart buttons. Clicking
// a name jumps to the Containers tab with that container's detail open. It shares
// uxcd.js with the full Containers page; both poll (no browser-side ubus events).

return baseclass.extend({
	title: _('Containers'),

	load: function() {
		return uxcd.listArray();
	},

	rows: function(containers, self) {
		if (!containers.length)
			return [ E('div', { 'class': 'tr' },
				E('div', { 'class': 'td' }, E('em', _('No containers registered.')))) ];

		return containers.map(function(c) {
			function btn(verb, label, style) {
				return E('button', {
					'class': 'btn cbi-button cbi-button-' + style,
					'title': verb,
					'click': ui.createHandlerFn({}, function() { return uxcd.action(verb, c.name).then(function() { return self.refresh(); }); })
				}, label);
			}
			var url = L.url('admin/containers/overview') + '#' + encodeURIComponent(c.name);
			var actions = c.running
				? [ btn('restart', '↻', 'action'), ' ', btn('stop', '■', 'reset') ]
				: [ btn('start', '▶', 'positive') ];

			return E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'style': 'white-space:nowrap;min-width:12em' }, [
					E('a', { 'href': url }, c.name),
					c.image ? E('div', { 'style': 'color:#888;font-size:90%' }, c.image) : ''
				]),
				E('div', { 'class': 'td', 'style': 'width:2.5em;text-align:center' },
					(c.running && c.web_ports && c.web_ports.length) ? uxcd.webBtn(c) : ''),
				E('div', { 'class': 'td', 'style': 'white-space:nowrap' }, [
					uxcd.statusBadge(c),
					(c.running && c.uptime) ? E('span', { 'style': 'margin-left:.4em;color:#888;font-size:90%' }, '· ' + uxcd.fmtUptime(c.uptime)) : ''
				]),
				E('div', { 'class': 'td', 'style': 'width:100%' }, ''),
				E('div', { 'class': 'td', 'style': 'white-space:nowrap;text-align:right;padding-right:2.5em' }, [
					c.config_changed ? E('span', { 'style': 'margin-left:.4em;color:#f0ad4e;cursor:help', 'title': _('Config changed since launch - restart to apply') }, '⟳') : '',
					(c.update_available && !c.upgrading) ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('update'), 'up')) : '',
					c.upgrading ? E('span', { 'style': 'margin-left:.4em' }, uxcd.badge(_('upgrading'), 'starting')) : ''
				]),
				E('div', { 'class': 'td', 'style': 'text-align:right;white-space:nowrap' }, actions)
			]);
		});
	},

	refresh: function() {
		var self = this;
		return uxcd.listArray().then(function(cs) {
			var el = document.getElementById('uxcd-widget');
			if (el)
				dom.content(el, self.rows(cs, self));
		});
	},

	render: function(containers) {
		var self = this;
		var table = E('div', { 'class': 'table', 'id': 'uxcd-widget' }, this.rows(containers, self));
		poll.add(function() { return self.refresh(); }, 5);
		return table;
	}
});
