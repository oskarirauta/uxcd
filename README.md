[![License:MIT](https://img.shields.io/badge/License-MIT-blue?style=plastic)](LICENSE)

# uxcd

A small supervisor **daemon for OpenWrt's `uxc` containers**. It exposes a ubus
object (`uxcd`) that reports each container's state and resource usage and (later)
drives its lifecycle - so a LuCI front page can show a "Containers" panel and
start/stop/restart them.

The package ships three programs:

- **`uxcd`** - the supervisor daemon (launches/supervises containers, ubus API).
- **`uxc`** - a command-line client for uxcd; a drop-in-style replacement for
  the stock OpenWrt `uxc` tool (the package `CONFLICTS:=uxc`).
- **`uxe`** - run a command or shell inside a running container (`docker exec`).

The stock `uxc` is a thin CLI over procd/ujail; this stack adds the management
and observability layer: stats, logs, events and an intent-aware restart policy.

> **Not an OpenWrt project.** Despite the `u`-prefixed name, uxcd is an
> independent, third-party alternative to OpenWrt's `uxc` — it is not part of,
> affiliated with, or endorsed by the OpenWrt project. It reuses OpenWrt's
> ubox/ubus/ujail building blocks but is maintained separately.

> Status: **work in progress.** uxcd owns the container lifecycle (it launches
> ujail itself) with intent-aware restart, captured logs and healthchecks.
> Containers survive a uxcd restart: on startup it re-adopts any still-running
> ones (by their `ujail -n <name>` process) instead of starting a second copy.

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

uxcd also broadcasts a ubus event `uxcd.container` on each state change
(`started`, `exited`, `healthy`, `unhealthy`, `adopted`) with `{name, event,
running, health}`, so a UI can update live instead of polling:

```sh
ubus listen uxcd.container
```

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

## Command-line tools

`uxc` drives uxcd over ubus (no need to call `ubus` by hand):

```sh
uxc list [--json]                 # all containers: state, health, pid, memory
uxc info|state <name>             # full detail for one container
uxc start|stop|restart <name>     # lifecycle
uxc log <name> [-n <lines>]       # captured stdout/stderr
uxc create <name> --bundle <path> [--autostart] [--infra <netns>] [--no-respawn]
uxc pull <image> [name] [--autostart] [--infra <netns>] [--out <dir>]
uxc build <dockerfile|dir> [name] # build from a Dockerfile, no Docker (docker2uxcd)
uxc rollback <name>               # revert to the previous bundle (.prev) + restart
uxc remove|delete <name>          # unregister
uxc enable|disable <name>         # start on boot, or not
uxc attach <name>                 # shell inside the container (via uxe)
```

`uxc pull` fetches and converts a registry image and registers it, by running
the `docker2uxcd` converter (the uxcd-aware branch of docker2uxc, installed
alongside or vendored as a submodule). `uxc build` builds an image from a
Dockerfile the same way (single-stage, host arch) - no Docker daemon required,
which is handy when an image is only available as a Dockerfile behind auth.

`uxe` runs a command (default `/bin/sh`) inside a running container by joining
its namespaces. A pty is allocated automatically for an interactive shell on a
terminal (force with `-t`, disable with `-T`):

```sh
uxe <name>                        # interactive shell (pty)
uxe <name> ip -br addr            # one-off command
uxe -u 1000:1000 <name> id        # as a specific uid[:gid]
uxe -w /srv <name> sh             # in a working directory
```

### Healthcheck (optional, per container in /etc/uxc/<name>.json)

```json
"healthcheck": {
  "interval": 30, "retries": 3, "on_unhealthy": "restart",
  "checks": [
    { "type": "http", "target": "127.0.0.1:5000/api/version" },
    { "type": "resource", "memory_max": 1610612736, "cpu_max": 90 },
    { "type": "exec", "command": ["/bin/sh","-c","pgrep frigate"], "timeout": 5 }
  ]
}
```

`tcp`/`http` probe a port; `resource` checks cgroup memory/cpu; `exec` runs a
command inside the container (joining its namespaces, like `uxe`) and treats a
non-zero exit (or `timeout` seconds) as a failure. State is reported as `health`
in `list`; with `on_unhealthy: "restart"` the container is restarted.

## Configuration

Global daemon settings live in `/etc/config/uxcd` (UCI); per-container settings
stay in `/etc/uxc/<name>.json` (same location as the stock `uxc`). A missing
file or option keeps the built-in default, so uxcd runs out of the box.

### Per-container settings (`/etc/uxc/<name>.json`)

Beyond `path`/`autostart`/`respawn`/`infra`/`healthcheck`, a container may carry
runtime overrides that uxcd merges into a generated shadow OCI bundle at launch.
Keeping them here (not in the image's `config.json`) means they survive an image
update/re-pull:

```json
{
  "name": "frigate", "path": "/srv/frigate", "autostart": true,
  "volumes": ["/srv/frigate/config:/config", "/srv/media:/media:ro"],
  "devices": ["/dev/dri", "/dev/bus/usb/001/004"],
  "env": ["TZ=Europe/Helsinki", "FRIGATE_RTSP_PASSWORD=secret"],
  "resources": { "memory": { "limit": 2147483648 }, "pids": { "limit": 512 } },
  "depends_on": ["mqtt"]
}
```

- `volumes`: `src:dst[:ro]` bind mounts.
- `devices`: device node paths (or a directory, whose nodes are added); each gets
  a device node **and** a cgroup device-allow rule, so e.g. `/dev/dri` works.
- `env`: `KEY=VAL` added to the container's environment.
- `resources`: OCI `linux.resources` merged over the image's (memory/pids/cpu/...).
- `depends_on`: other containers that must be running first - they are started
  automatically and this one waits for them (boot order falls out of this).

```
config uxcd 'main'
	# option socket        '/var/run/ubus/ubus.sock'  # default: libubus built-in
	option log_lines       '200'    # default number of lines `uxc log` returns
	option log_size        '64'     # KB per-container log file before rotation
	option restart_delay   '2'      # s, base delay before respawning an exited container
	option restart_max_delay '60'   # s, cap for the exponential crash backoff
	option max_restarts    '0'      # give up after N rapid crashes (0 = never give up)
	option stop_timeout    '5'      # s, SIGTERM grace before SIGKILL
	option infra_watch     '5'      # s, infra-netns watchdog interval
	option probe_timeout   '1500'   # ms, tcp/http healthcheck connect timeout
	option debug           '0'      # verbose/debug logging
```

`uxcd` also takes `-s <socket>`, `-d` (debug) and `-h`/`-V` on the command line;
`-s`/`-d` override the config file.

Each container's stdout/stderr is captured to `/var/log/uxcd/<name>.log`
(rotated to `.log.1` past `log_size` KB), so `uxc log` survives a uxcd restart.

## Roadmap

1. ~~list - state + cgroup resource stats~~ done
2. ~~lifecycle - start/stop/restart + intent-aware restart~~ done
3. ~~logs - per-container ring buffer~~, ~~healthcheck~~ done
4. ~~run as a service + autostart~~ done
5. ~~registration (`uxcd.create`/`remove`) so `uxc` is not needed~~ done
6. ~~`info` - full per-container detail (command, netns, addresses, settings)~~ done
7. ~~shared-namespace "pods" (infra netns + `netns` proto + resolv.conf)~~ done
8. ~~`uxe` companion CLI (exec/shell into a container, with pty)~~ done; command-exec healthcheck pending
9. ~~`uxc` CLI (drop-in for stock uxc)~~ done
10. OpenWrt package (`CONFLICTS:=uxc`)
11. docker2uxc -> docker2uxcd (use uxcd registration instead of plain uxc)
12. luci-app-uxcd
