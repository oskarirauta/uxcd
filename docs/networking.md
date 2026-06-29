# Networking

A container's network is one of three modes:

- **host** — shares the host network stack (all interfaces, including WAN).
  Simplest, least isolated. The default for a plain pull/build.
- **isolated** — its own network namespace (ujail jail networking, as with stock
  `uxc`). Isolated, but on its own it has no configured connectivity.
- **infra (shared netns)** — joins a persistent, named network namespace that
  several containers can share (a "pod"); see below.

> **OpenWrt owns the firewall and DNS.** uxcd does container networking via the
> `netns` proto only — it never writes firewall (fw4) or DNS (dnsmasq) rules.
> Assigning veths to zones, port forwards and DNS are the administrator's job,
> exactly as with plain uxc. (Auto firewall rules are fragile on OpenWrt — a
> VPN/firewall reload drops them — so this is deliberate.)

## Shared network namespace (infra / pods)

Several containers can share one network stack — reaching each other over
`127.0.0.1` (e.g. nginx → php-fpm) while being exposed to the outside as one
address. uxcd ships a netifd **`netns`** protocol (installed to
`/lib/netifd/proto/netns.sh`) that creates a persistent, named netns and wires
its veth + DNS:

```
config interface 'cntr'
	option proto   'netns'
	option name    'cntr'              # netns -> /var/run/netns/cntr
	option ipaddr  '10.10.0.2'         # address inside the netns
	option netmask '255.255.255.0'
	option gateway '10.10.0.1'         # host-side address + default route
	list   dns     '8.8.8.8'           # written to /etc/netns/cntr/resolv.conf
```

A container joins by setting `"infra": "cntr"` in its `/etc/uxc/<name>.json`. At
launch uxcd generates a shadow OCI bundle that points the container's network
namespace at `/var/run/netns/cntr` (`ujail` setns()es into it) and bind-mounts
`/etc/netns/cntr/resolv.conf` over the container's `/etc/resolv.conf` (otherwise
ujail shares the host resolver, which may be unreachable from the netns). uxcd
brings the infra interface up before launching members, and a watchdog restores
it (and restarts members) if it is torn down underneath them.

> **Activating the proto:** netifd only scans `/lib/netifd/proto/` at start, so
> after installing the package restart netifd (`/etc/init.d/network restart` —
> note this briefly bounces every interface incl. WAN — or reboot) before `netns`
> appears in LuCI's interface-protocol list / `ubus call network
> get_proto_handlers`.

The `host → container, not container → host` isolation is firewall configuration
(assign the host-side veth to a zone, add the wanted forwards) and remains the
administrator's responsibility.

## The `network.uci` snippet (isolated containers)

`uxc pull`/`build` with `--network isolated` (or `--emit-netconfig`) writes a
ready-to-review `network.uci` into the bundle directory: a veth pair (host side
bridged, container side handed to the container's netns via the `infra` proto).
It is **never applied automatically** — review and edit the bridge/addressing,
then:

```sh
cat network.uci >> /etc/config/network && /etc/init.d/network reload
```

`--net-bridge <br>` sets the bridge it attaches the host side to (default
`br-lan`). This is a starting point; the firewall wiring is still yours to add.
