#!/bin/sh
#
# netifd protocol: netns
#
# Creates a persistent, named network namespace (/var/run/netns/<name>) that
# uxcd-managed containers can join via the OCI config `linux.namespaces` entry
#   { "type": "network", "path": "/var/run/netns/<name>" }
# so several containers share one network stack (a "pod"/"infra" netns):
#
#   - loopback (lo) is brought up inside the netns, so members reach each other
#     on 127.0.0.1 (east-west, e.g. nginx -> php-fpm);
#   - a veth pair gives the netns its own address (north-south): the host side
#     is handed to netifd so it lands in a firewall zone, the netns side gets
#     the address and default route.
#
# The host->container / not container->host policy is firewall configuration and
# is the administrator's responsibility (assign the host-side interface to a zone
# and add the wanted forwards), exactly as with plain uxc networking.
#
# Example /etc/config/network:
#
#   config interface 'cntr'
#       option proto   'netns'
#       option name    'cntr'              # netns name (default: interface name)
#       option device  'ns-cntr'           # host-side veth (default: ns-<name>)
#       option ipaddr  '10.10.0.2'         # address INSIDE the netns
#       option netmask '255.255.255.0'     # or a /prefix
#       option gateway '10.10.0.1'         # host-side address + default route
#
# Part of the uxcd project (https://github.com/oskarirauta/uxcd), not OpenWrt.

[ -n "$INCLUDE_ONLY" ] || {
	. /lib/functions.sh
	. ../netifd-proto.sh
	init_proto "$@"
}

proto_netns_init_config() {
	no_device=1
	available=1

	proto_config_add_string "name"
	proto_config_add_string "device:device"
	proto_config_add_string "peer"
	proto_config_add_string "ipaddr"
	proto_config_add_string "netmask"
	proto_config_add_string "gateway"
	proto_config_add_array "dns"
}

proto_netns_setup() {
	local cfg="$1"
	local name device peer ipaddr netmask gateway mask tmp dns d

	json_get_vars name device peer ipaddr netmask gateway
	json_get_values dns dns

	[ -n "$name" ]   || name="$cfg"
	[ -n "$device" ] || device="ns-$name"
	[ -n "$peer" ]   || peer="eth0"

	[ -n "$ipaddr" ] || {
		echo "netns $cfg: ipaddr not set"
		proto_notify_error "$cfg" "NO_IP_ADDRESS"
		return 1
	}

	mask="$netmask"
	[ "$(echo "$netmask" | cut -c1-1)" = "/" ] && mask="$(echo "$netmask" | cut -c2-)"
	[ -n "$mask" ] || mask="$(/bin/ipcalc.sh "$ipaddr" "$netmask" | grep PREFIX | cut -d'=' -f2)"

	[ -n "$mask" ] || {
		echo "netns $cfg: invalid netmask"
		proto_notify_error "$cfg" "INVALID_NETMASK"
		return 1
	}

	# (re)create the persistent named netns. Recreating drops any old state, so
	# member containers must be (re)started after reconfiguring the netns -- uxcd
	# orders this for autostarted containers.
	ip netns list 2>/dev/null | grep -qw "$name" && ip netns delete "$name"
	ip netns add "$name" || {
		echo "netns $cfg: failed to create namespace $name"
		proto_notify_error "$cfg" "NETNS_ADD_FAILED"
		return 1
	}
	ip -n "$name" link set lo up

	# veth: create the peer with a temporary name so it never clashes with a
	# host interface (e.g. a real eth0), move it in, then rename inside the netns.
	tmp="v-${name}-p"
	ip link show "$device" >/dev/null 2>&1 && ip link delete "$device"
	ip link add "$device" type veth peer name "$tmp" || {
		echo "netns $cfg: failed to create veth $device"
		ip netns delete "$name"
		proto_notify_error "$cfg" "VETH_ADD_FAILED"
		return 1
	}
	ip link set "$tmp" netns "$name"
	ip -n "$name" link set "$tmp" name "$peer"
	ip -n "$name" addr add "${ipaddr}/${mask}" dev "$peer"
	ip -n "$name" link set "$peer" up

	[ -n "$gateway" ] &&
		ip -n "$name" route add default via "$gateway"

	# Write the netns resolver to the standard /etc/netns/<name>/resolv.conf.
	# uxcd bind-mounts this into member containers as /etc/resolv.conf, because
	# ujail otherwise shares the host's resolv.conf - whose nameserver may be a
	# host-only loopback resolver that is unreachable from inside the netns.
	if [ -n "$dns" ]; then
		mkdir -p "/etc/netns/$name"
		: > "/etc/netns/$name/resolv.conf"
		for d in $dns; do
			echo "nameserver $d" >> "/etc/netns/$name/resolv.conf"
		done
	else
		rm -f "/etc/netns/$name/resolv.conf"
	fi

	# Hand the host-side veth to netifd: it gets the gateway address and can be
	# referenced from /etc/config/firewall as a normal interface for zoning.
	proto_init_update "$device" 1
	[ -n "$gateway" ] && proto_add_ipv4_address "$gateway" "$mask"
	proto_add_data
	json_add_string "netns" "$name"
	json_add_string "peer" "$peer"
	proto_close_data
	proto_send_update "$cfg"

	echo "netns $name is up (${ipaddr}/${mask}, host veth $device)"
}

proto_netns_teardown() {
	local cfg="$1"
	local name device

	json_get_vars name device
	[ -n "$name" ]   || name="$cfg"
	[ -n "$device" ] || device="ns-$name"

	# Deleting the netns removes the peer veth; the host side goes with it.
	ip netns list 2>/dev/null | grep -qw "$name" && ip netns delete "$name"
	ip link show "$device" >/dev/null 2>&1 && ip link delete "$device"
	rm -rf "/etc/netns/$name"
	return 0
}

[ -n "$INCLUDE_ONLY" ] || {
	add_protocol netns
}
