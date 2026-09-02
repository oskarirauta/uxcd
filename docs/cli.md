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
uxc profiles                      # application profiles --profile can apply
uxc doctor <name>                 # what would stop <name> from starting
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
--out <dir>          where the bundle is written. Without it the bundle goes to
                     uxcd's configured bundle_dir (/srv/uxc by default) - the
                     same place LuCI puts one. An unpacked image is big; put it
                     on a partition that has room. Every pull prints the path it
                     resolved before it downloads anything.
--profile <name>     apply an application profile - see `uxc profiles`
--cache <dir>        blob cache (default /tmp/docker2uxc-cache, which is RAM)
--caps permissive|minimal
--network host|isolated
--privileged         process.noNewPrivileges = false
--arch <arch>        target a non-host architecture
--resolv-conf        bind-mount the host /etc/resolv.conf
--no-accounting      omit the memory+pids resources block
--rw-overlay         writable rootfs via a persistent overlay (base stays pristine)
--dev                dev container: idle init + writable overlay (see dev-containers.md)
--cntrinit <path>    static init staged for --dev (default /usr/bin/cntrinit)
--emit-netconfig     write an /etc/config/network veth/infra snippet
--net-bridge <br>    bridge for --emit-netconfig (default br-lan)
--emit-keeper        write a <name>.init procd keeper service
--no-verify          skip blob sha256 verification
--autostart, --infra <netns>
```

A pull refuses up front when the image will not fit, and aborts while there is
still room left rather than filling the filesystem — see
[images.md](images.md#running-out-of-space).

```sh
uxc profiles                      # application profiles, and what each one does
```

Lists every profile `--profile` can apply with its description, the capabilities
and devices it adds, and the host paths it expects to exist. A pull whose image
matches a profile says so even when you did not ask for one.

### `uxc doctor <name>`

Checks what would stop a container from starting, *before* it does — against
the current registry file, so it also catches an edit you have not restarted
into yet. It inspects the same merged OCI spec ujail would receive:

- missing bind sources and volume sources (ujail fails the whole container for
  one, with nothing useful in its log)
- two mounts on one destination (`parsing of OCI JSON spec has failed`)
- a capability set narrowed until an entrypoint cannot `chown` its data dir
- a `depends_on` loop (`a -> b -> a`, however long the chain), a dependency that
  is not a registered container, or one that names itself — all three quietly
  make the startup order something other than what you wrote
- devices listed that this host does not have, a missing infra netns, a missing
  `env_file`, no healthcheck (so an upgrade would be a blind restart), a web
  port with no scheme, and whether the filesystem has room for the next upgrade

Exit status is 1 when something is broken, so it can gate a script. The same
report is behind the **Check** button in the LuCI container view.

```
$ uxc doctor frigate
FAIL  missing bind source: /srv/frigate/media -> /media
      -> uxcd creates a missing volume directory at start, but ujail refuses the whole container if it is still absent
WARN  narrow capability set: CAP_CHOWN is not granted
      -> container entrypoints commonly chown their data dir and drop privileges; add it with cap_add, or in a profile with _caps_add
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
