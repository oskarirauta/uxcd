# FAQ

Most of these answers popularize the reasoning in [`ROADMAP.md`](../ROADMAP.md)
("Deliberately out of scope"): uxcd is a **good-but-compact** container supervisor
for a single OpenWrt box, not a docker/podman replacement. It deliberately does
not *own* things OpenWrt already owns (firewall, DNS, the reverse proxy).

## Do I need Docker, or a daemon runtime?

No. uxcd is OpenWrt-native — it drives **ujail** (containers), **netifd** (the
`netns` proto), **ubus** (its API), **uci** (config) and **uhttpd** (metrics).
There is no Docker, no container daemon, and no language runtime. The image
pull/build path (`docker2uxc`) turns an image reference or a Dockerfile into an
OCI bundle without Docker.

## Why is it so much smaller than docker/podman?

The uxcd daemon is a stripped binary **under 2 MB** — next to the tens to
hundreds of MB (*plus* a running daemon) of docker / podman / kubernetes. It
reuses the services OpenWrt already ships instead of bundling its own network
stack, image store and API server. The trade is deliberate: it targets "most
people for whom docker/podman is too much", not feature parity.

## Who manages the firewall, ports and routing?

**OpenWrt does** — fw4 and netifd, the OpenWrt way. uxcd configures container
*networking* (via the `netns` proto: veth, addresses, DNS for the namespace) but
never writes firewall rules. A container tool that injects/reconciles fw4 rules
is fragile — a firewall or VPN reload drops them (the classic docker-on-OpenWrt
failure) — and it blurs who owns the firewall. To expose a container, route to
its (static) netns IP with your own `config redirect` / fw4 include. See
[`docs/networking.md`](networking.md).

## Why doesn't uxcd register container DNS names?

dnsmasq is a system service the administrator owns; uxcd does not reconcile
records into it. Containers in the same **infra** (pod) netns already reach each
other over `127.0.0.1`, which covers the common case.

## Why does enabling read-only root pre-fill a CAP_SYS_ADMIN drop?

`CAP_SYS_ADMIN` lets a container remount its own root filesystem writable, which
would defeat a read-only root. So ticking *Read-only root* pre-fills a
`CAP_SYS_ADMIN` entry in *Drop capabilities*. It is **only a pre-fill** — if a
workload genuinely needs `CAP_SYS_ADMIN`, remove it from the drop list in the
capabilities editor.

## Why is there no rootless / userns mode?

It breaks device passthrough (e.g. Frigate's GPU / Coral / RTSP), and clashes
with OpenWrt's root-only user model. uxcd runs containers under `ujail` with
capability dropping, `noNewPrivileges`, seccomp and optional read-only root
instead.

## Why can't I run an image built for another CPU architecture?

Host-architecture only — there is no qemu/binfmt emulation layer. When an image
manifest doesn't match the host arch, the pull diagnostics say so rather than
pulling something that can't run.

## Why only compose *import*, not a compose runtime?

`uxc compose` (and `uxc import`) translate a compose/`docker run` definition into
registry entries once; `uxc` then runs the containers as native uxcd containers.
It's a one-shot importer, not a second runtime/orchestrator to maintain. Ordering
and pods are covered by `depends_on` + the shared infra netns.

## Why is there no volume *data* backup, secrets store, or "stack" object?

- **Volume data backup** — config backup (`keep.d`) preserves the container
  *definitions* across sysupgrade; backing up bind-mount *data* is the admin's
  `cron`/`tar` job, like any other service's data.
- **Secrets** — env files and registry credentials are already `0600`; a full
  secrets subsystem (materialized refs, pickers) is a large system for marginal
  gain at this scale.
- **A native multi-container "stack"** — `depends_on` (ordering + pull-deps-up)
  plus the infra/pod netns already cover "manage several as one"; a separate
  stack file/engine would add little.

See [`ROADMAP.md`](../ROADMAP.md) for the full "deliberately out of scope" list
and the reasoning behind each cut.
