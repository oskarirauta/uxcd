[![License:MIT](https://img.shields.io/badge/License-MIT-blue?style=plastic)](LICENSE)

# uxcd

A small supervisor **daemon for OpenWrt's `uxc` containers**. It owns the
container lifecycle (it launches `ujail` itself) with an intent-aware restart
policy, captured logs, healthchecks and a ubus API — so a LuCI front page can
show a "Containers" panel and start/stop/restart/update them.

The package ships three programs:

- **`uxcd`** — the supervisor daemon (launches/supervises containers, ubus API).
- **`uxc`** — a command-line client for uxcd; a drop-in-style replacement for the
  stock OpenWrt `uxc` tool (the package `CONFLICTS:=uxc`).
- **`uxe`** — run a command or shell inside a running container (`docker exec`).

The stock `uxc` is a thin CLI over procd/ujail; this stack adds the management and
observability layer: stats, logs, events, healthchecks, image pull/build/update
and an intent-aware restart policy.

> **Not an OpenWrt project.** Despite the `u`-prefixed name, uxcd is an
> independent, third-party alternative to OpenWrt's `uxc` — it is not part of,
> affiliated with, or endorsed by the OpenWrt project. It reuses OpenWrt's
> ubox/ubus/ujail building blocks but is maintained separately.

> Status: **work in progress.** Containers survive a uxcd restart: on startup it
> re-adopts any still-running ones (by their `ujail -n <name>` process) instead of
> starting a second copy.

## Features

- **Lifecycle & supervision** — start/stop/restart, intent-aware restart with
  exponential crash backoff, re-adoption across a daemon restart.
- **Observability** — per-container state, cgroup cpu/memory/pids, captured logs,
  an event timeline, OOM/exit-reason/PSI, and Prometheus metrics.
- **Healthchecks** — tcp/http/resource/exec probes, optional restart-on-unhealthy.
- **Images, no Docker** — `uxc pull` / `uxc build` fetch+convert a registry image
  or build from a Dockerfile (the converter is built in), with profiles, private
  registries, update detection and a health-gated one-click safe-upgrade +
  auto-rollback.
- **Networking** — host, isolated, or a shared **infra** netns ("pods") via a
  netifd `netns` proto.
- **Scheduling** — per-container cron actions (restart/stop/start), no `crond`.
- **LuCI app** — a "Containers" tab + a Status-overview widget.

## Building

```sh
git clone --recursive https://github.com/oskarirauta/uxcd.git
cd uxcd
make
```

Depends on libubox + libubus (OpenWrt). The C++ helpers and the converter are
vendored as submodules: ubus_cpp (→ json_cpp), logger_cpp, common_cpp, SIG_cpp,
usage_cpp, uci_cpp and docker2uxcd. The converter links libcurl + zlib/zstd/lzma.

## OpenWrt package

`openwrt/Makefile` is a single recipe that builds several packages from this one
source tree:

- **`uxcd`** (`CONFLICTS:=uxc`) — the daemon, `uxc`, `uxe`, the `netns` proto, the
  init script, the metrics CGI and `/etc/config/uxcd`. The image converter is
  linked in, so `uxc pull` / `uxc build` need no extra package.
- **`docker2uxcd`** — *optional.* The same converter as a standalone
  `/usr/bin/docker2uxcd` CLI (full flag set, for scripting on the box). Not
  required by `uxc`/the daemon.
- **`uxcd-examples`** — sample container + network configs under
  `/usr/share/uxcd/examples` (nothing is auto-registered).
- **`luci-proto-netns`** — the LuCI protocol handler for the `netns` proto.
- **`luci-app-uxcd`** — the LuCI web UI + an rpcd ACL for the uxcd ubus methods.

Drop the recipe into a feed as `uxcd/Makefile` and build like any other package;
it fetches the recursive release tarball (submodules included).

## Install as a service (from source)

```sh
make && make install                  # -> /usr/sbin/uxcd, /sbin/uxc, /usr/bin/uxe, the metrics CGI, ...
/etc/init.d/uxc disable               # uxcd replaces procd's "uxc boot" autostart
/etc/init.d/uxcd enable && /etc/init.d/uxcd start
```

uxcd reads the same registry as uxc (`/etc/uxc/<name>.json`) and is the sole
autostarter, so `/etc/init.d/uxc` must be disabled to avoid double-starting
containers.

## Quick start

```sh
uxc pull docker.io/library/nginx:alpine web     # fetch + convert + register
uxc start web
uxc list                                         # state, health, memory, updates
uxc log web -n 50
uxc attach web                                   # shell inside it
```

## Documentation

| Topic | |
|---|---|
| [docs/cli.md](docs/cli.md) | the `uxc` / `uxe` / `uxcd` command-line tools |
| [docs/configuration.md](docs/configuration.md) | `/etc/config/uxcd` + per-container `/etc/uxc/<name>.json` (volumes, devices, env, resources, caps, healthchecks, schedules) |
| [docs/images.md](docs/images.md) | pull / build / profiles / private registries / update detection / safe-upgrade / rollback |
| [docs/networking.md](docs/networking.md) | host / isolated / shared **infra** netns, the `netns` proto, `network.uci` |
| [docs/ubus.md](docs/ubus.md) | the `uxcd` ubus object: methods + events |
| [docs/metrics.md](docs/metrics.md) | the Prometheus metrics endpoint |

## Roadmap

v1/v2 are complete (lifecycle, logs, healthchecks, service+autostart, registration,
`info`, infra "pods", `uxe`, the `uxc` CLI, the OpenWrt package, image
pull/build, and the LuCI app). v3 — the flagship image provenance → update
detection → health-gated safe-upgrade chain, private registries, scheduling,
observability and security hardening — is largely done; see
[ROADMAP.md](ROADMAP.md) for the full tiered plan and what remains.
