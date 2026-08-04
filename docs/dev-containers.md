# Dev containers

A **dev container** is a persistent, daemonless box you shell into and work in —
a build environment for a firmware project (buildroot, thingino/OpenIPC, an SDK),
a scratch distro to try things in, a toolchain you don't want on the host. A
normal container runs a service and exits when that service does; a build image
has no service at all, so under a supervisor it would exit immediately. `--dev`
solves that:

```sh
uxc pull --dev --out /srv/uxc/devbox debian:bookworm
uxc start devbox
uxe devbox /bin/bash          # you're in; apt-get install build-essential ...
```

Or tick **Dev container** in the LuCI *Pull image* / *Build from Dockerfile*
dialog. The standalone `docker2uxcd --dev` does the same.

## What `--dev` does

- **Idle init as PID 1** — a copy of [cntrinit] is placed in the bundle rootfs
  (`/.cntrinit`) and made the container's process (`/.cntrinit --`: no child =
  infra mode). It just reaps zombies and waits for signals, so the container
  stays *running* with nothing else in it. `~55 KB`, fully static — works in any
  image, `scratch` included.
- **Writable rootfs via a persistent overlay** — the bundle's rootfs stays a
  pristine, read-only lower layer; every write (package installs, `~/.cache`,
  your builds) lands in `<bundle>.overlay/` on the host (registered as
  `write_overlay_path`, mounted by ujail `-O`). Survives restarts and uxcd
  restarts.
- **No autostart** — a dev box is something you start when you need it.

Because the image is never modified, `--dev` works with *any* image — no
rebuilding, no baking an init into it.

## Working in it

- **Shell:** `uxe <name> /bin/sh` (or `uxc attach <name>`), or the LuCI
  **Console** button (the `uxcd-console` package).
- **Sources / results:** bind-mount them so they live outside the container —
  add `"volumes": ["/srv/work/myproj:/work"]` to `/etc/uxc/<name>.json`
  (or the LuCI editor's Storage tab) and build in `/work`.
- **Toolchains, packages:** just install them inside (`apt`/`apk`/...) — they
  persist in the overlay.
- **Long builds** keep running with your SSH session closed: the container is
  supervised by uxcd, not by your shell. Run the build under `nohup`/`tmux`
  inside, or as `uxe <name> sh -c 'make ...' &`.

## Factory reset

The base image is untouched, so resetting the box to day one is:

```sh
uxc stop devbox
rm -rf /srv/uxc/devbox.overlay/*      # wipe upper + work
uxc start devbox
```

Everything installed or written inside is gone; the image is as pulled. (Your
bind-mounted volumes are outside the overlay and unaffected.)

## Sizing and placement

The overlay holds *everything you write* — a toolchain plus a buildroot tree is
easily gigabytes. Put the bundle (and thus the default `<bundle>.overlay`) on a
partition with room (`--out /srv/uxc/<name>`), or point `write_overlay_path` at
one. `df -h <overlay>` tells you what the box is really using; the *Images &
storage* page in LuCI shows it too.

## Notes

- The container shares the host network by default (like every uxcd container);
  `--network isolated` or an infra netns work as usual — see
  [networking.md](networking.md).
- Update detection works (`--dev` pulls record `image` + `digest`), but a
  *safe*-update can't health-gate an idle init; an upgrade replaces the base
  and keeps the overlay. Wipe the overlay if the new base conflicts with what
  the old overlay shadows.
- `--cntrinit <path>` overrides where the static init is copied from (default
  `/usr/bin/cntrinit`, the `cntrinit` package).
- Plain `--rw-overlay` gives you the same writable persistent overlay *without*
  the idle init — for a normal service container whose image expects to write
  to its rootfs.

## Retrofitting an existing bundle

The same shape by hand, no re-pull needed:

1. `cp /usr/bin/cntrinit <bundle>/rootfs/.cntrinit`
2. In `<bundle>/config.json`: `"process"."args" = ["/.cntrinit","--"]`
   (the trailing `--` is required — without it cntrinit exits) and
   `"root"."readonly" = false`.
3. In `/etc/uxc/<name>.json`: `"write_overlay_path": "<bundle>.overlay"`.
4. `mkdir <bundle>.overlay && uxc restart <name>`

[cntrinit]: https://github.com/oskarirauta/cntrinit
