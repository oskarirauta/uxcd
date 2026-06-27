[![License:MIT](https://img.shields.io/badge/License-MIT-blue?style=plastic)](LICENSE)

# uxcd

A small supervisor **daemon for OpenWrt's `uxc` containers**. It exposes a ubus
object (`uxcd`) that reports each container's state and resource usage and (later)
drives its lifecycle - so a LuCI front page can show a "Containers" panel and
start/stop/restart them.

`uxc` itself is a thin CLI over procd/ujail; uxcd adds the management and
observability layer on top: stats, logs, events and an intent-aware restart
policy.

> **Not an OpenWrt project.** Despite the `u`-prefixed name, uxcd is an
> independent, third-party alternative to OpenWrt's `uxc` — it is not part of,
> affiliated with, or endorsed by the OpenWrt project. It reuses OpenWrt's
> ubox/ubus/ujail building blocks but is maintained separately.

> Status: **work in progress.** uxcd owns the container lifecycle (it launches
> ujail itself) with intent-aware restart, captured logs and healthchecks.

## Building

```sh
git clone --recursive https://github.com/oskarirauta/uxcd.git
cd uxcd
make
```

Depends on libubox + libubus (OpenWrt). The C++ helpers are vendored as
submodules:

- [ubus_cpp](https://github.com/oskarirauta/ubus_cpp) (→ [json_cpp](https://github.com/oskarirauta/json_cpp))
- [logger_cpp](https://github.com/oskarirauta/logger_cpp)
- [SIG_cpp](https://github.com/oskarirauta/SIG_cpp)

## Install as a service

```sh
make && make install                 # -> /usr/sbin/uxcd, /etc/init.d/uxcd
/etc/init.d/uxc disable               # uxcd replaces procd's "uxc boot" autostart
/etc/init.d/uxcd enable && /etc/init.d/uxcd start
```

uxcd reads the same registry as uxc (`/etc/uxc/<name>.json`: `path` = bundle,
`autostart` = start on boot) and is the sole autostarter, so `/etc/init.d/uxc`
must be disabled to avoid double-starting containers. The `uxc` CLI may still be
used for ad-hoc registration.

## ubus interface

```sh
ubus call uxcd list                                   # all containers + state + stats + health
ubus call uxcd info    '{"name":"frigate"}'           # one container, full detail (cmd, netns, ip, ...)
ubus call uxcd log     '{"name":"frigate","lines":50}'
ubus call uxcd start   '{"name":"frigate"}'
ubus call uxcd stop    '{"name":"frigate"}'
ubus call uxcd restart '{"name":"frigate"}'
ubus call uxcd create  '{"name":"web","bundle":"/srv/web","autostart":true,"infra":"cntr"}'
ubus call uxcd remove  '{"name":"web"}'
```

`info` returns everything `list` reports for one container plus the OCI command/
cwd/hostname/root, uptime, restart count, the config file path, the effective
settings (`autostart`, `respawn`) and the network namespace + its addresses - so
a UI has a single place to read it all.

Containers are launched as `ujail -J <bundle>`; networking and firewalling are
handled by netifd/ujail from `/etc/config/network`. A container is `host`
network (shares the host stack), its own isolated netns (ujail jail networking,
as with uxc), or a member of a shared **infra** netns (see below).

### Shared network namespace (infra/pods)

Several containers can share one network stack - reaching each other over
`127.0.0.1` (e.g. nginx -> php-fpm) while being exposed to the outside as one
address. uxcd ships a netifd `netns` protocol (installed to
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

A container joins by setting `"infra": "cntr"` in its `/etc/uxc/<name>.json`.
uxcd then, at launch, generates a shadow OCI bundle that points the container's
network namespace at `/var/run/netns/cntr` (`ujail` setns()es into it) and
bind-mounts `/etc/netns/cntr/resolv.conf` over the container's `/etc/resolv.conf`
(otherwise ujail shares the host resolver, which may be unreachable from the
netns). uxcd brings the infra interface up before launching members, and a
watchdog restores it (and restarts members) if it is torn down underneath them.

The `host -> container, not container -> host` isolation is firewall
configuration (assign the host-side veth to a zone, add the wanted forwards) and
remains the administrator's responsibility, exactly as with plain uxc.

### Healthcheck (optional, per container in /etc/uxc/<name>.json)

```json
"healthcheck": {
  "interval": 30, "retries": 3, "on_unhealthy": "restart",
  "checks": [
    { "type": "http", "target": "127.0.0.1:5000/api/version" },
    { "type": "resource", "memory_max": 1610612736, "cpu_max": 90 }
  ]
}
```

`tcp`/`http` probe a port; `resource` checks cgroup memory/cpu. State is reported
as `health` in `list`; with `on_unhealthy: "restart"` the container is restarted.

## Roadmap

1. ~~list - state + cgroup resource stats~~ done
2. ~~lifecycle - start/stop/restart + intent-aware restart~~ done
3. ~~logs - per-container ring buffer~~, ~~healthcheck~~ done
4. ~~run as a service + autostart~~ done
5. ~~registration (`uxcd.create`/`remove`) so `uxc` is not needed~~ done
6. ~~`info` - full per-container detail (command, netns, addresses, settings)~~ done
7. ~~shared-namespace "pods" (infra netns + `netns` proto + resolv.conf)~~ done
8. `uxexec` companion CLI (exec/shell into a container) + command-exec healthcheck
9. docker2uxc -> docker2uxcd (use uxcd registration instead of plain uxc)
10. luci-app-uxcd
