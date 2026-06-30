# uxcd v3 Roadmap

uxcd already runs containers well on a single OpenWrt box: lifecycle + crash backoff, healthchecks, events, metrics, registry-driven OCI injection, pods (shared netns), a LuCI app, and a Docker-free image pull/build path. **v3 is about trust and reach, not new runtime surface.** Most of the original v3 plan has shipped (and was verified live on the maintainer's box); the **remainder is scope-locked (2026-06-30)** below.

This list has been deliberately triaged for a **good-but-compact** tool: it does not try to match everything the big runtimes do — only enough to serve most people for whom docker/podman is too much. Effort: `S` ≈ hours–day, `M` ≈ days, `L` ≈ week+. Use cases: **server** (http/reverse-proxy), **Frigate** (NVR + GPU/coral/RTSP), **dev**, plus the broader **public**.

**Guiding principles**
- Make the things people already configured — restart policies, healthchecks, overrides — *reach the operator* and *survive the box*, without adding a daemon, a config dialect, or a dependency to the shell-free C++ core.
- **OpenWrt owns the network and firewall.** uxcd configures container networking via the `netns` proto; the administrator builds firewall/DNS/reverse-proxy infrastructure (fw4, dnsmasq) the OpenWrt way. uxcd does not manage system services.
- Small footprint, OpenWrt-native (ubus/uci/ujail/netifd/uhttpd), host-architecture only.
- **Everything is verified live on the box before it ships** — features that can't be live-tested here are left community-buildable, not shipped untested.

---

## Shipped in v3 ✅

The bulk of v3 has landed. Grouped:

- **Image lifecycle (flagship chain):** provenance (`ref` + resolved `sha256` digest), update detection (`check_updates`, manifest-only), one-click upgrade keeping registry overrides + `.prev`, health-gated safe-update + auto-rollback, scheduled update check (notify-only), opt-in per-container auto-upgrade, `.prev` rollback + prune.
- **Import family:** `uxc compose` (block-YAML → shared-netns pod), `uxc import` (docker run), `uxc import uxc` (stock-uxc adopt) — one-shot imports, not a runtime.
- **Security:** `noNewPrivileges` by default + `privileged` opt-in, authenticated metrics endpoint (localhost-open default), CLOEXEC / fd hygiene.
- **Observability:** OOM + exit-reason + PSI metrics (observe-only), persistent event timeline + LuCI Activity page, start-failure "port in use" hint (log-tail heuristic → `fault` field + `UXCD_FAULT`).
- **Management / UX:** container rename, jobs/Activity + cancel, "config changed — restart to apply" badge, daemon settings page (UCI `form.Map`), sortable overview columns, created/upgraded timestamps, shell-only notification dispatcher + heartbeat.
- **Container-compat knobs:** user/rlimits/sysctl/shm_size/tmpfs/env_file/stop_signal; non-interactive `uxcd.exec` + `uxc exec` + LuCI Exec tab + log download; disk/flash guard.
- **Orchestration:** health-gated startup ordering, scheduled actions (5-field cron, no system crond).
- **Ecosystem:** `/lib/upgrade/keep.d/uxcd` sysupgrade persistence, README + `docs/` split, examples gallery, starter profile gallery, `cntrinit` packaged (manual inject), **opt-in ttyd browser console** (`uxcd-console` package).

---

## Remaining (scope locked 2026-06-30)

### Tier A
- **ubus API: published schema + docs + `uxcd.api`** `[M]` — a `uxcd.api` method ({daemon_version, methods, features}) + a committed JSON schema + `docs/ubus-api.md`, so LuCI/scripts have a contract and a field rename can't silently break the UI. Also the enabler for the community HA-MQTT bridge (events + metrics interface). *(No heavy semver/deprecation machinery.)*

### Tier B
- **Security presets + read-only rootfs** `[M]` — a small profile library (`frigate`/`web`/`minimal`) expanded at launch via the existing caps/seccomp path, plus standalone `readonly_root:true` + `tmpfs:[…]` registry fields; LuCI Security dropdown + read-only toggle. One-click hardening mapped to the apps people run.
- **Overview summary counts** `[S]` — a health-first line on the Containers overview: counts (running / stopped / unhealthy / crashed). *(Pod-grouping cut — clashes with the new column sort; bulk-select cut — `depends_on` covers pod start.)*
- **Stats history + SVG sparklines (browser-side)** `[M]` — per-container RAM (+CPU) ring in the LuCI client (~120 samples) + dependency-free inline `<svg>` trend. Resets on reload — same model as OpenWrt's own live traffic charts; the Prometheus metrics CGI covers persistent history.
- **Multi-stage Dockerfile** `[L]` — `FROM … AS`, build each stage, resolve `COPY --from=`, keep the final (umount-before-rm safety per stage). Kept because "Docker-free build" is a flagship differentiator and half-support breaks the promise. Lower priority.
- **IPv6 in the netns proto** `[M]` — `ip6addr`/`ip6gw` (+ optional SLAAC) in `netns.sh`, `netns_addrs -6`, v6 in `info`. **Default disabled; opt-in `option ipv6 '1'` per netns** (a v6 address is often globally routable). Live-testable via ULA (`fd00::/8`) without ISP v6. Kept because OpenWrt is dual-stack to the core — a v4-only proto is *incomplete*, not merely missing a feature. Lower priority (timing, not importance).

### Tier C — optional / community / later
- **Test suite + CI regression gate** `[L]` — host-runnable golden-file tests for the highest-risk pure logic (above all the registry → shadow-OCI merge), CLI arg-parsing, schema-validation of live `list/info/metrics`, run on every PR. Moved here from Tier B.
- **HA MQTT-discovery bridge** `[L]` _(community-buildable, package `uxcd-mqtt`)_ — uxcd events + metrics → Home Assistant entities via MQTT Discovery. **Not shipped by us:** it can't be live-verified without an HA instance, and it needs no core change — the events+metrics interface already exists and the Tier-A ubus-API docs make it buildable by an HA user in their own environment.

### Tier D — LuCI layout polish `[S]`
- Long help/description texts broken with line breaks so they wrap nicely in the modal instead of overflowing.
- A blank line / separator between sections in the larger forms, for readability.
- Small, cosmetic, batched at the end.

---

## Deliberately out of scope (and why)

These were considered and **cut** to keep uxcd compact and within its lane:

- **Pruned from the v3 plan (2026-06-30):** multi-arch `inspect` (diagnostics nice-to-have, low leverage), signed opkg/apk feed (CI build runs; a signed feed is heavy release machinery for now), config export/import (keep.d already protects definitions across flash), overview pod-grouping (clashes with column sort), bulk-select + pod actions (`depends_on` covers pod start; keeps the overview minimal), log search (the authenticated log *download* already shipped covers it), reverse-proxy snippet emitter (netns IP is static so the IP-follow value is marginal, and it nudges the "admin owns the proxy" line), full QEMU end-to-end test (the host-runnable golden tests are the high-value 80%).
- **Cross-architecture builds / qemu / binfmt.** Host-architecture only — diagnostics explain this.
- **Firewall management** (auto port-publish DNAT, managed per-pod zones). fw4 + the administrator own the firewall; a container tool injecting/reconciling rules is fragile (a VPN/firewall reload drops them — the classic docker-on-OpenWrt failure) and blurs responsibility. Route to a container's netns IP with your own `config redirect` / fw4 include — a few lines, the OpenWrt way.
- **DNS / dnsmasq management** (container-name registration). Same reasoning — a system service the admin owns. (Pod members already share `127.0.0.1`.)
- **A native multi-container "stack" abstraction.** `depends_on` (ordering + pull-deps-up) + the infra/pod netns + bulk pod actions already cover "manage several as one" — a separate stack file/engine adds little.
- **Volume *data* backup/restore.** Config backup covers the irreplaceable part; backing up bind-mount *data* is the admin's cron/tar job.
- **Secrets-management subsystem.** Env/registry files are 0600; a full secrets store (file-materialized refs, pickers) is a large subsystem for marginal gain at this scale.
- **Build cache for RUN steps.** rootfs snapshots on a RAM-backed cache for an occasional router-side build is complexity out of proportion to use.
- **Audit log, aggregate health 200/503 endpoint, container clone, app-template store, macvlan mode, rootless/userns, remote catalog index.** Each is either redundant with something kept, an admin's job, or too large/niche for the footprint. (Rootless/userns additionally breaks device passthrough, i.e. Frigate.)
- **A compose YAML *runtime*** (the one-shot compose *import* shipped), Kubernetes-style scheduling/clustering/live-migration, becoming a reverse-proxy or cert manager, full SBOM/vuln scanning, heavy core dependencies, browser-side ubus event streaming.

**Guiding rule for v3:** if an item would make uxcd start to *own* something OpenWrt already owns (firewall, DNS, the proxy, scheduling), or grow an unbounded maintenance surface, it belongs here in "out of scope", not in the plan.
