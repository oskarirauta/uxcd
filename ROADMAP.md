# uxcd v3 Roadmap

uxcd already runs containers well on a single OpenWrt box: lifecycle + crash backoff, healthchecks, events, metrics, registry-driven OCI injection, pods (shared netns), a LuCI app, and a Docker-free image pull/build path. **v3 is about trust and reach, not new runtime surface.** Almost every item below is thin wiring over machinery that already exists — turning the supervisor's internal signals into things that reach a human, making image updates safe and reversible, and removing the two walls (a 30-minute SDK compile to install; a `sysupgrade` that wipes definitions) that block adoption.

This list has been deliberately triaged for a **good-but-compact** tool: it does not try to match everything the big runtimes do — only enough to serve most people for whom docker/podman is too much. Effort: `S` ≈ hours–day, `M` ≈ days, `L` ≈ week+. Use cases: **server** (http/reverse-proxy), **Frigate** (NVR + GPU/coral/RTSP), **dev**, plus the broader **public**.

**Guiding principles**
- Make the things people already configured — restart policies, healthchecks, overrides — *reach the operator* and *survive the box*, without adding a daemon, a config dialect, or a dependency to the shell-free C++ core.
- **OpenWrt owns the network and firewall.** uxcd configures container networking via the `netns` proto; the administrator builds firewall/DNS/reverse-proxy infrastructure (fw4, dnsmasq) the OpenWrt way. uxcd does not manage system services.
- Small footprint, OpenWrt-native (ubus/uci/ujail/netifd/uhttpd), host-architecture only.

---

## Tier A — Do first (highest leverage)

### Image & build
- **Image update detection + one-click upgrade** `[L]` ⭐ _flagship_ — `check_updates` fetches only the manifest, compares to the stored digest; `uxc upgrade <name>` / a LuCI "update available" badge re-runs the converter for the same ref as a job, **keeping registry overrides + `.prev`**, then restarts. The maintainer's own #1 pain (Frigate point releases without re-doing device/volume tweaks).
- **Image provenance** `[S]` — record `ref` + resolved `sha256` digest + labels in the bundle and registry; `--pin`. Foundation for update detection and clear rollback.
- **Authenticated / private registries** `[M]` — `/etc/uxc/registries.json` (0600) + `~/.docker/config.json`; Basic/Bearer with busybox base64 (no new dep). GHCR/GitLab/private are the common dev case, blocked today.
- **Multi-arch / image-shape diagnostics + `inspect`** `[S]` — replace cryptic `no manifest for linux/$ARCH` with actionable output (host arch, "no qemu by design", available arches, Frigate tag hints); `docker2uxc inspect <ref>`. Reinforces the no-qemu non-goal instead of breaking it.

### Observability
- **Notification dispatcher** `[L]` — tee the existing `emit()` to a `fork+exec` helper (ship `notify.sh`: ntfy/webhook/sendmail), argv/env only, per-event debounce. Includes an optional outbound **heartbeat** (N running / M total / X unhealthy) so a dead box is noticed. The biggest gap for unattended operation.
- **Persistent event timeline** `[M]` — events → rotated `/var/log/uxcd/events.log` + RAM ring; `events()` ubus + a LuCI "Activity" sub-page. "What happened while I was away?"
- **OOM + exit-reason + PSI metrics (observe-only)** `[L]` — `oom_kills_total` + `oom_killed`, retained `last_exit_code/signal` + `restart_reason`, PSI pressure, net/disk bytes — into the existing exporter + `info()`. Answers "why did it restart?" and "is it about to die?" (OOM is Frigate's #1 failure). *Observe only — no automatic throttling.*

### Security
- **noNewPrivileges by default + explicit `privileged` opt-in** `[S]` — default new containers to `noNewPrivileges:true`; a single `privileged:true` is the only thing that may combine caps-`ALL` + unconfined seccomp + writable root; red badge in LuCI. New containers only.
- **Authenticated metrics endpoint** `[S]` — bearer token (UCI 0600) on `/cgi-bin/uxcd-metrics`; default localhost-open, token for remote, so existing scrapes don't break. (`uxc metrics` stays the local path.)
- **CLOEXEC / fd hygiene** `[S]` — `O_CLOEXEC` on the ubus connection, uloop epoll, log/config fds, job pipes; children inherit only their intended stdio/job-log pipe.

### Management / UX
- **Container rename** `[M]` — stop, move registry/logs/shadow, rewrite `depends_on`/`infra` back-references, re-key, restart. Fix a typo without losing logs/history. *(Clone dropped — marginal.)*
- **Jobs / Activity page + cancel** `[M]` — surface `job_list/status/log` in LuCI + `job_cancel` (kill the docker2uxcd child, **unmount its build binds**, rm the half-written out-dir). `docker ps`-level visibility; kill a stuck pull without hunting a PID.
- **Per-container rollback & `.prev` prune in the UI** `[M]` — move the rollback swap into a daemon `rollback(name)` + `prune_prev(name)`; LuCI "Roll back" / "Discard previous". The safety pair for one-click upgrade — revert a bad Frigate update from a phone.

### Orchestration
- **Health-gated startup ordering** `[M]` — `depends_on` entries gain `condition: "healthy"|"started"` + per-edge timeout; gate a dependent's launch on the dependency's health (poll, don't block). "running ≠ ready" (proxy before backend, Frigate before go2rtc/mqtt).
- **Health-gated safe update + auto-rollback** `[M]` — after an upgrade+restart, watch health for a confirm window; if it stays unhealthy, auto-swap `.prev` and restart, emit an event. Wires together update + `.prev` + healthcheck; a failed update no longer leaves a container down.

### Ecosystem
- **CI-built signed opkg/apk feed** `[L]` ⭐ _adoption_ — GitHub Actions builds across an arch matrix, `usign`-signs a `Packages` index, publishes; users add one `src/gz` line and `opkg install`. Kills the ~30-minute SDK compile wall (the #1 barrier for the audience). Release-time only, not per-commit.
- **Config backup/restore + sysupgrade persistence** `[L]` — (a) ship `/lib/upgrade/keep.d/uxcd` so `/etc/uxc/*.json` survives a flash (**trivial, high value — possibly a quick v2.x add**; `/etc/config/uxcd` already survives); (b) `export`/`import` of definitions + an image manifest (refs, not bundles) for box migration / flash-only devices (lower priority).
- **ubus API: published schema + docs + `uxcd.api`** `[M]` — a `uxcd.api` method ({daemon_version, methods, features}) + a committed JSON schema + `docs/ubus-api.md`, so LuCI/scripts have a contract and a field rename can't silently break the UI. *(Trimmed: no heavy semver/deprecation/negotiation machinery.)*

---

## Tier B — Valuable (after Tier A)

### Management / UX
- **Overview enhancements** `[M]` — fold a health-first summary into the existing Containers overview: counts (running/stopped/unhealthy/crash-looping), aggregate mem-vs-RAM, a "needs attention" sort, pod grouping. *(No separate dashboard page — reuse what's there.)*
- **Bulk select + pod lifecycle actions** `[S]` — checkbox multi-select + "start/stop a whole pod"; mostly client-side sequencing of existing calls.
- **Log search + authenticated download** `[M]` — extend the `log` ubus method with `match`/`since`/`max`; LuCI search box + a client-side download (Blob from the authenticated rpc — **no new CGI**, protected by the existing login).
- **Restart-on-config-change** `[M]` — a **"changes pending restart" badge** when a running container's saved config differs from its launch config (cheap, fixes the silent-edit footgun); optional `apply_on_change:restart` to apply automatically (later).
- **Daemon settings page** `[S]` — a LuCI form over `/etc/config/uxcd` (the global daemon UCI: log lines/size, restart backoff, max-restarts, stop/infra/probe timeouts, debug) so the daemon is configured from the UI instead of hand-editing UCI. Native `form.Map` (UCI-backed), unlike the per-container JSON editor - small and idiomatic.

### Observability
- **Stats history + SVG sparklines** `[M]` — per-container RAM ring (~120 samples) + dependency-free inline `<svg>` trends in the detail/overview. The in-UI "memory is climbing" leak-spotter (now that Grafana is out).

### Networking (netns proto only)
- **IPv6 in the netns proto, with a disable toggle** `[M]` — `ip6addr`/`ip6gw` (+ optional SLAAC) in `netns.sh`, `netns_addrs` also `-6`, v6 shown in `info`; an explicit **`ipv6` enable/disable** option so a dev box can lock to v4 (and avoid an accidentally internet-reachable v6). A pure netns-proto improvement.

### Image & build
- **Multi-stage Dockerfile support** `[L]` — `FROM … AS`, build each stage, resolve `COPY --from=`, keep the final; still single host-arch. Most real Dockerfiles are multi-stage; strengthens the Docker-free build differentiator. (Extend the umount-before-rm safety to every stage.)
- **Scheduled, health-gated auto-update** `[M]` — a timer runs `check_updates` (**notify-only by default**); per-container `auto_update:true` runs the upgrade with the Tier-A health-gate + auto-rollback, maintenance-window aware. Unattended server patching, made safe.
- **Import from `docker run` / `docker-compose.yml` / stock uxc** `[L]` — `uxc import` translates a `docker run` line (`-v/--device/-e/--cap-*/--restart/--name/image`) and adopts stock-uxc containers; `--dry-run` prints reviewable JSON. **Compose import** ✅ **DONE** — `uxc compose <file> [--dry-run]`: a small block-YAML reader translates a `docker-compose.yml` into registry entries sharing one infra netns (volumes / env / devices / depends_on / caps / restart; image or build via the linked converter; ports reported, not published). A one-shot **import, not a runtime**. (The `docker run` + stock-uxc translators are still pending.)
- **Reverse-proxy snippet helper** `[L]` _(opt-in)_ — an optional `proxy:{vhost,port}` hint emits an upstream snippet to a user-designated directory + runs a user-configured reload hook; with restarts the upstream IP follows. **Strictly a snippet emitter — never touches the proxy or its service.** (Consistent with "the admin owns the infrastructure".)

### Security
- **Security presets + read-only rootfs** `[M]` — a small profile library (`frigate`/`web`/`minimal`) expanded at launch via the existing caps/seccomp path, plus standalone `readonly_root:true` + `tmpfs:[…]` registry fields; LuCI Security dropdown + read-only toggle. Makes the v2 caps/seccomp actually usable (one-click hardening mapped to the apps people run). Start with a small, tested preset set.

### Orchestration
- **Scheduled restarts / maintenance windows** `[M]` — per-container `schedule:{restart:"0 4 * * *", window:…}` via a tiny 5-field cron parser on a once-a-minute uloop timer (no system cron); windows also gate auto-update. Long-lived containers (ffmpeg/Frigate) leak; a defined nightly bounce beats a 3am outage.

### Ecosystem
- **Documentation set** ✅ **DONE** — README trimmed to a landing page + a `docs/` tree (cli / configuration / images / networking / ubus / metrics). **Man pages dropped**: OpenWrt installs essentially none, so the docs live in the repo.
- **Grow `examples/` into a starter gallery** `[S]` — expand `uxcd-examples` with ready-to-adapt *registry configs* (a healthchecked web service, an nginx+php-fpm infra-netns pod, a device-passthrough container, a DB-with-volume, …) people copy into `/etc/uxc` and edit. *(Replaces a "template store" — support enough via examples, not a curated catalog engine.)*
- **Starter profile gallery** `[S]` — expand `docker2uxc/profiles/` beyond `frigate` with overlays for common device/caps-heavy images (zigbee2mqtt serial passthrough, home-assistant, jellyfin `/dev/dri`, pihole/adguard `:53`, mosquitto, nginx/caddy/php/exim). A profile is a deep-merge overlay applied at `--profile` pull time — distinct from an example (a hand-edited registry config); both are the gallery at different layers.
- **Test suite + CI regression gate** `[L]` — host-runnable golden-file tests for the highest-risk pure logic — above all the **registry → shadow-OCI merge** (a silent regression there breaks Frigate `/dev/dri`/coral access or weakens isolation) — plus CLI arg-parsing tests and schema-validation of live `list/info/metrics`, run on every PR. Makes the project safe to refactor and to accept contributions.

---

## Tier C — Optional packages / exploratory

- **In-browser container console** `[L]` _(optional package `luci-app-uxcd-terminal`)_ — depends on `ttyd`; a loopback-only, token-auth'd, `--once` `ttyd … uxe -t <name> /bin/sh`; falls back to printing the `uxe` command if ttyd is absent. A shell in the container from the browser — kept a separate package so the core stays lean.
- **Home Assistant MQTT-discovery bridge** `[L]` _(optional package `uxcd-mqtt`, community-friendly)_ — a small bridge that turns uxcd events + metrics into HA entities (state/health/mem/cpu sensors + start/stop/restart switches) via MQTT Discovery. The interface (events + metrics) already exists, so this can be built later by anyone without touching the core.
- **Full QEMU-OpenWrt end-to-end smoke test** `[L]` — boot uxcd under QEMU and start a real bundle (ujail needs the real kernel). Best-effort / manual; the host-runnable golden tests are the high-value 80%.
- **In-container init (`cntrinit`)** `[M]` _(optional package)_ — a tiny PID-1 (zombie reaping + signal forwarding) for images that lack one, offered as an add-on; based on the maintainer's existing `cntrinit` (a catatonit replacement — https://github.com/oskarirauta/cntrinit — old but small, to review + modernise). **Later consideration**: uxcd already healthchecks from outside, so it's niche; first check whether procd's in-jail ubus offers more than a procd-side healthcheck before investing (big work / small result otherwise).

---

## Deliberately out of scope (and why)

These were considered and **cut** to keep uxcd compact and within its lane:

- **Cross-architecture builds / qemu / binfmt.** Host-architecture only — diagnostics explain this.
- **Firewall management** (auto port-publish DNAT, managed per-pod zones). fw4 + the administrator own the firewall; a container tool injecting/reconciling rules is fragile (a VPN/firewall reload drops them — the classic docker-on-OpenWrt failure) and blurs responsibility. Route to a container's netns IP with your own `config redirect` / fw4 include — a few lines, the OpenWrt way.
- **DNS / dnsmasq management** (container-name registration). Same reasoning — a system service the admin owns. (Pod members already share `127.0.0.1`.)
- **A native multi-container "stack" abstraction.** `depends_on` (ordering + pull-deps-up) + the infra/pod netns + bulk pod actions already cover "manage several as one" — a separate stack file/engine adds little.
- **Volume *data* backup/restore.** Config backup (Tier A) covers the irreplaceable part; backing up bind-mount *data* is the admin's cron/tar job.
- **Secrets-management subsystem.** Env/registry files are 0600; a full secrets store (file-materialized refs, pickers) is a large subsystem for marginal gain at this scale.
- **Build cache for RUN steps.** rootfs snapshots on a RAM-backed cache for an occasional router-side build is complexity out of proportion to use.
- **Audit log, aggregate health 200/503 endpoint, container clone, app-template store, macvlan mode, rootless/userns, remote catalog index.** Each is either redundant with something kept, an admin's job, or too large/niche for the footprint. (Rootless/userns additionally breaks device passthrough, i.e. Frigate.)
- **A compose YAML *runtime*** (the one-shot compose *import* is in Tier B)**, Kubernetes-style scheduling/clustering/live-migration, becoming a reverse-proxy or cert manager, full SBOM/vuln scanning, heavy core dependencies, browser-side ubus event streaming.**

**Guiding rule for v3:** if an item would make uxcd start to *own* something OpenWrt already owns (firewall, DNS, the proxy, scheduling), or grow an unbounded maintenance surface, it belongs here in "out of scope", not in the plan.
