'use strict';
'require view';
'require poll';
'require ui';
'require dom';
'require uxcd';

// "Images & storage": disk/RAM used by container bundles (+ their .prev rollback
// backups) and the docker2uxc blob cache, with prune buttons. Shares uxcd.js.

return view.extend({
	load: function() {
		return uxcd.images();
	},

	pruneBtn: function(target, label, style) {
		var self = this;
		return E('button', {
			'class': 'btn cbi-button cbi-button-' + style,
			'click': ui.createHandlerFn(self, function() {
				return uxcd.prune(target).then(function(r) {
					if (!r) return;
					uxcd.notify(null, E('p',
						_('Freed %s (%d item(s)).').format(uxcd.fmtBytes(r.freed || 0), (r.removed || []).length)), 'info');
					return self.refresh();
				});
			})
		}, label);
	},

	content: function(data) {
		var cache   = data.cache || {};
		var bundles = data.bundles || {};
		var names   = Object.keys(bundles).sort();

		var rows = [ E('div', { 'class': 'tr table-titles' }, [
			E('div', { 'class': 'th' }, _('Name')),
			E('div', { 'class': 'th' }, _('Bundle path')),
			E('div', { 'class': 'th' }, _('Size')),
			E('div', { 'class': 'th' }, _('State')),
			E('div', { 'class': 'th' }, _('Backup (.prev)'))
		]) ];

		if (!names.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No registered bundles.')))));

		names.forEach(function(n) {
			var b = bundles[n];
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Name') }, n),
				E('div', { 'class': 'td', 'data-title': _('Bundle path') }, b.path || '-'),
				E('div', { 'class': 'td', 'data-title': _('Size') }, uxcd.fmtBytes(b.size || 0)),
				E('div', { 'class': 'td', 'data-title': _('State') },
					uxcd.badge(b.running ? _('running') : _('stopped'), b.running ? 'running' : 'stopped')),
				E('div', { 'class': 'td', 'data-title': _('Backup (.prev)') },
					(b.prev != null) ? uxcd.fmtBytes(b.prev) : '-')
			]));
		});

		return [
			E('h3', {}, _('Image download cache')),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('docker2uxc cache')),
				E('div', { 'class': 'cbi-value-field' }, [
					E('span', {}, (cache.path || '/tmp/docker2uxc-cache') + ' — ' + uxcd.fmtBytes(cache.size || 0)),
					E('div', { 'class': 'cbi-value-description' },
						_('Downloaded image layers. On OpenWrt /tmp is RAM, so pruning frees memory; it is safe (layers are re-fetched on the next pull).'))
				])
			]),

			E('h3', {}, _('Bundles')),
			E('div', { 'class': 'table', 'id': 'uxcd-images' }, rows),

			E('div', { 'style': 'margin-top:1em' }, [
				this.pruneBtn('cache', _('Prune cache'), 'reset'), ' ',
				this.pruneBtn('prev', _('Prune backups'), 'reset'), ' ',
				this.pruneBtn('all', _('Prune all'), 'negative')
			])
		];
	},

	refresh: function() {
		var self = this;
		return uxcd.images().then(function(data) {
			var el = document.getElementById('uxcd-storage');
			if (el)
				dom.content(el, self.content(data));
			return data;
		});
	},

	render: function(data) {
		var self = this;
		poll.add(function() { return self.refresh(); }, 10);
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Images & storage')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Disk and RAM used by container bundles and the image download cache.')),
			E('div', { 'id': 'uxcd-storage' }, this.content(data))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
