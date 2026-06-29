# Command-line tools

The package ships three programs: the **`uxcd`** daemon, the **`uxc`** client and
the **`uxe`** exec/shell helper.

## `uxc` — control client

`uxc` drives the uxcd daemon over ubus (no need to call `ubus` by hand). It is a
drop-in-style replacement for the stock OpenWrt `uxc` (the package
`CONFLICTS:=uxc`).

```sh
uxc list [--json]                 # all containers: state, health, pid, memory, update/upgrade
uxc info|state <name>             # full detail for one container
uxc start|stop|restart <name>     # lifecycle
uxc log <name> [-n <lines>]       # captured stdout/stderr
uxc attach <name>                 # shell inside the container (via uxe)
uxc metrics                       # Prometheus metrics text (also at /cgi-bin/uxcd-metrics)

uxc create <name> --bundle <path> [--autostart] [--infra <netns>] [--no-respawn] \
                  [--temp-overlay-size <sz>] [--write-overlay-path <dir>] [--mounts <m1,...>]
uxc pull  <image> [name] [options]    # fetch + convert + register (see below)
uxc build <dockerfile|dir> [name] [options]   # build from a Dockerfile, no Docker
uxc compose <docker-compose.yml> [--dry-run] [--infra <netns>]  # import a compose file
uxc rollback <name>               # revert to the previous bundle (.prev) + restart
uxc remove|delete <name>          # unregister
uxc enable|disable <name>         # start on boot, or not
```

`create` refuses to overwrite an existing registration (remove it first), so it
can't silently clobber a container's volumes/env.

### `uxc pull` / `uxc build` options

The image converter is built into `uxc` (no separate package needed). Both
commands accept the full converter flag set:

```
--profile <name>     profiles/<name>.json overlay (e.g. frigate)
--caps permissive|minimal
--network host|isolated
--privileged         process.noNewPrivileges = false
--arch <arch>        target a non-host architecture
--resolv-conf        bind-mount the host /etc/resolv.conf
--no-accounting      omit the memory+pids resources block
--rw-overlay         tune the config for a writable overlay
--emit-netconfig     write an /etc/config/network veth/infra snippet
--net-bridge <br>    bridge for --emit-netconfig (default br-lan)
--emit-keeper        write a <name>.init procd keeper service
--no-verify          skip blob sha256 verification
--autostart, --infra <netns>, --out <dir>
```

See [images.md](images.md) for pull/build, profiles, registries and updates.

## `uxe` — exec / shell into a container

`uxe` runs a command (default `/bin/sh`) inside a running container by joining its
namespaces (like `docker exec`). A pty is allocated automatically for an
interactive shell on a terminal (force with `-t`, disable with `-T`):

```sh
uxe <name>                        # interactive shell (pty)
uxe <name> ip -br addr            # one-off command
uxe -u 1000:1000 <name> id        # as a specific uid[:gid]
uxe -w /srv <name> sh             # in a working directory
```

## `uxcd` — the daemon

Normally run as a service (see the project README). On the command line it takes
`-s <socket>`, `-d` (debug) and `-h` / `-V`; `-s` / `-d` override
`/etc/config/uxcd`. See [configuration.md](configuration.md) and
[ubus.md](ubus.md).
