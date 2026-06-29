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

Layers are cached (content-addressed, under `/tmp/docker2uxc-cache` by default, or
`$DOCKER2UXC_CACHE`) so a re-pull is fast.

### Useful flags

`uxc pull` / `uxc build` accept the converter's options:

```
--profile <name>     apply a profiles/<name>.json overlay (see below)
--caps permissive|minimal
--network host|isolated      (isolated also emits a network.uci snippet)
--privileged         process.noNewPrivileges = false
--arch <arch>        target a non-host architecture's manifest
--rw-overlay         tune the config for a writable overlay
--emit-netconfig / --net-bridge <br>    write an /etc/config/network snippet
--emit-keeper        write a <name>.init procd "keeper" service
--no-verify          skip blob sha256 verification
--autostart, --infra <netns>, --out <dir>, --name <name>
```

The same options are available on the daemon's `pull`/`build` ubus methods and on
the standalone `docker2uxcd` CLI.

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

A **profile** is a JSON overlay deep-merged onto the generated `config.json` —
a reusable set of bundle tweaks (extra mounts, devices, caps, rlimits, env) for a
known image. Profiles live in `/usr/share/docker2uxc/profiles/<name>.json`
(override with `$DOCKER2UXC_PROFILES`); the package ships a `frigate` profile and
a `_template`. Apply with `--profile <name>`, or pick one from the dropdown in the
LuCI Pull/Build dialog.

Merge rules: objects merge key-by-key (overlay wins), arrays concatenate, scalars
replace; keys beginning with `_` are stripped (use them for comments).

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
- **Upgrade (one click)** — `uxc rollback` aside, `ubus call uxcd upgrade
  {name}` (the LuCI **Upgrade** button) re-pulls to the same bundle path and
  restarts. With a healthcheck defined this is a **health-gated safe-update**: the
  fresh instance is watched for `safe_update_window` seconds and, if it does not
  become healthy, automatically **rolled back** to the previous bundle. The
  result shows as `last_update` = `verified` / `rolled_back`.
- **Auto-upgrade (opt-in)** — set `"auto_upgrade": true` on a container and the
  scheduled check upgrades it automatically via the same safe-update (rolls back
  if unhealthy). Off by default — good for a web/PHP server you want current,
  leave off for a dev container you don't want changing silently.

## Rollback

Each pull keeps the previous bundle as `<path>.prev` (one generation). Revert
with `uxc rollback <name>` (the LuCI **Rollback** button) — a 3-way rename that
swaps the current and previous bundles and restarts; rolling back again rolls
forward. `ubus call uxcd prune {target}` reclaims the blob cache (`cache`), the
`.prev` backups (`prev`) or both (`all`).
