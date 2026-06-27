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
ubus call uxcd log     '{"name":"frigate","lines":50}'
ubus call uxcd start   '{"name":"frigate"}'
ubus call uxcd stop    '{"name":"frigate"}'
ubus call uxcd restart '{"name":"frigate"}'
```

Containers are launched as `ujail -J <bundle>`; networking and firewalling are
handled by netifd/ujail from `/etc/config/network` exactly as with uxc (host
network, or an isolated veth via `proto infra`).

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
4. run as a service + autostart - done
5. registration (`uxcd.create`/`remove`) so `uxc` is not needed; docker2uxc uses uxcd
6. `uxexec` companion CLI (exec/shell into a container) + command-exec healthcheck
7. shared-namespace "pods"
8. luci-app-uxcd
