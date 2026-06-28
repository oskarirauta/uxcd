'use strict';
'require view';
'require ui';
'require dom';
'require uxcd';

// "Registries": credentials for private / authenticated image registries. The
// daemon stores them in /etc/uxcd/auth.json (Docker "auths"); docker2uxcd uses
// them for pull / update-check / upgrade. Passwords are write-only - the daemon
// never returns them, so the list shows only host + username.

return view.extend({
	load: function() {
		return uxcd.registryList();
	},

	addForm: function() {
		var self = this;
		var wReg  = E('input', { 'type': 'text',     'class': 'cbi-input-text', 'placeholder': 'ghcr.io',              'style': 'width:14em' });
		var wUser = E('input', { 'type': 'text',     'class': 'cbi-input-text', 'placeholder': _('username'),         'style': 'width:12em' });
		var wPass = E('input', { 'type': 'password', 'class': 'cbi-input-text', 'placeholder': _('password / token'), 'style': 'width:16em' });
		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Add or update a registry')),
			E('div', { 'style': 'display:flex;gap:.5em;flex-wrap:wrap;align-items:center' }, [
				wReg, wUser, wPass,
				E('button', { 'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var r = (wReg.value || '').trim();
						if (!r) { ui.addNotification(null, E('p', _('Registry host is required.')), 'warning'); return; }
						return uxcd.registrySet(r, (wUser.value || '').trim(), wPass.value || '').then(function(ok) { if (ok) return self.refresh(); });
					}) }, _('Save'))
			]),
			E('p', { 'class': 'cbi-section-descr' }, _('Host exactly as it appears in the image reference (ghcr.io, docker.io, registry.example.com). For Docker Hub and GHCR the password is a personal access token. Saving overwrites any existing entry for that host.'))
		]);
	},

	listTable: function(regs) {
		var self = this;
		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Registry')),
			E('div', { 'class': 'th' }, _('Username')),
			E('div', { 'class': 'th cbi-section-actions' }, _('Actions'))
		]) ];
		if (!regs.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No registries configured - public images need no credentials.')))));
		regs.forEach(function(r) {
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Registry') }, r.registry),
				E('div', { 'class': 'td', 'data-title': _('Username') }, r.username || '-'),
				E('div', { 'class': 'td cbi-section-actions' },
					E('button', { 'class': 'btn cbi-button cbi-button-negative',
						'click': ui.createHandlerFn(self, function() { return uxcd.registryRemove(r.registry).then(function(ok) { if (ok) return self.refresh(); }); }) }, _('Remove')))
			]));
		});
		return E('div', { 'class': 'table' }, rows);
	},

	inner: function(regs) {
		return [ this.addForm(), E('h3', { 'style': 'margin-top:1em' }, _('Configured registries')), this.listTable(regs) ];
	},

	refresh: function() {
		var self = this;
		return uxcd.registryList().then(function(regs) {
			var el = document.getElementById('uxcd-registries');
			if (el)
				dom.content(el, self.inner(regs));
			return regs;
		});
	},

	render: function(regs) {
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Registries')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Credentials for private / authenticated image registries, used by docker2uxcd for pull, update check and upgrade. Stored by uxcd in /etc/uxcd/auth.json (0600); passwords are never shown again.')),
			E('div', { 'id': 'uxcd-registries' }, this.inner(regs))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
