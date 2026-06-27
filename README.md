[![License:MIT](https://img.shields.io/badge/License-MIT-blue?style=plastic)](LICENSE)

# uxcd

A small supervisor **daemon for OpenWrt's `uxc` containers**. It exposes a ubus
object (`uxcd`) that reports each container's state and resource usage and (later)
drives its lifecycle - so a LuCI front page can show a "Containers" panel and
start/stop/restart them.

`uxc` itself is a thin CLI over procd/ujail; uxcd adds the management and
observability layer on top: stats, logs, events and an intent-aware restart
policy.

> Status: **early / work in progress.** Currently exposes `uxcd.list`.

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

## Usage

```sh
./uxcd                       # run the daemon (SIGTERM/SIGINT to stop)
ubus call uxcd list          # query containers
```

## Roadmap

1. **list** - container state + cgroup resource stats (memory/cpu/pids). *(in progress)*
2. **lifecycle** - start/stop/restart with an intent-aware restart policy.
3. **owns launch** - per-container log ring buffer, shared-namespace "pods".
4. **luci-app-uxcd** - the web front-end.
