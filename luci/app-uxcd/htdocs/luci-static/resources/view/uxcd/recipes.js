'use strict';
'require view';
'require ui';
'require dom';
'require poll';
'require uxcd';

// "Recipes": deploy a container from a recipe in one step.
//
// A recipe is a profile that also says where the container comes from - an image
// to pull, or a Dockerfile to build - plus the host directories it needs (with
// the ownership the service expects), the config files to write, and the
// volumes/health check to register. Deploying one is therefore the whole
// sequence that used to be done by hand: pull-or-build, mkdir, chown, write a
// config file, edit /etc/uxc/<name>.json, start.
//
// Nothing here overwrites your work: seeded config files are written only when
// absent, and registry keys only when the entry does not already have them. A
// second deploy of the same recipe rebuilds the bundle and leaves the rest.

return view.extend({
	load: function() {
		return Promise.all([ uxcd.listRecipes(), uxcd.list() ]);
	},

	// progress modal for the deploy job: same poll-the-log dialog the Overview
	// page uses for pull/build, so a deploy looks like what it is - a job.
	watchJob: function(id, onDone) {
		var self = this;
		var pre    = E('pre', { 'style': 'max-height:24em;overflow:auto;white-space:pre-wrap' }, _('starting...'));
		var status = E('p', {}, _('Running...'));
		var pollFn;
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
				if (r && r.error) {
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
					cancelBtn.disabled = true;
					if (r.cancelled) { status.textContent = _('Cancelled.'); self.refresh(); }
					else if (r.exit_code === 0) {
						status.textContent = _('Deployed. Review the container on the Overview page, then start it.');
						if (onDone) onDone();
						self.refresh();
					} else status.textContent = _('Failed (exit %d). See the log below.').format(r.exit_code);
				}
			});
		};
		ui.showModal(_('Deploying'), [
			E('p', _('This can take a while - a build compiles inside the container. The job keeps running even if you close this.')),
			status,
			pre,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': stop }, _('Dismiss')), ' ',
				cancelBtn
			])
		]);
		poll.add(pollFn, 2);
		pollFn();
	},

	// The deploy dialog: container name, optional shared netns, autostart, and an
	// up-front list of exactly what will be created on the host. Showing the
	// paths before the deploy is the point - a recipe writes outside the bundle,
	// and the operator should see where before it happens.
	openDeploy: function(r) {
		var self = this;
		var wName  = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': r.name, 'style': 'width:14em' });
		var wInfra = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': r.infra || '',
		                          'placeholder': _('none (host network)'), 'style': 'width:14em' });
		var wAuto  = E('input', { 'type': 'checkbox', 'class': 'cbi-input-checkbox', 'checked': 'checked' });

		function row(label, widget, help) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [ widget, help ? E('div', { 'class': 'cbi-value-description' }, help) : '' ])
			]);
		}

		var creates = [];
		(r.paths || []).forEach(function(p) {
			var own = '';
			if (p.uid !== undefined || p.gid !== undefined)
				own = ' ' + _('owner %s:%s').format(p.uid !== undefined ? p.uid : '-', p.gid !== undefined ? p.gid : '-');
			creates.push(E('li', {}, [
				E('code', {}, p.path),
				p.exists ? E('em', { 'style': 'opacity:.7' }, ' ' + _('(exists - kept)')) : E('span', {}, ' ' + _('(created)')),
				own ? E('span', { 'style': 'opacity:.7' }, own) : ''
			]));
		});
		(r.seeds || []).forEach(function(s) {
			creates.push(E('li', {}, [
				E('code', {}, s),
				E('span', {}, ' ' + _('(starting config, written only if absent)'))
			]));
		});

		ui.showModal(_('Deploy recipe "%s"').format(r.name), [
			E('p', {}, r.description || ''),
			E('p', {}, r.kind === 'build'
				? [ _('Builds from a Dockerfile on'), ' ', E('code', {}, r.base), '. ',
				    _('The generated Dockerfile is saved next to the bundle and becomes the container\'s recipe: edit it and use Upgrade to rebuild.') ]
				: [ _('Pulls'), ' ', E('code', {}, r.image), '. ', _('Upgrade re-pulls that tag, health-gated, with rollback.') ]),
			E('div', { 'class': 'cbi-section' }, [
				row(_('Container name'), wName, _('Also the registry entry name (/etc/uxc/&lt;name&gt;.json).')),
				row(_('Shared netns'), wInfra, _('An infra netns name to join, so this container and its peers reach each other over 127.0.0.1. Leave empty for the host network (the default). The netns must exist in /etc/config/network first.')),
				row(_('Start on boot'), wAuto, _('Sets autostart. Nothing is started now - review the container first.'))
			]),
			creates.length ? E('div', {}, [
				E('h4', {}, _('This deploy will create on the host')),
				E('ul', { 'style': 'margin-top:.3em' }, creates)
			]) : '',
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', { 'class': 'btn cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						var name = (wName.value || '').trim();
						if (!name) { uxcd.notify(null, E('p', _('A container name is required.')), 'warning'); return; }
						return uxcd.deploy({
							recipe: r.name, name: name,
							infra: (wInfra.value || '').trim(),
							autostart: wAuto.checked
						}).then(function(res) {
							if (res && res.error) { uxcd.notify(null, E('p', _('deploy failed: %s').format(res.error)), 'danger'); return; }
							if (res && res.job) { ui.hideModal(); self.watchJob(res.job); }
						});
					}) }, _('Deploy'))
			])
		]);
	},

	cards: function(data) {
		var self = this;
		var recipes = data.recipes || [];
		if (!recipes.length)
			return E('div', { 'class': 'cbi-section' },
				E('p', {}, [
					E('em', {}, _('No recipes installed.')),
					E('br'),
					_('Recipes live in %s - a recipe is a profile file with a "_source" block. The Overview page\'s "New container" wizard and `uxc pull --profile` use the same directory.').format(data.dir || '/usr/share/docker2uxc/profiles')
				]));

		var rows = [];
		recipes.forEach(function(r) {
			if (r.error) {
				rows.push(E('div', { 'class': 'tr' }, [
					E('div', { 'class': 'td' }, [ E('strong', {}, r.name), E('br'),
						E('span', { 'style': 'color:#c00' }, r.error) ]),
					E('div', { 'class': 'td' }, ''), E('div', { 'class': 'td' }, ''),
					E('div', { 'class': 'td' }, '')
				]));
				return;
			}
			var src = r.kind === 'build'
				? [ E('span', { 'class': 'label' }, _('build')), ' ', E('code', {}, r.base) ]
				: [ E('span', { 'class': 'label' }, _('pull')),  ' ', E('code', {}, r.image) ];
			var creates = (r.creates || []).length;
			rows.push(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td', 'data-title': _('Recipe') }, [
					E('strong', {}, r.name),
					r.deployed ? E('span', { 'style': 'margin-left:.5em;opacity:.7' }, '(' + _('deployed') + ')') : '',
					E('br'),
					E('span', { 'style': 'opacity:.85' }, r.description || '')
				]),
				E('div', { 'class': 'td', 'data-title': _('Source'), 'style': 'white-space:nowrap' }, src),
				E('div', { 'class': 'td', 'data-title': _('Host paths') },
					creates ? _('%d to create').format(creates) : _('all present')),
				E('div', { 'class': 'td', 'style': 'text-align:right;width:12%;padding:5px 0 5px 5px' },
					E('button', { 'class': 'btn cbi-button cbi-button-action',
						'click': ui.createHandlerFn(self, function() { self.openDeploy(r); }) }, _('Deploy...')))
			]));
		});

		return E('div', { 'class': 'table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, _('Recipe')),
				E('div', { 'class': 'th' }, _('Source')),
				E('div', { 'class': 'th' }, _('Host paths')),
				E('div', { 'class': 'th', 'style': 'text-align:right;width:12%' }, _('Actions'))
			])
		].concat(rows));
	},

	refresh: function() {
		var self = this;
		return uxcd.listRecipes().then(function(data) {
			var el = document.getElementById('uxcd-recipes');
			if (el)
				dom.content(el, self.cards(data));
			return data;
		});
	},

	render: function(res) {
		var data = res[0];
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Recipes')),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Deploy a container in one step: a recipe pulls or builds the image, creates the host directories it needs with the right ownership, writes a starting configuration file, and registers the volumes and the health check.'),
				E('br'),
				_('Your edits are safe - configuration files are written only when they do not exist, and registry fields only when the container does not already have them. Deploying again rebuilds the bundle and keeps the rest.'),
				E('br'),
				_('A container deployed from a recipe stays upgradable: "Upgrade" on the Overview page re-pulls, or for a built container re-builds from its recorded Dockerfile, health-gated with rollback to the previous bundle.')
			]),
			E('div', { 'id': 'uxcd-recipes' }, this.cards(data))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
