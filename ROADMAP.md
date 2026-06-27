# uxcd v3 Roadmap

uxcd already runs containers well on a single OpenWrt box: lifecycle + crash backoff, healthchecks, events, metrics, registry-driven OCI injection, pods (shared netns), a LuCI app, and a Docker-free image pull/build path. **v3 is about trust and reach, not new runtime surface.** Almost every high-value item below is thin wiring over machinery that already exists — turning the supervisor's internal signals into things that reach a human, making image updates safe and reversible, letting the server set actually serve traffic, and removing the two walls (a 30-minute SDK compile to install; a `sysupgrade` that wipes everything) that block adoption.

Items are tiered by **leverage vs. effort** and by how well they serve the three real use cases — **server** set (http/reverse-proxy), **Frigate** (NVR + GPU/coral/RTSP), **dev** environments — plus the broader **public** "Docker is too much" audience. Effort: `S` ≈ hours–day, `M` ≈ days, `L` ≈ week+, `XL` ≈ multi-week/uncertain.

**Guiding principle:** *Make the things people already configured — restart policies, healthchecks, overrides — actually reach the operator and survive the box, without adding a daemon, a config dialect, or a dependency. Small footprint, OpenWrt-native (ubus/uci/ujail/netifd/uhttpd), host-architecture only.*

---

## Tier A — Do first (highest leverage, unblock the most)

### Image & Build
- **Image provenance: record source ref + resolved digest + labels** `[S]` · _server · frigate · dev · public_
  - *What:* at pull/build, write `ref`, resolved per-arch `sha256` digest, arch, and selected OCI labels into both the bundle (`provenance.json`) and `/etc/uxc/<name>.json`; add `--pin` to rewrite the ref as `repo@sha256:…`.
  - *Why:* you currently can't answer "what version is running?" from data (it's prose in README.notes); this is the **foundation** for update detection, scheduled updates, and rollback clarity, and gives reproducible deploys.
- **Image update detection + one-click upgrade (preserving overrides)** `[L]` · _frigate · server · dev · public_
  - *What:* `check_updates` fetches *only* the manifest/index (no blobs), compares to the stored digest; `uxc upgrade <name>` / a LuCI "Update available" badge re-runs the converter for the same ref as an async job, keeping `.prev` and leaving registry overrides untouched, then restarts.
  - *Why:* the centerpiece for the maintainer's own pain — Frigate point releases and server patching today mean re-running the converter by hand and praying device/volume tweaks survive; the pieces (`.prev`, rollback, jobs, registry overrides) already exist.
- **Authenticated / private registries** `[M]` · _dev · server · public_
  - *What:* 0600 `/etc/uxc/registries.json` (host → creds/token) + read `~/.docker/config.json`; send Basic auth to the token endpoint (or straight to `/v2`), built with busybox base64 — no new deps; `registry_login/logout/list` ubus + a small LuCI editor.
  - *Why:* GHCR/GitLab/Docker Hub-private/LAN registries are the single most common dev workflow and are silently blocked today; table-stakes for a Docker alternative.
- **Clearer multi-arch & image-shape diagnostics (+ `inspect`)** `[S]` · _frigate · public · dev · server_
  - *What:* replace "no manifest for linux/$ARCH" with actionable output — host arch, "no qemu by design", the available os/arch list, Frigate variant-tag hints (`-tensorrt`/`rk`/`-h8l`), and clear handling of non-image refs (SBOM/attestation/Helm); add `docker2uxc inspect <ref>`.
  - *Why:* cryptic arch/media-type errors are the #1 support burden for a public tool; cheap, disproportionately reduces "it doesn't work" issues.

### Observability
- **Notification dispatcher: events → ntfy / email / webhook** `[L]` · _server · frigate · dev · public_
  - *What:* tee the existing `emit()` event choke point to a dispatcher that `fork+exec`s one configured helper (ship `/usr/share/uxcd/notify.sh`; ntfy/webhook/sendmail), passing data via argv/env only (no shell `-c`); UCI `[notify]` + per-container overrides; per-event-class debounce + flap coalescing.
  - *Why:* the single biggest gap for unattended operation — an OOM, crash-loop, or unhealthy check is invisible today unless something already subscribes to ubus on-box; this is what makes the restart policies/healthchecks people already set up reach a phone.
- **Persistent event history / activity timeline** `[M]` · _server · frigate · dev · public_
  - *What:* tee the same event stream into a rotated `/var/log/uxcd/events.log` + small RAM ring (`{ts,container,event,health,reason,exit}`); `events(limit,since,container?)` ubus + a LuCI "Activity" sub-page; reuse the existing log-rotation code.
  - *Why:* "what happened while I was away?" is the operator's first question after an unattended weekend; today events are fire-and-forget. Nearly free given the rotation code and event struct already exist.
- **OOM + exit-reason + richer per-container metrics** `[L]` · _frigate · server · dev · public_
  - *What:* `memory.events` oom_kill → `uxcd_oom_kills_total` + `oom_killed` flag; retain `last_exit_code/signal` + `restart_reason` (crashed/oom/healthcheck/manual); PSI `cpu/memory/io.pressure` → `uxcd_psi_*` (feature-detected); per-netns `/proc/net/dev` → net bytes; `dir_size()` → disk bytes. Lands in the existing exporter + `info()`.
  - *Why:* answers the two questions monitoring must answer — "why did it restart?" and "is it about to die?" — neither answerable today; OOM is the #1 Frigate failure mode and PSI is uniquely valuable on RAM-tight routers. (Merges the duplicate "resource pressure" proposal; the *act-on-pressure brake* is deferred to Tier B.)
- **Shipped Grafana dashboard + Prometheus alert rules** `[S]` · _server · frigate · public_
  - *What:* curated dashboard JSON + `uxcd.rules.yml` (ContainerDown/Unhealthy/OOMKilled/CrashLooping/MemoryNearLimit/uxcdDown) + a scrape snippet, shipped via uxcd-examples/docs.
  - *Why:* highest value-per-effort here — the exporter already exists but a raw endpoint is useless to the target audience; a known-good dashboard makes monitoring turnkey. (Track metric-name changes from the metrics item.)

### Networking
- **Port publishing with automatic firewall DNAT** `[L]` · _server · public · dev · frigate_
  - *What:* `"ports":["8080:80/tcp"]` in the registry; for netns containers, resolve the container IP (already done via `netns_addrs`) and generate **marker-tagged** `config redirect` sections in `/etc/config/firewall` + `fw4 reload`; idempotent regenerate on every start; cleanup on stop; **reconcile-on-startup sweep** for orphans; host-net = documented no-op.
  - *Why:* the single highest-leverage networking feature — today an isolated container is unreachable until the admin hand-writes redirects ("uxc adds nothing here"); without it the "small Docker alternative" can't serve a reverse proxy from a pod. Scope strictly to marker-tagged sections; never touch admin/LuCI rules.
- **Published-ports & network view in LuCI** `[M, after port-publish]` · _server · frigate · dev · public_
  - *What:* surface `ports[]` (host:container/proto + bound state), container IP(s), assigned zone, pod/hostname in `info`; render a Ports column + clickable `http(s)://router:hostport` links + host-port conflict warnings; optional cached reachability dot.
  - *Why:* "what is this exposing and where do I click?" is the operator's first question; makes the port plumbing legible and turns LuCI into a real control panel.

### Security
- **no-new-privileges by default + explicit, surfaced `privileged` opt-in** `[S]` · _server · dev · frigate · public_
  - *What:* default new containers to `noNewPrivileges:true` (the converter hardcodes `false` today); add a single `privileged:true` escape hatch as the *only* thing that may combine full caps + unconfined seccomp + writable root; red badge in LuCI/`uxc info`; refuse caps-`ALL`+unconfined at setconfig unless privileged. Apply default to *new* containers only.
  - *Why:* blocks setuid escalation at near-zero compatibility cost and makes privilege a deliberate, labeled choice instead of the current implicit permissive default. (Verify exact ujail OCI field name against `jail.c`.)
- **Authenticated metrics endpoint** `[S]` · _server · frigate · public_
  - *What:* constant-time bearer-token check (UCI 0600) on `/cgi-bin/uxcd-metrics`, fail-closed by default with a clear hint + a one-line opt to keep it open for localhost-only; `uxc metrics` stays the unauthenticated local (root→ubus) path.
  - *Why:* metrics leak the full inventory/restart/health picture — a recon goldmine on a LAN/WAN-reachable router; closes the easiest disclosure hole. (Deferred from v2.)
- **CLOEXEC / fd hygiene across spawned children** `[S]` · _server · frigate · dev · public_
  - *What:* set `O_CLOEXEC`/`SOCK_CLOEXEC` (or `FD_CLOEXEC`) on the ubus connection, uloop epoll, control socket, log/config fds, and job pipes; ensure ujail and docker2uxcd children inherit only their intended stdio/job-log pipe.
  - *Why:* a ujail child or RUN-chroot inheriting the daemon's ubus/secret/config fds is an escalation/disclosure path — worse now that the daemon handles secrets and forks network builds. (Deferred from v2; verify with `ls -l /proc/<pid>/fd`.)

### Management / UX
- **Container rename (and clone)** `[M]` · _server · dev · public_
  - *What:* `rename` ubus + `uxc rename` + LuCI action: stop if running, move registry file/logs/shadow dir, **atomically rewrite `depends_on`/`infra` back-references** in other registries, re-key the in-memory entry, restart; clone = the same plumbing reusing/copying the bundle. Reuses `valid_name()`.
  - *Why:* names are how you navigate everything; today fixing a typo means remove+recreate (losing logs, history, ordering edges). Table-stakes housekeeping; clone makes a staging copy trivial. (Deferred from v2.)
- **Jobs / Activity page with live log + cancel** `[M]` · _frigate · dev · server · public_
  - *What:* surface the existing `job_list/status/log` in a LuCI Activity sub-page (kind/target/age/state/exit + live tail) + a new `job_cancel(id)` that SIGTERM→SIGKILLs the tracked docker2uxcd child, **unmounts its `/proc /dev /sys` build binds**, and rm's the half-written out-dir so nothing partial registers; `uxc job list|log|cancel`.
  - *Why:* a stuck/wrong pull of a fat image over slow WAN can only be killed by hunting a PID today, and finished jobs vanish unless the modal stayed open; this is the `docker ps`-level visibility the audience expects. (Deferred from v2; folds in the "pull `out` dir field" tweak in the create/job UI.)
- **Per-container rollback & `.prev` prune in the UI** `[M]` · _frigate · server · dev · public_
  - *What:* promote CLI-only rollback to a daemon `rollback(name)` (move the bundle↔`.prev` swap + restart out of `uxc.cpp`) + `prune_prev(name)`; LuCI shows "Roll back to previous" (with the captured `.prev` size from `images()`) and "Discard previous" when a `.prev` exists; reuse the guarded `rm_rf`.
  - *Why:* rollback is the whole reason `.prev` exists and maps to the #1 pain — a Frigate update that breaks detection should be one click to revert at 2am from a phone, no SSH. (Deferred from v2.)

### Orchestration
- **Health-gated startup ordering (`depends_on` condition: healthy)** `[M]` · _server · frigate · dev_
  - *What:* extend `depends_on` entries to `{name,condition:"healthy"|"started"}` (bare string still = "started"); gate the dependent's ujail spawn on the dependency's existing health state (poll it, don't sleep/block uloop) + per-edge `wait_timeout` and `on_timeout: start-anyway|fail`; no healthcheck → degrade to "started" with a logged warning.
  - *Why:* "running != ready" is the most common orchestration footgun — a reverse-proxy 502s because its backend isn't serving, Frigate starts before go2rtc/mqtt accept connections; gates on a signal already computed.
- **Health-gated safe update with auto-rollback** `[M]` · _server · frigate_
  - *What:* wire job + `.prev` + healthcheck + rollback into one guarded op: after a bundle swap + restart, watch health for a `confirm_window`; on persistent-unhealthy/crash-loop, auto-swap back to `.prev`, restart, emit `update-failed/rolled-back`; no healthcheck → "stayed up N seconds" fallback; a flag on `uxc pull/build/update` + the LuCI update flow.
  - *Why:* the pieces all exist but aren't connected — a failed update currently leaves a container down until a human notices; auto-rollback makes "update" low-risk for the docker-is-too-much audience. (Merges the two "health-gated update" proposals; the *scheduled/unattended* variant is Tier B.)

### Ecosystem
- **CI-built signed opkg/apk feed (one-line install)** `[L]` · _public · server · frigate · dev_
  - *What:* extend GitHub Actions to build packages via the OpenWrt SDK across an arch matrix, generate + `usign`-sign a `Packages` index, publish to Pages/release assets; users add one `src/gz` line and `opkg install uxcd luci-app-uxcd`; produce ipk **and** apk (24.10+/SNAPSHOT) or pin supported releases; wire schema/lint/install-smoke into the pipeline.
  - *Why:* installation today is a ~30-minute buildroot/SDK compile — a hard wall for the target audience and per-release toil for the maintainer; the single highest-leverage change for adoption. (C++ binaries pull libstdc++ → build per release-branch, not just per arch.)
- **Config backup/restore + sysupgrade persistence** `[L]` · _server · frigate · dev · public_
  - *What:* `export`/`import` ubus over all `/etc/uxc/*.json` + `/etc/config/uxcd` + netns snippets + an **image manifest** (refs/build inputs, *not* bundles — those are regenerable); restore re-pulls/re-builds via the job model and re-registers (opt-in, idempotent vs. re-adoption); ship `/lib/upgrade/keep.d/uxcd` so definitions survive a flash; single-container export underpins clone. Authenticated CGI; secrets 0600.
  - *Why:* `sysupgrade` wiping the irreplaceable curated overrides (volumes/devices/env/healthcheck — especially a finicky Frigate GPU/coral/RTSP config) is the biggest OpenWrt operational fear; "flash firmware and your containers come back" is a flagship reliability/adoption feature. (Merges the three backup proposals; volume *data* snapshot is Tier B.)
- **ubus API versioning + published schema contract** `[M]` · _public · dev · server · frigate_
  - *What:* a `uxcd.api` method returning `{api_version, daemon_version, methods[], features[]}`; stamp `api_version` into `list/info/metrics`; commit versioned JSON Schema + `docs/ubus-api.md` + a semver/deprecation policy; LuCI `uxcd.js` negotiates and hides controls the daemon doesn't advertise.
  - *Why:* the daemon and LuCI ship as independent packages and can legitimately differ in version (and HA/scripts consume ubus directly); today the contract is implicit in src, so any field rename silently breaks the UI. Precondition for every integration here and for the test suite's schema checks. (Folds in the deferred "`create()` accepting all registry fields" as a versioned addition.)

---

## Tier B — Valuable (do after Tier A)

### Management / UX
- **Real dashboard landing (health-first, pod-grouped)** `[M]` · _server · frigate · dev · public_ — running/stopped/unhealthy/crash-looping counts, aggregate mem-vs-host-RAM + summed CPU, a "needs attention" list, in-progress jobs, disk usage; containers grouped by pod; filter/sort/auto-refresh. *Why:* the maintainer wants to spot trouble right after login; a flat alphabetical table buries the crash-looping one.
- **Bulk select + pod/group lifecycle actions** `[S]` · _server · frigate · dev · public_ — checkbox multi-select + per-pod "start/stop whole pod"; mostly client-side sequencing of existing calls (ordered start falls out of `depends_on`); optional daemon `group_action`; add reverse-order stop. *Why:* stack ops are rarely one container at a time; closes most of the "I miss compose" friction cheaply.
- **Log search/filter + one-click download** `[M]` · _server · frigate · dev · public_ — extend `log` with `match`/`since`/`max` (substring, ReDoS-bounded — no regex lib wired in); an **ACL-guarded** `/cgi-bin/uxcd-log` (unlike metrics — logs carry secrets) for full-file download; LuCI search box + highlight + download button. *Why:* day-2 debugging means grepping logs and pulling a full file for a bug report; today it's last-N-lines with no search.
- **In-browser container console** `[L]` · _dev · frigate · server · public_ — optional `luci-app-uxcd-terminal` depending on `ttyd`; `console_open(name)` spawns a loopback-only, token-auth'd, `--once` `ttyd … uxe -t <name> /bin/sh`; falls back to showing the `uxe` command if ttyd absent. *Why:* a shell in the container is the most-used dev/Frigate action and the main thing that makes this feel less complete than Docker — kept opt-in so the core stays lean and the attack surface explicit.

### Observability
- **Aggregate health endpoint (200/503) + per-check breakdown** `[M]` · _server · frigate · public_ — `info()` gains `checks[]` (last result + latency per check); a `/cgi-bin/uxcd-health` returning JSON + HTTP 200/503 for Uptime-Kuma/healthchecks.io/phone widgets; token/basic-auth, trusted-net note; "ok" must exclude intentionally-stopped containers (reuse statusBadge desired-vs-actual). *Why:* a 200/503 URL is the universal language of uptime monitors and the per-check split matters for Frigate's http+resource checks.
- **Retained stats history ring + SVG sparklines** `[M]` · _frigate · server · dev · public_ — per-container RAM ring (~120 samples), `stats_history(name)` ubus, dependency-free inline `<svg>` polylines in the detail modal + overview; optionally persist on clean shutdown. *Why:* LuCI shows instantaneous numbers, never a trend ("memory climbing for 10 min" = leak); a glance tool without standing up Prometheus. (Partly satisfies the deferred "live-stats stream"; a true push stream stays out — LuCI polls.)
- **Outbound heartbeat / dead-man's-switch ping** `[M]` · _server · frigate · public_ — periodic outbound ping (reusing the notify fork→helper) carrying N running/M total/X unhealthy; external service alerts when pings stop. *Why:* every on-box scheme can't tell you when uxcd or the router itself dies — the most important failure; off by default, opt-in.
- **Audit log of management actions** `[M]` · _server · public · dev_ — append `{ts,action,container,result,peer pid/uid}` to a rotated `/var/log/uxcd/audit.log` for every mutating op; `audit_log` reader + LuCI Audit sub-page; scrub secrets. *Why:* "who changed what when" is table stakes once create/pull/build/setconfig/secrets are all UI-driveable on internet-facing routers. (rpcd masks identity as root → log the ubus peer pid and document the limitation.)

### Networking
- **Managed firewall zone + egress/forward policy per pod** `[L]` · _server · public · dev · frigate_ — marker-tagged `config zone` over the pod's host-side veth with input/forward REJECT defaults + `forwarding` sections from a `forward:{wan,lan,pods}` policy; an "adopt existing zone" escape hatch. *Why:* zoning is 100% manual today; gives containers a secure-by-default boundary and is what port-DNAT rules attach to (build *with* port publishing).
- **Container name DNS + hostname registration** `[L]` · _server · dev · public_ — north-south: write `<ip> <name>.<pod-domain>` to a dnsmasq addnhosts file + reload (dedicated `.pod`/`.uxc` domain); east-west: bind-mount a generated `/etc/hosts` of pod members into each (like the existing resolv.conf bind). *Why:* service discovery by name is what makes multi-container usable — `http://app.pod:8080` instead of brittle IPs. (Debounce reloads; east-west snapshot staleness on late membership — document/regen.)
- **Reverse-proxy integration helper** `[L]` · _server · public_ — a `proxy:{vhost,port,upstream}` hint → uxcd writes per-container snippets to a watched dir (nginx/Caddy, 1–2 flavors) + a configurable reload hook; with name-DNS the upstream follows restarts. *Why:* "the server set lives or dies here" — automating upstream wiring is the compose-with-Traefik experience, with zero new daemon deps. **Stays a snippet emitter + reload hook, not a proxy/cert manager.**
- **IPv6 / dual-stack in the netns proto + reporting** `[M]` · _server · public_ — `ip6addr`/`ip6gw` (+ optional SLAAC) in netns.sh, `netns_addrs` also runs `-6`, DNS publishes AAAA; v6-aware firewall path (no NAT, direct forward). *Why:* OpenWrt is heavily v6 and the proto/reporter are hardcoded `-4` today, so v6 is invisible even when it works. (Ship static + optional SLAAC first; leave full DHCPv6-PD as follow-up.)

### Image & Build
- **Multi-stage Dockerfile support** `[L]` · _dev · public_ — parse `FROM … AS <stage>`, build each stage into its own rootfs, resolve `COPY --from=`, keep only the final stage; `ARG` before `FROM`; still single host-arch (error clearly on cross-compile stages). *Why:* multi-stage is the dominant real-world Dockerfile pattern; rejecting it means most wild Dockerfiles fail to build, undercutting the "replace Docker" promise. (Extend the umount-before-rm safety to every stage rootfs.)
- **Build cache reuse for RUN steps** `[L]` · _dev · public_ — chained per-instruction cache key (prev key + instruction text + COPY/ADD content hash), snapshot rootfs to the blob cache, resume from the first changed step; whole-build fast-path; `--no-cache`. *Why:* every rebuild re-runs all RUN steps and re-hits the network today; turns the edit-build-test loop from minutes to seconds. (Size-cap/on-disk option + prune integration since the cache is on tmpfs; per-stage keys.)
- **Scheduled, health-gated auto-update (`auto_update` opt-in)** `[M]` · _server · frigate · public_ — a uloop timer runs `check_updates` (notify-only by default + LuCI badge); per-container `auto_update:true` runs the upgrade job and reuses the Tier-A health-gate + auto-rollback; maintenance-window aware. *Why:* server operators want unattended patching; the health-gate is what makes it safe to ship. (No-healthcheck containers default to notify-only; per-container opt-in keeps bandwidth/quota explicit.)

### Security
- **Secrets store (keep passwords out of plaintext env/registry)** `[L]` · _frigate · server · dev · public_ — 0600 `/etc/uxc/secrets/<name>`; reference via `KEY=@secret` or `secrets:[{name,target}]`; **default to materializing files under a tmpfs `/run/secrets/…` in the shadow bundle** (env-mode warned — readable via `/proc/<pid>/environ` and uxe inheritance); `secret_set/list(names-only)/remove`; LuCI picker; `getconfig` returns the `@ref`, never the value; scrub from logs; included in backup with perms. *Why:* RTSP/upstream/DB creds sit as cleartext env today (now 0600 but still visible in `info`/getconfig and copy-pasted into LuCI); the most-requested "Docker has this" gap for safe config sharing/backup.
- **Curated security presets + read-only rootfs toggle** `[M]` · _frigate · server · dev · public_ — a profile library `/usr/share/uxcd/security/<preset>.json` (`web`/`frigate`/`dev`/`minimal`/`net-admin`) bundling caps deltas + a shipped name-based OCI seccomp profile + `readonly_root` + nnp hints, expanded at launch via the existing caps/seccomp path (explicit overrides win); plus standalone `readonly_root:true` + `tmpfs:[…]` registry fields (must live in the registry so they survive re-pull, unlike the converter's one-shot flag); LuCI Security dropdown + read-only checkbox + writable-paths list. *Why:* caps/seccomp injection exists but forces hand-authored CAP_* lists + raw seccomp paths, so most users leave it permissive; presets make hardening one click mapped to the apps people run, and seccomp+caps+readonly+nnp **is** OpenWrt's confinement layer (no AppArmor/SELinux). (Validate each preset live; presets are starting points.)

### Orchestration
- **uxcd-native stack/pod group (lighter compose alternative)** `[L]` · _server · frigate · dev_ — `/etc/uxc/stacks/<stack>.json` naming existing registry entries + an optional shared infra netns + intra-group ordering; `stack_up/down/restart/status` + `uxc stack` + a LuCI Stacks sub-page; stack autostart replaces per-member autostart. *Why:* all three use cases are inherently multi-container; gives "manage several containers as one thing" without YAML or a second config dialect — composed from primitives already shipped. **Stays a thin grouping over registry entries, not a compose runtime.** (Reframes the deferred compose item.)
- **Volume snapshot / backup + restore (with quiesce hooks)** `[L]` · _server · frigate · dev_ — `backup <name|stack>` job tars declared bind sources + the registry entry + a manifest; optional quiesce (stop, or a `pre_backup` exec hook via setns, e.g. sqlite checkpoint) for crash-consistency; default excludes (Frigate `/media`); restore reverses with confirm + auto-stop. *Why:* stateful volumes (Frigate config.db, server DBs) are what's lost on a bad SD card or botched update; pairs with the update/rollback already shipped. (Refuse RAM/same-device targets; this is the *data* half of the backup story — config half is Tier A.)
- **Auto-apply config changes (restart-on-change)** `[M]` · _server · frigate · dev_ — classify a `setconfig` diff into launch-affecting (volumes/devices/env/resources/caps/seccomp/infra) vs. supervisory (healthcheck interval, max_restarts); apply supervisory live, and under `apply_on_change:restart` gracefully restart for launch-affecting changes (else a "changes pending restart" badge). *Why:* editing a running container in LuCI silently does nothing until someone remembers to restart — a footgun for a management-focused audience. (Opt-in + surfaced; err toward "needs relaunch".)
- **Scheduled restarts & maintenance windows** `[M]` · _server · frigate · dev_ — per-container/stack `schedule:{restart:"0 4 * * *", window:…}` via a tiny 5-field cron parser on a once-a-minute uloop timer (no system cron, stays shell-free); windows relax crash-backoff give-up / permit auto-update + backup; missed ticks skipped. *Why:* long-lived containers leak (Frigate/ffmpeg) and operators want a nightly bounce or a defined "safe to disturb" window rather than a 3am outage.
- **Resource-pressure brake (act on PSI/MemAvailable)** `[M]` · _server · frigate_ — when `/proc/pressure/memory` or MemAvailable crosses a threshold with hysteresis/cooldown, defer new autostarts/job starts and throttle restart storms, emitting pressure events; feature-detected, **observe+report by default, act only if enabled**. *Why:* piles less load onto an already-thrashing small box; the *metrics* half ships in Tier A, this is the optional self-protection layer.

### Ecosystem
- **App catalog: parametrized ready-to-run templates** `[L]` · _public · frigate · server · dev_ — `/usr/share/uxcd/templates/<app>.json` skeletons with a `params` schema + tokens; `uxc new <template> <name>` + a LuCI "App Catalog" form → pull+create+setconfig as a job; curate nginx/Caddy, Frigate, AdGuard/Pi-hole, Uptime-Kuma, code-server, Vaultwarden; templates declare supported arches. *Why:* the literal pitch — today a newcomer must hand-author device/cgroup/cap/shm settings; a guided catalog turns "an afternoon of trial-and-error" into "pick app, fill two fields, go." (Optional remote index is **Tier C**.)
- **Migration helpers: import from `docker run` / compose / stock uxc** `[L]` · _public · server · dev · frigate_ — `uxc import` (in docker2uxcd, shell+jq): translate a `docker run` line (`-v/--device/-e/--restart/--cap-*/--name/--network/image`), a compose subset into multiple registries wired into one pod (compose via optional `yq`), and adopt existing stock-uxc containers; `--dry-run` prints reviewable JSON. *Why:* "paste your docker run line" is the lowest-friction on-ramp imaginable and converts existing-Docker mindshare. **A one-shot reviewable converter, not a live compatibility layer.**
- **Test suite + CI regression gate** `[L]` · _public · dev · frigate · server_ — golden-file tests for the two highest-risk pure-logic paths (layer-flatten/whiteout/config-derivation against fixture tarballs; the registry→shadow-OCI **merge** made host-invokable), CLI arg-parsing tests (the `usage_cpp` ordering bug that already bit), and schema-validation of live `list/info/metrics` against the committed schema; run on every PR; QEMU-OpenWrt boot smoke test best-effort. *Why:* the shadow-config merge is the highest-risk code (a silent regression breaks Frigate GPU/coral access or weakens isolation); a merge-blocking gate is what lets the maintainer accept contributions and refactor confidently.
- **Man pages + generated config/API reference** `[M]` · _public · dev · server · frigate_ — `uxc(1)/uxe(1)/docker2uxcd(1)/uxcd(8)/uxcd.conf(5)/uxc-registry(5)` + a markdown docs site (GitHub Pages) with a worked-examples gallery; generate the registry-field + ubus-method tables from the same source as the schema so docs can't drift. *Why:* a config-driven tool is only usable if the config is documented (the schema lives in the maintainer's head today); man pages are the native, offline way OpenWrt users learn a tool. Low-glamour, high-retention.
- **Home Assistant MQTT-discovery bridge (`uxcd-mqtt`)** `[L]` · _frigate · server · public · dev_ — optional package: a long-lived bridge that subscribes to uxcd ubus events + metrics and publishes each container to HA via MQTT Discovery (state/health/mem/cpu/uptime/restarts sensors + start/stop/restart switches), UCI-configured. *Why:* the Frigate audience already runs HA + MQTT; gives real-time, off-box, automatable control the LuCI poll can't — reusing events/metrics already built. (Separate package keeps the core dep-light; handle retained-topic cleanup on remove.)

---

## Tier C — Exploratory / larger / niche

- **Macvlan / direct-LAN networking mode** `[M]` · _server · frigate · dev_ — a third model: `macvlan` over the LAN uplink moved into the netns + DHCP/static inside, so the container is a first-class LAN host (own MAC/IP, no NAT/ports). *Why:* for appliances people want on the LAN with L2 presence/mDNS (media/home-automation, some Frigate clients). **Doesn't combine with port-publish/zone** (different model) and host↔container is blocked by default — document; UI must reflect mode-specific capabilities. Niche relative to the pod+ports model.
- **Rootless / user-namespace (uid-remap) containers** `[XL]` · _dev · server · public_ — optional userns remap (`uidMappings/gidMappings` in the shadow bundle) so container root maps to an unprivileged host uid; **gated on a daemon-start probe that ujail/jail.c actually honors OCI userns on target kernels.** *Why:* the headline "rootless like podman" defense-in-depth. **Sequence LAST:** high uncertainty (may be unsupported or clash with the setns/infra-join path), bind-mount ownership pain (Frigate `/media`/`/config` owned by host root), and likely incompatible with device passthrough + CAP_SYS_ADMIN — realistically dev-only and clearly experimental; may be scoped down or deferred again after the probe.
- **Remote catalog index fetch** `[S]` · _public_ — let the App Catalog optionally pull `index.json` from a pinned GitHub raw URL so new templates ship without a package upgrade; packaged set is the fallback. *Why:* faster template iteration. Read-only pinned trust surface; keep strictly optional.
- **Full QEMU-OpenWrt end-to-end smoke test** `[L]` · _public · dev_ — boot uxcd under QEMU with the OpenWrt kernel and actually start a busybox bundle (ujail needs the real kernel; can't run on a bare runner). *Why:* the only way to test true ujail/cgroup behavior. Best-effort/manual — the host-runnable golden tests (Tier B test suite) are the high-value 80%.

---

## Carried over from v2 deferrals

| v2 deferred item | Lands as | Tier |
| --- | --- | --- |
| Container rename | Container rename (and clone) | A |
| Job-list/cancel view in LuCI (`job_list`/`job_status` existed, unsurfaced; no cancel) | Jobs/Activity page + `job_cancel` | A |
| Per-container `.prev` rollback/prune in the UI (CLI-only) | Per-container rollback & `.prev` prune in the UI | A |
| Pull `out` bundle-dir field in the UI | folded into the create/Jobs UI | A |
| CLOEXEC on daemon fds inherited by children | CLOEXEC / fd hygiene | A |
| Authentication for the metrics CGI | Authenticated metrics endpoint | A |
| `create()` ubus accepting all registry fields | folded into ubus API versioning (additive) | A |
| Real-time live-stats stream (UI polls mem + sampled %CPU) | stats history ring + sparklines (trend on poll); a true push stream stays a **non-goal** (LuCI polls) | B |
| Compose-style / uxcd-native multi-container group | uxcd-native stack/pod group + `docker run`/compose import | B |

## Non-goals (explicit)

- **Cross-architecture builds / qemu / binfmt emulation.** Host-architecture only, by design — diagnostics explain this instead.
- **A compose YAML runtime or second config dialect.** We offer native stacks (grouping over the existing registry) and a one-shot, reviewable compose/`docker run` *importer* — not a live compatibility layer or parser the daemon depends on.
- **Kubernetes-style scheduling, multi-node clustering, or live migration / checkpoint-restore.** uxcd is a single-box supervisor.
- **Becoming a reverse-proxy or certificate manager.** We emit upstream/vhost snippets + a reload hook and delegate TLS/ACME to the proxy.
- **Full SBOM / vulnerability scanning.** Provenance (ref + digest + labels) and digest pinning only.
- **Heavy runtime dependencies in the core.** The C++ daemon stays shell-free and dep-light; ttyd console, MQTT bridge, and any charting live in *optional* packages.
- **Browser-side ubus event streaming.** LuCI remains client-side JS that polls; off-box real-time lives in the metrics/MQTT/heartbeat paths instead.

