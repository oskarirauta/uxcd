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
- **Build provenance + recipes (2026-09):** a Dockerfile-built container records a `build` block (base ref + resolved base digest, Dockerfile path + sha256), so `check_updates` follows its *base* and reports `rebuild`, and `upgrade` re-**builds** through the same health gate and `.prev` rollback instead of pulling the stock image over a customised rootfs. On top of that, a profile with a `_source` block is a **recipe** that deploys itself — `uxc deploy` / ubus `deploy` / LuCI **Recipes** — doing pull-or-build + `_paths` host dirs (mode/uid/gid) + `_seed` config files + `_registry` in one idempotent step. Ships `caddy`, `php-fpm`, `cron`.
- **Import family:** `uxc compose` (block-YAML → shared-netns pod), `uxc import` (docker run), `uxc import uxc` (stock-uxc adopt) — one-shot imports, not a runtime.
- **Security:** `noNewPrivileges` by default + `privileged` opt-in, authenticated metrics endpoint (localhost-open default), CLOEXEC / fd hygiene, standalone read-only rootfs (`readonly_root` + `tmpfs`) with a CAP_SYS_ADMIN-drop assist, LuCI capability reference on the Security tab.
- **Observability:** OOM + exit-reason + PSI metrics (observe-only), persistent event timeline + LuCI Activity page, start-failure "port in use" hint (log-tail heuristic → `fault` field + `UXCD_FAULT`), per-container RAM/CPU SVG sparklines on the detail page (browser-side ring, ~120 samples).
- **Management / UX:** container rename, jobs/Activity + cancel, "config changed — restart to apply" badge, daemon settings page (UCI `form.Map`), sortable overview columns, health-first summary counts on the Containers overview (running / stopped / unhealthy / crashed), created/upgraded timestamps, shell-only notification dispatcher + heartbeat.
- **Container-compat knobs:** user/rlimits/sysctl/shm_size/tmpfs/env_file/stop_signal; non-interactive `uxcd.exec` + `uxc exec` + LuCI Exec tab + log download; disk/flash guard.
- **Orchestration:** health-gated startup ordering, scheduled actions (5-field cron, no system crond).
- **Ecosystem:** `/lib/upgrade/keep.d/uxcd` sysupgrade persistence, README + `docs/` split, examples gallery, starter profile gallery, `cntrinit` packaged (manual inject), **opt-in ttyd browser console** (`uxcd-console` package).
- **API contract:** a self-describing `uxcd.api` method (daemon + api version, the served method list with parameter types, feature flags), a committed JSON schema (`docs/ubus-api.schema.json`) + `docs/ubus-api.md` — so LuCI/scripts have a contract a field rename can't silently break.
- **Docker-free build (multi-stage):** `FROM … AS`, `COPY --from=<name|index>`, `FROM <stage>` rootfs+config inheritance, in both the C++ converter and `docker2uxc.sh`.
- **Networking (IPv6):** opt-in per-netns IPv6 in the `netns` proto (dual-stack `ip6addr`/`ip6gw`/SLAAC, ULA-testable), with v6 addresses in `info` + the LuCI detail view.
- **LuCI polish:** reflowed/paragraphed help texts, a **Stats** detail tab, aligned + badged Overview/Activity/Images/Registries tables, Rename moved to a ✎ on the editor title, a themed Status-overview containers widget, consistent modal spacing.

---

## Remaining — community / optional / later

The Tier A ubus-API contract, the Tier B items (multi-stage Dockerfile, netns IPv6) and the Tier D LuCI polish have all shipped — see *Shipped in v3* above. What is left is deliberately community-buildable or optional:

- **Test suite + CI regression gate** `[L]` — host-runnable golden-file tests for the highest-risk pure logic (above all the registry → shadow-OCI merge), CLI arg-parsing, schema-validation of live `list/info/metrics`, run on every PR. Moved here from Tier B.
- **HA MQTT-discovery bridge** `[L]` _(community-buildable, package `uxcd-mqtt`)_ — uxcd events + metrics → Home Assistant entities via MQTT Discovery. **Not shipped by us:** it can't be live-verified without an HA instance, and it needs no core change — the events+metrics interface already exists and the Tier-A ubus-API docs make it buildable by an HA user in their own environment.

---

## Deliberately out of scope (and why)

These were considered and **cut** to keep uxcd compact and within its lane:

- **Pruned from the v3 plan (2026-06-30):** multi-arch `inspect` (diagnostics nice-to-have, low leverage), signed opkg/apk feed (CI build runs; a signed feed is heavy release machinery for now), config export/import (keep.d already protects definitions across flash), overview pod-grouping (clashes with column sort), bulk-select + pod actions (`depends_on` covers pod start; keeps the overview minimal), log search (the authenticated log *download* already shipped covers it), reverse-proxy snippet emitter (netns IP is static so the IP-follow value is marginal, and it nudges the "admin owns the proxy" line), full QEMU end-to-end test (the host-runnable golden tests are the high-value 80%).
- **Security-preset profile library (`frigate`/`web`/`minimal` "one-click hardening" dropdown).** Cut 2026-07-03 — redundant with two things that already shipped. The `docker2uxc` **profile overlay** (`profiles/<name>.json`, deep-merged onto `config.json` at pull/build, dropdown in LuCI) already carries `caps`/`seccomp`, so a second security-only profile mechanism would be a parallel path for the same job. And the **LuCI capability reference + Drop/Add caps editor** on the Security tab give the operator direct, transparent control rather than an opaque "one preset hardens everything". The genuinely non-overlapping half — standalone **read-only rootfs** — shipped separately; only the preset *library* is cut.
- **Cross-architecture builds / qemu / binfmt.** Host-architecture only — diagnostics explain this.
- **Firewall management** (auto port-publish DNAT, managed per-pod zones). fw4 + the administrator own the firewall; a container tool injecting/reconciling rules is fragile (a VPN/firewall reload drops them — the classic docker-on-OpenWrt failure) and blurs responsibility. Route to a container's netns IP with your own `config redirect` / fw4 include — a few lines, the OpenWrt way.
  - **Still cut — but the underlying need got a different answer (2026-09).** "Reach one service in an isolated container from a browser" shipped as **published ports**: `ports` in the registry entry, served by a `tcpredir` child tied to the container's lifetime. It injects no rules and reconciles nothing, so the reason DNAT was rejected (a firewall reload silently drops what the container tool put there) cannot happen. It is a userspace proxy, which costs the real client address — documented plainly, with the fw4 `config redirect` shown as the alternative for anything that logs or gates on it. uxcd still writes nothing to fw4, and never touches the administrator's own `/etc/config/tcpredir`.
- **DNS / dnsmasq management** (container-name registration). Same reasoning — a system service the admin owns. (Pod members already share `127.0.0.1`.)
- **A native multi-container "stack" abstraction.** `depends_on` (ordering + pull-deps-up) + the infra/pod netns + bulk pod actions already cover "manage several as one" — a separate stack file/engine adds little.
- **Volume *data* backup/restore.** Config backup covers the irreplaceable part; backing up bind-mount *data* is the admin's cron/tar job.
- **Secrets-management subsystem.** Env/registry files are 0600; a full secrets store (file-materialized refs, pickers) is a large subsystem for marginal gain at this scale.
- **Build cache for RUN steps.** rootfs snapshots on a RAM-backed cache for an occasional router-side build is complexity out of proportion to use.
- **Audit log, aggregate health 200/503 endpoint, container clone, macvlan mode, rootless/userns, remote catalog index.** Each is either redundant with something kept, an admin's job, or too large/niche for the footprint. (Rootless/userns additionally breaks device passthrough, i.e. Frigate.)
- **An "app-template store".** Cut as a *store*, and it stays cut: no remote catalogue, no index to fetch, no download. What shipped instead (2026-09) is **recipes** — the existing profile format grown a `_source` block, so the mechanism that already carried caps/mounts/`_registry`/`_seed` also says where the container comes from. No parallel path, no new file format, and nothing fetched from the internet to then run `RUN` steps as root on your box. Recipes ship with the package, or you write them.
- **A compose YAML *runtime*** (the one-shot compose *import* shipped), Kubernetes-style scheduling/clustering/live-migration, becoming a reverse-proxy or cert manager, full SBOM/vuln scanning, heavy core dependencies, browser-side ubus event streaming.

**Guiding rule for v3:** if an item would make uxcd start to *own* something OpenWrt already owns (firewall, DNS, the proxy, scheduling), or grow an unbounded maintenance surface, it belongs here in "out of scope", not in the plan.
