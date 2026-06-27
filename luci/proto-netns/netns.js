'use strict';
'require form';
'require network';

// LuCI protocol handler for the uxcd `netns` protocol (a persistent, named
// network namespace that uxcd containers join). It is virtual: no base device is
// assigned - the proto creates its own veth pair and bridges/addresses it.
return network.registerProtocol('netns', {
	getI18n: function() {
		return _('Container shared netns (uxcd)');
	},

	getIfname: function() {
		return this._ubus('l3_device') || this.sid;
	},

	getOpkgPackage: function() {
		return 'luci-proto-netns';
	},

	isFloating: function() {
		return true;
	},

	isVirtual: function() {
		return true;
	},

	getDevices: function() {
		return null;
	},

	containsDevice: function(ifname) {
		return (network.getIfnameOf(ifname) == this.getIfname());
	},

	renderFormOptions: function(s) {
		var o;

		// --- general: the network configuration you actually set ---
		o = s.taboption('general', form.Value, 'ipaddr', _('IPv4 address'),
			_('Address assigned inside the namespace.'));
		o.datatype = 'ip4addr("nomask")';
		o.rmempty = false;

		o = s.taboption('general', form.Value, 'netmask', _('IPv4 netmask'));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = '255.255.255.0';
		o.value('255.255.255.0');
		o.value('255.255.0.0');
		o.value('255.0.0.0');

		o = s.taboption('general', form.Value, 'gateway', _('IPv4 gateway'),
			_('Host-side address; also the container default route.'));
		o.datatype = 'ip4addr("nomask")';

		o = s.taboption('general', form.DynamicList, 'dns', _('DNS servers'),
			_('Written to /etc/netns/&lt;name&gt;/resolv.conf and used by member containers.'));
		o.datatype = 'ipaddr';

		// --- advanced: auto-derived, rarely changed ---
		o = s.taboption('advanced', form.Value, 'name', _('Namespace name'),
			_('Name of the netns under /var/run/netns; defaults to the interface name.'));
		o.rmempty = true;

		o = s.taboption('advanced', form.Value, 'device', _('Host veth name'),
			_('Host side of the veth pair; defaults to ns-&lt;name&gt;.'));
		o.rmempty = true;

		o = s.taboption('advanced', form.Value, 'peer', _('Container interface'),
			_('Interface name inside the namespace; defaults to uth0.'));
		o.placeholder = 'uth0';
		o.rmempty = true;
	}
});
