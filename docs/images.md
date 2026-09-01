# Images: pull, build, profiles, updates

uxcd fetches and converts OCI/registry images into `ujail`/`uxc` bundles itself —
no Docker or podman daemon. The converter (**docker2uxc**, a lean C++ rewrite) is
linked directly into `uxcd` and `uxc`, so `uxc pull` / `uxc build` work out of the
box; nothing extra needs installing.

> The optional **`docker2uxcd`** opkg package is just the same converter as a
> standalone `/usr/bin/docker2uxcd` CLI (full flag set, for scripting on the
> box). `uxc pull` / `uxc build` and the LuCI UI do not need it.

## Pulling an image

```sh
uxc pull docker.io/library/nginx:alpine web        # fetch + convert + register "web"
uxc pull ghcr.io/blakeblackshear/frigate:stable frigate --profile frigate
```

The converter resolves the manifest (multi-arch → the host architecture; arm64
picks its canonical `v8` variant), downloads + sha256-verifies each layer,
flattens them into a rootfs (applying overlayfs whiteouts) and writes an OCI
bundle plus `image-config.json` / `manifest.json`. It then registers the
container in `/etc/uxc/<name>.json`, recording the image **ref** and the resolved
**digest** as provenance for later update checks. A re-pull *merges* over the
existing entry, so your volumes/devices/env/healthcheck survive an update.

Layers are cached (content-addressed, under `/tmp/docker2uxc-cache` by default,
or `$DOCKER2UXC_CACHE`, or the `cache_dir` setting) so a re-pull is fast.

### Where the bundle lands

An unpacked image is the big thing on the disk — often several times the size of
the download — so it matters where it goes:

| How you pull | Default location | Override |
|--------------|------------------|----------|
| `uxc pull` / `uxc build` | the `bundle_dir` setting (`/srv/uxc`) | `--out <dir>` |
| LuCI, ubus `pull`/`build` | the same `bundle_dir` | the **Bundle directory** field / `"out"` |
| the standalone `docker2uxcd` CLI | `./<name>` — the **current directory** | `--out <dir>` |

Every pull prints the resolved path before it downloads anything:

```
output:  /srv/uxc/frigate   (default location - set it with --out)
size:    1.1 GiB to download, about 2.8 GiB unpacked
```

Point `bundle_dir` (LuCI: **Containers → Settings → Bundle directory**) at
whatever partition has room — on OpenWrt the root overlay usually does not.

### Running out of space

Filling a filesystem is not an ordinary error on a small box: at zero bytes free
everything that wants to write blocks or dies, which looks like the whole system
freezing before it falls over. uxcd tries hard not to get there:

- **Before downloading**, the converter adds up the manifest's layer sizes,
  estimates the unpacked rootfs (~2.5×) and checks the free space on every
  filesystem involved — bundle, blob cache and scratch. If it does not fit you
  get a refusal with real numbers instead of a dead box.
- **While writing**, a watchdog stops the pull once the target filesystem drops
  to its last ~32 MB, so there is always room left to recover in.
- **RAM counts too.** `/tmp` is a tmpfs, so a cache or scratch file there eats
  memory, not disk. The scratch directory (one decompressed layer at a time)
  therefore defaults to the bundle's own storage when that is real disk, and the
  preflight says so plainly when the cache is the tight one. Set `cache_dir` to
  move the blob cache onto disk permanently.
- **After a failure**, the half-written bundle is removed, so a failed pull
  gives the space back instead of leaving the partition full.

`disk_min` (default 50 MB) is a coarse floor checked before a job starts; the
size-aware preflight above is what actually protects a big pull.

### Useful flags

`uxc pull` / `uxc build` accept the converter's options:

```
--profile <name>     apply a profiles/<name>.json overlay (see below)
--caps permissive|minimal
--network host|isolated      (isolated also emits a network.uci snippet)
--privileged         process.noNewPrivileges = false
--arch <arch>        target a non-host architecture's manifest
--rw-overlay         writable rootfs via a persistent overlay (base stays pristine)
--dev                dev container: idle init + writable overlay (see dev-containers.md)
--emit-netconfig / --net-bridge <br>    write an /etc/config/network snippet
--emit-keeper        write a <name>.init procd "keeper" service
--no-verify          skip blob sha256 verification
--out <dir>          where to put the bundle (default: the bundle_dir setting)
--cache <dir>        blob cache location (default /tmp/docker2uxc-cache = RAM)
--autostart, --infra <netns>, --name <name>
```

The same options are available on the daemon's `pull`/`build` ubus methods and on
the standalone `docker2uxcd` CLI.

## The "New container" wizard (LuCI)

The overview page's **New container…** button is a light creator for starter
boxes: pick a base image (alpine/debian/ubuntu, or any ref), tick the basic
tools to bake in (git, curl, build tools, …) and plain-language options — keep
awake (the idle cntrinit init), GPU, USB, a Zigbee/Z-Wave stick, VPN (tun),
Coral PCIe (only devices the box actually has are offered), autostart. It
composes a Dockerfile, saves it next to the bundle as `<name>.Dockerfile` —
**the container's editable recipe**: change it and `uxc build` it again to
evolve the box — builds it, and applies the device/notes choices to the
registry. Finish by installing whatever else you need inside (Console / `uxe`).

## Building from a Dockerfile

```sh
uxc build /root/myapp/Dockerfile app
uxc build /root/myapp app                 # a directory -> <dir>/Dockerfile, context = <dir>
```

Single-stage, host-architecture builds — `FROM` is pulled as the base, then
`RUN` executes in a chroot of the rootfs (with `/proc`,`/dev`,`/sys` bound and the
host resolver), `COPY`/`ADD` copy from the build context, and
`ENV`/`WORKDIR`/`USER`/`CMD`/`ENTRYPOINT` update the image config. No Docker
daemon is needed — handy when an image is only published as a Dockerfile. Because
`RUN` runs the base image's native binaries (exactly what ujail can run anyway),
cross-architecture (qemu/binfmt) builds are intentionally out of scope; multi-
stage builds are not supported.

## Importing a docker-compose.yml

```sh
uxc compose docker-compose.yml --dry-run     # review the translation first
uxc compose docker-compose.yml               # pull/build + register each service
```

`uxc compose` is a one-shot **import, not a runtime**: it translates each service
into a uxcd registry entry, with all services sharing one **infra netns** (so they
reach each other over `127.0.0.1`). It maps `image:`/`build:`, `volumes`
(relative binds resolved against the file; named volumes -> `/srv/<project>/<name>`),
`environment`, `devices`, `depends_on`, `cap_add`/`cap_drop` and `restart`.
`ports:` are **not** published (uxcd does no port mapping) - expose via your
firewall. `--dry-run` prints the plan; otherwise each service is pulled/built and
registered, but **nothing is started**: review, define the netns (see
`examples/etc/config/network.example`), then `uxc start <name>`. The compose
runtime, service-name DNS and live orchestration are out of scope.

## Importing a docker run line

```sh
uxc import docker run --name web -p 8080:80 \
  -v /srv/html:/usr/share/nginx/html:ro -e TZ=Europe/Helsinki \
  --restart unless-stopped nginx:alpine --dry-run     # review first
uxc import --name web -v /srv/html:/usr/share/nginx/html:ro nginx:alpine
```

`uxc import` translates a single `docker run` line into one container, the
single-image sibling of `uxc compose`. Paste the whole command (a leading
`docker run` is tolerated) or just its flags plus the image. It maps `--name`
(else the name is derived from the image, like `uxc pull`), `-v`/`--volume`
(relative binds resolve against the **cwd**; named volumes -> `/srv/<name>/<vol>`),
`--device` (host side only), `-e`/`--env`, `--cap-add`/`--cap-drop`, `--restart`
(`no` -> no respawn) and `--network host`. uxcd's own `--infra <netns>` is
honoured for inter-container `127.0.0.1`. `-p`/`--publish` is **not** applied
(no port mapping - use your firewall); the command after the image, `--mount`,
`--env-file`, `-w`/`-u`/`--hostname`/`--entrypoint` and other docker-isms are
warned and skipped (they come from the image/bundle). As with `compose`, nothing
is started - review, then `uxc start <name>`.

## Adopting a stock uxc container

```sh
uxc import uxc /etc/uxc/mycontainer.json --dry-run     # review the translation
uxc import uxc /etc/uxc/mycontainer.json               # rewrite it in uxcd's format
```

Migrating from OpenWrt's stock `uxc`? It already stored its containers in the same
`/etc/uxc/` directory and shares the `name`/`path`/`autostart` keys, so most
definitions are read as-is. `uxc import uxc <file>` normalises the few keys that
differ: stock's `volumes` (its *required-mounts* list, `--mounts`) becomes
`mounts`, and `temp-overlay-size`/`write-overlay-path` become
`temp_overlay_size`/`write_overlay_path`. `jail` and `pidfile` are dropped (uxcd
tracks the init pid itself and uses the container name as the jail name) — both
are warned. **Nothing is pulled** (the bundle at `path` already exists) and
nothing is started. An optional 2nd argument overrides the name; re-running it
preserves any uxcd-only fields (env, devices, healthcheck, …) you've since added.

## Profiles

A **profile** carries everything about running one particular application that
the image itself cannot state: the capabilities its init needs, the devices to
pass through, where its data lives, how much shared memory it wants, and how to
tell whether it is healthy. Profiles live in
`/usr/share/docker2uxc/profiles/<name>.json` (override with
`$DOCKER2UXC_PROFILES`); the package ships `frigate`, `mosquitto`, `postgres`,
`mariadb`, `icecc` and an annotated `_template`.

```sh
uxc profiles                                   # what is available, and what each does
uxc pull --profile frigate ghcr.io/blakeblackshear/frigate:0.17.2 frigate
```

or pick one from the dropdown in the LuCI **New container…** dialog, which shows
the same summary — devices, shared memory, extra capabilities, and the host
paths the profile expects.

A profile writes to two places:

- its **top level** is deep-merged onto the bundle's OCI `config.json` (mounts,
  env, rlimits, capabilities),
- its **`_registry`** block seeds `/etc/uxc/<name>.json` (volumes, devices,
  `shm_size`, healthcheck, `web_ports`, notes, urls) — only keys the entry does
  not already have, so re-pulls and upgrades never overwrite your edits.

Merge rules: objects merge key-by-key (overlay wins), `mounts` merge **by
destination** (two mounts on one path make ujail reject the whole spec), other
arrays concatenate, scalars replace. Keys beginning with `_` never reach
`config.json`; some are directives:

| Directive | Meaning |
|-----------|---------|
| `_description` | one line, shown by `uxc profiles` and in LuCI |
| `_caps_add: [...]` | capabilities **added** to the `--caps` set — what an application profile normally wants. Writing `process.capabilities` instead **replaces** the set, which is how a container ends up without `CAP_CHOWN` and dies on the first `chown` its init does |
| `_optional: true` on a mount | skipped when its host source is absent, instead of failing the container |
| `_registry: {...}` | the uxcd-side fields above |
| `_seed: { path: contents }` | starting config files, written only when absent — an application that refuses to start without a config file (mosquitto) gets a commented starting point instead of a crash loop |

Full format, and how to write one: `profiles/README.md` in the docker2uxc tree
(installed alongside the profiles).

## Private / authenticated registries

Credentials are stored by uxcd in `/etc/uxcd/auth.json` (Docker "auths" format,
`0600`; passwords are never returned over ubus). Manage them from the LuCI
**Containers → Registries** page, or:

```sh
ubus call uxcd registry_set    '{"registry":"ghcr.io","username":"me","password":"<token>"}'
ubus call uxcd registry_list                        # hosts + usernames (no passwords)
ubus call uxcd registry_remove '{"registry":"ghcr.io"}'
```

The converter sends them as HTTP Basic to the registry's token endpoint — only
over `https` and only to the registry's own host (or Docker Hub's auth host), so
a hostile `WWW-Authenticate` realm can't redirect your credentials elsewhere.
Anonymous pulls need no credentials.

## Updates and upgrades

uxcd records each pulled container's image+digest, so it can tell when a tag has
moved upstream:

- **Detect** — `uxc` / LuCI "Check for updates" runs an on-demand check
  (`ubus call uxcd check_updates`); a container with a newer upstream digest is
  flagged `update_available`. A daemon-wide `update_check_cron` setting runs the
  same check on a schedule (notify-only — the overview badge + Activity timeline
  are the notification).
- **New versions** — the same check also scans the repo's **tag list** for a
  newer *version* tag (something the recorded tag can never "move" to by
  itself): stable versions are preferred, a prerelease (`-beta2`, `-rc1`) is
  suggested only when nothing stable is newer, and variant tags follow their
  own family (`nginx:1.29-alpine` is only offered `*-alpine`; `latest`-style
  tags are not comparable and get no suggestion). Reported as
  `new_version`/`new_image` in `list`/`info`, a `new_version` notify event, a
  LuCI badge and a one-click **Upgrade to <version>** button in the container
  view. Never auto-applied — a version jump is always an explicit decision
  (`auto_upgrade` only follows the recorded tag).
- **Upgrade (one command / one click)** — `uxc upgrade <name>` (the LuCI
  **Upgrade** button, `ubus call uxcd upgrade {name}`) re-pulls to the same
  bundle path and restarts. With a healthcheck defined this is a **health-gated
  safe-update**: the fresh instance is watched for `safe_update_window` seconds
  (plus the healthcheck's `start_period`, so a slow-booting container gets its
  startup grace on top) and, if it does not become healthy, automatically
  **rolled back** to the previous bundle — including its recorded provenance, so
  the missed update is offered again on the next check. The result shows as
  `last_update` = `verified` / `rolled_back`.
- **Version jump** — `uxc upgrade <name> --image <ref>` (ubus: `upgrade
  {name, image}`) pulls an explicitly different tag (`frigate:0.17.2` →
  `frigate:0.18.0`) through the same safe-update gate; on success the new ref
  becomes the recorded provenance. Because your volumes/devices/env live in the
  registry — not in the bundle — they carry over untouched. See
  [frigate.md](frigate.md) for the worked example.
- **Auto-upgrade (opt-in)** — set `"auto_upgrade": true` on a container and the
  scheduled check upgrades it automatically via the same safe-update (rolls back
  if unhealthy). Off by default — good for a web/PHP server you want current,
  leave off for a dev container you don't want changing silently.

## Rollback

Each pull keeps the previous bundle as `<path>.prev` (one generation). Revert
with `uxc rollback <name>` (the LuCI **Rollback** button) — a 3-way rename that
swaps the current and previous bundles and restarts; rolling back again rolls
forward. The recorded provenance (`image`/`digest`) swaps along with the bundle,
so the registry always describes what is actually live and the update check
stays truthful after a rollback. A pull builds the new bundle in `<path>.new`
and rotates only once it is complete — a cancelled or failed pull can never
damage the live bundle or its `.prev` backup. `ubus call uxcd prune {target}` reclaims the blob cache (`cache`), the
`.prev` backups (`prev`) or both (`all`).
