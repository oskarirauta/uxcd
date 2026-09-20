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
	# opt-in IPv6 (dual-stack; a v6 address is often globally routable):
	option ipv6    '1'
	option ip6addr 'fd00:10::2/64'     # container IPv6 (ULA; /64 default)
	option ip6gw   'fd00:10::1'        # host-side IPv6 + default route
	list   dns     '8.8.8.8'           # written to /etc/netns/cntr/resolv.conf
```

IPv6 is **opt-in per netns** (`option ipv6 '1'`) and additive to the IPv4 address
— off by default because a v6 address is often globally routable. `ip6addr` takes
an optional `/prefix` (default `/64`); a ULA (`fd00::/8`) is testable without ISP
IPv6. `option slaac '1'` autoconfigures a v6 address from router advertisements
instead of (or besides) a static one. The container's v6 address(es) show up in
`uxc info` / the LuCI detail view under **IPv6 addresses**.

Enabling IPv6 on an **already-running** install adds new proto options, which
netifd only reads at start — reboot, or `/etc/init.d/network restart`, so it
passes `ipv6`/`ip6addr`/… to the handler (a fresh install/boot needs nothing).

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

## Publishing a port to the host

A container in its own (or a shared infra) netns is deliberately unreachable
from the LAN. Sometimes that is exactly half of what you want: isolate it, but
still reach *one* service — a web UI, a site — from a browser. Add `ports` to its
registry entry:

```json
"ports": [ "8080:80", "127.0.0.1:8443:443", "1883:1883/tcp" ]
```

`[bind_ip:]host_port:container_port[/proto]`. With no `bind_ip` the port is bound
on all addresses; give one to narrow it (`127.0.0.1` = this box only). uxcd
resolves the container's netns address itself, so nothing has to be written down
twice.

While the container runs, uxcd keeps a **`tcpredir`** child that listens on the
host port and forwards to the container. It starts with the container and is
killed when it stops, so a published port never outlives the service behind it.
LuCI's web-UI button then opens the published host port instead of the
unreachable netns address.

Requires the `tcpredir` package. Without it, `ports` is reported as unpublished
(with the reason) instead of failing the container; `uxc doctor <name>` says so
too.

### This is a proxy, not a firewall rule

uxcd writes **nothing** to fw4 and reconciles nothing, which is why this exists
where automatic DNAT does not (see the scope note in [ROADMAP.md](../ROADMAP.md)):
a firewall reload cannot drop it, because there is no rule to drop.

The price is that the forwarder opens the connection to the container, so **the
container sees the forwarder as the client, not the real one.** Anything that
logs client addresses or decides on them — an access rule like Caddy's
`not remote_ip …`, a rate limit, geolocation — sees uxcd's box instead. Where
that matters, use a firewall redirect, which rewrites the packet and preserves
the source address:

```
config redirect
	option src           'lan'
	option src_dport     '8080'
	option dest_ip       '10.0.3.2'
	option dest_port     '80'
	option target        'DNAT'
```

or terminate with a protocol that carries the original address (Caddy and nginx
both speak PROXY protocol). Publishing and a firewall redirect are alternatives,
not layers: do not do both for the same port.

### Your own tcpredir is untouched

uxcd passes its redirects to `tcpredir` as command-line arguments and never reads
or writes `/etc/config/tcpredir`. A hand-maintained `tcpredir` service (your own
port redirects, started by procd) and uxcd's published ports coexist without
either owning the other's configuration. They do share the host's port space, so
the two must not both claim the same host port — the loser fails to bind, and
uxcd reports that as the reason its ports are unpublished.

The split shows up on ubus too, and it is worth knowing which object to ask.
`ubus call tcpredir list` answers from the **configured service** and reports only
the redirects in `/etc/config/tcpredir`; uxcd's forwarders are argument-mode
children that register no ubus object at all, and are reported by uxcd itself
(`ports` / `ports_published` in `uxcd list` and `info`). A UI that wants to show
everything reads both and labels them -- which is also how you would hide the
container ports from a page meant for your own redirects.

`luci-app-tcpredir` does exactly that: its Status page lists the redirects from
`/etc/config/tcpredir` alongside a read-only section of the ports uxcd
containers publish, each labelled with where it came from. Removing a container's
port there is not offered, because the container's own configuration decides it
and the forwarder would return the next time the container started.

uxcd supervises its forwarders: one dies (killed by hand, or it loses the bind)
and it is restarted, up to five consecutive attempts, after which uxcd stops and
says so rather than spinning — the usual cause is another process already holding
that host port.
