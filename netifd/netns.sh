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
#   - a veth pair gives the netns its address (north-south). In the default
#     "routed" mode the host side gets the gateway address (a separate subnet the
#     admin routes/firewalls); in "bridged" mode the host side becomes a port of an
#     existing bridge (e.g. br-lan), so the container is an L2 peer ON that LAN -
#     reachable from the LAN, with no WAN interface, so it is NOT WAN-exposed.
#
# The host->container / not container->host policy is firewall configuration and is
# the administrator's responsibility: in routed mode assign the host-side interface
# to a zone; in bridged mode the container sits in the bridge's zone (e.g. lan).
#
# Example /etc/config/network (routed - separate subnet):
#
#   config interface 'cntr'
#       option proto   'netns'
#       option name    'cntr'              # netns name (default: interface name)
#       option device  'ns-cntr'           # host-side veth (default: ns-<name>)
#       option ipaddr  '10.10.0.2'         # address INSIDE the netns
#       option netmask '255.255.255.0'     # or a /prefix
#       option gateway '10.10.0.1'         # host-side address + default route
#
# Example /etc/config/network (bridged - LAN peer, not WAN-exposed):
#
#   config interface 'lanc'
#       option proto   'netns'
#       option mode    'bridged'
#       option bridge  'br-lan'            # bridge to join (default br-lan)
#       option ipaddr  '10.0.1.5'          # static LAN address INSIDE the netns
#       option netmask '255.255.0.0'       # the LAN netmask
#       option gateway '10.0.0.1'          # LAN gateway (router LAN IP); container default route
#       list   dns     '10.0.0.1'          # LAN DNS
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
	proto_config_add_string "mode"      # "routed" (default) or "bridged"
	proto_config_add_string "bridge"    # bridged mode: bridge to attach to (default br-lan)
	proto_config_add_array "dns"
}

# Delete an interface only if it is a veth, so a device name that collides with a
# pre-existing host link (bridge/vlan/bond/...) is never clobbered - high blast
# radius (could take down br-lan). The ns-<name> veths we create pass; a foreign
# same-named link is left alone with a warning.
delete_if_veth() {
	local dev="$1"
	ip link show "$dev" >/dev/null 2>&1 || return 0
	if ip -d link show "$dev" 2>/dev/null | grep -qw veth; then
		ip link delete "$dev"
	else
		echo "netns: refusing to delete '$dev' - not a veth (pre-existing host interface?)"
	fi
}

proto_netns_setup() {
	local cfg="$1"
	local name device peer ipaddr netmask gateway mode bridge mask tmp dns d

	json_get_vars name device peer ipaddr netmask gateway mode bridge
	json_get_values dns dns

	[ -n "$name" ]   || name="$cfg"
	[ -n "$device" ] || device="ns-$name"
	[ -n "$peer" ]   || peer="uth0"   # not ethX: avoid clashing with physical NIC names
	[ -n "$mode" ]   || mode="routed"
	[ -n "$bridge" ] || bridge="br-lan"

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
	delete_if_veth "$device"
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

	# bridged mode: make the host-side veth a port of the LAN bridge so the container
	# is an L2 peer ON the LAN (reachable from the LAN, NO WAN interface, so it is not
	# WAN-exposed; fw4 treats its traffic as the bridge's zone, e.g. lan). The
	# container side already has its static LAN ipaddr + optional default route via
	# the LAN gateway; the host-side veth carries no IP in this mode.
	if [ "$mode" = "bridged" ]; then
		ip link set "$device" master "$bridge" 2>/dev/null || {
			echo "netns $cfg: failed to add $device to bridge $bridge"
			ip netns delete "$name"
			delete_if_veth "$device"
			proto_notify_error "$cfg" "BRIDGE_ADD_FAILED"
			return 1
		}
		ip link set "$device" up
	fi

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

	# Hand the host-side veth to netifd so it can be referenced from
	# /etc/config/firewall. routed: the veth carries the gateway address (netifd
	# manages it). bridged: the veth is a bridge port (flag it external so netifd does
	# not manage/flush it) - the container is zoned via the bridge (e.g. lan) instead.
	if [ "$mode" = "bridged" ]; then
		proto_init_update "$device" 1 1
	else
		proto_init_update "$device" 1
		[ -n "$gateway" ] && proto_add_ipv4_address "$gateway" "$mask"
	fi
	proto_add_data
	json_add_string "netns" "$name"
	json_add_string "peer" "$peer"
	[ "$mode" = "bridged" ] && json_add_string "bridge" "$bridge"
	proto_close_data
	proto_send_update "$cfg"

	if [ "$mode" = "bridged" ]; then
		echo "netns $name is up (${ipaddr}/${mask}, bridged into $bridge via $device)"
	else
		echo "netns $name is up (${ipaddr}/${mask}, routed via host veth $device)"
	fi
}

proto_netns_teardown() {
	local cfg="$1"
	local name device

	json_get_vars name device
	[ -n "$name" ]   || name="$cfg"
	[ -n "$device" ] || device="ns-$name"

	# Deleting the netns removes the peer veth; the host side goes with it.
	ip netns list 2>/dev/null | grep -qw "$name" && ip netns delete "$name"
	delete_if_veth "$device"
	rm -rf "/etc/netns/$name"
	return 0
}

[ -n "$INCLUDE_ONLY" ] || {
	add_protocol netns
}
