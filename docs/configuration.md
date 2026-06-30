# Configuration

uxcd has two layers of configuration:

- **Daemon settings** — `/etc/config/uxcd` (UCI). Global knobs for the supervisor.
- **Per-container settings** — `/etc/uxc/<name>.json` (the same registry the stock
  `uxc` uses). One JSON file per container.

A missing file or option keeps the built-in default, so uxcd runs out of the box.
Both survive a `sysupgrade`: `/etc/config/uxcd` is kept automatically and the
package ships `/lib/upgrade/keep.d/uxcd` to preserve `/etc/uxc`. The OCI bundles
themselves (each container's `path`) are **not** backed up — keep them on
persistent storage, or re-create them with `uxc pull` / `uxc build` after a flash.

## Daemon settings (`/etc/config/uxcd`)

Edit by hand, or from the LuCI **Containers → Settings** page (a UCI form with a
"Restart uxcd" button). `uxcd` also takes `-s <socket>`, `-d` (debug) and
`-h`/`-V` on the command line; `-s`/`-d` override the file.

```
config uxcd 'main'
	option log_lines         '200'    # default number of lines `uxc log` returns
	option log_size          '64'     # KB per-container log file before rotation
	option restart_delay     '2'      # s, base delay before respawning an exited container
	option restart_max_delay '60'     # s, cap for the exponential crash backoff
	option max_restarts      '0'      # give up after N rapid crashes (0 = never)
	option stop_timeout      '5'      # s, SIGTERM grace before SIGKILL
	option infra_watch       '5'      # s, infra-netns watchdog interval
	option probe_timeout     '1500'   # ms, tcp/http healthcheck connect timeout
	option start_timeout     '60'     # s, fail-open wait for a dependency to become healthy
	option safe_update       '1'      # health-gate an upgrade + auto-rollback (when a healthcheck exists)
	option safe_update_window '120'   # s, how long a fresh upgrade must stay healthy
	option update_check_cron ''       # cron for the scheduled update check ('' = off)
	option bundle_dir        '/srv/uxc'  # where pull/build land a bundle with no explicit --out
	option disk_min          '50'     # MB; refuse pull/build/upgrade below this free in bundle_dir (0 = off)
	option metrics_public    '0'      # 1 = allow remote scrape of the metrics CGI (default localhost-only)
	option debug             '0'      # verbose/debug logging
```

Each container's stdout/stderr is captured to `/var/log/uxcd/<name>.log` (rotated
to `.log.1` past `log_size` KB), so `uxc log` survives a uxcd restart.

## Per-container settings (`/etc/uxc/<name>.json`)

Beyond `path` (the OCI bundle), `autostart` and `respawn`, a container may carry
runtime overrides that uxcd merges into a generated **shadow OCI bundle** at
launch. Keeping them here — not in the image's `config.json` — means they survive
an image update / re-pull.

```json
{
  "name": "frigate", "path": "/srv/frigate", "autostart": true,
  "infra": "cntr",
  "volumes": ["/srv/frigate/config:/config", "/srv/media:/media:ro"],
  "devices": ["/dev/dri", "/dev/bus/usb/001/004"],
  "env": ["TZ=Europe/Helsinki", "FRIGATE_RTSP_PASSWORD=secret"],
  "resources": { "memory": { "limit": 2147483648 }, "pids": { "limit": 512 } },
  "depends_on": ["mqtt"],
  "cap_drop": ["ALL"], "cap_add": ["CAP_NET_BIND_SERVICE"],
  "no_new_privileges": true,
  "seccomp": "/etc/uxc/seccomp/frigate.json",
  "auto_upgrade": false,
  "healthcheck": { "...": "see below" },
  "schedule": [ { "cron": "0 4 * * *", "action": "restart", "enabled": true } ]
}
```

- `volumes` — `src:dst[:ro]` bind mounts.
- `devices` — device node paths (or a directory, whose nodes are added); each gets
  a device node **and** a cgroup device-allow rule, so e.g. `/dev/dri` works.
- `env` — `KEY=VAL` added to the container environment. (May hold secrets; the
  registry file is written `0600`.)
- `resources` — OCI `linux.resources`, merged over the image's (memory/pids/cpu).
- `depends_on` — other containers that must run first; they are started
  automatically and this one waits for them (boot order falls out of this). With
  a dependency that has a healthcheck, the wait is until *healthy* (bounded by
  `start_timeout`).
- `cap_drop` / `cap_add` — Linux capabilities, Docker-style: base set is the
  bundle's own (or a sane default), then `cap_drop` removes (`"ALL"` clears it)
  and `cap_add` adds. Written to OCI `process.capabilities`.
- `no_new_privileges` — OCI `process.noNewPrivileges` (default **true**;
  `--privileged` at pull/build time, or this set false, opts out).
- `seccomp` — path to an OCI seccomp profile (`linux.seccomp`), or `"unconfined"`
  for no filter. Omit to keep the bundle's own.
- `infra` — join a shared network namespace; see [networking.md](networking.md).
- `auto_upgrade` — opt in to a hands-free safe-upgrade when the scheduled update
  check finds a new image; see [images.md](images.md). Default false = notify only.
- `image` / `digest` — provenance recorded by `uxc pull` (the ref and the
  resolved manifest digest); the update check compares against them. Don't edit.

Edits take effect on the next start/restart. Edit by hand (then restart uxcd or
the container) or from the LuCI per-container editor (which applies atomically and
is validated before it is saved).

### Healthcheck

```json
"healthcheck": {
  "interval": 30, "retries": 3, "on_unhealthy": "restart",
  "checks": [
    { "type": "http", "target": "127.0.0.1:5000/api/version" },
    { "type": "resource", "memory_max": 1610612736, "cpu_max": 90 },
    { "type": "exec", "command": ["/bin/sh","-c","pgrep frigate"], "timeout": 5 }
  ]
}
```

`tcp` / `http` probe a port; `resource` checks cgroup memory/cpu; `exec` runs a
command inside the container (joining its namespaces, like `uxe`) and treats a
non-zero exit (or `timeout` seconds) as failure. State is reported as `health` in
`list`/`info`; with `on_unhealthy: "restart"` an unhealthy container is restarted.
A healthcheck also gates the one-click **safe-update** (see [images.md](images.md)).

### Scheduled actions

```json
"schedule": [
  { "cron": "0 4 * * *", "action": "restart", "enabled": true },
  { "cron": "30 22 * * *", "action": "stop",  "enabled": true },
  { "cron": "0 6 * * *",  "action": "start", "enabled": true }
]
```

A 5-field cron (`min hour dom mon dow`; `*`, `N`, `A-B`, `*/S`, `A-B/S` and
comma-lists; `dow` 0 and 7 are both Sunday) fires `restart` / `stop` / `start`
once per matching minute, in the host's local time. No `crond` dependency — uxcd
schedules these itself. A `stop` + `start` pair makes a maintenance window. Edit
from the LuCI editor's **Schedule** tab.

## Notifications (`notify_hook`)

uxcd never sends notifications itself — it runs a shell hook on every event and
lets you do the transport (ntfy, webhook, e-mail, …). Configure it in
`/etc/config/uxcd` (or the LuCI **Settings → Notifications** tab):

```
config uxcd 'main'
	option notify_hook '/etc/uxcd/notify.sh'
	option notify_debounce '30'   # min seconds between identical (name,event); 0 = none
	option heartbeat '3600'       # seconds between "heartbeat" events; 0 = off
```

The hook is called as `notify.sh <name> <event>` with the event detail in the
environment: `UXCD_EVENT`, `UXCD_CONTAINER`, `UXCD_HEALTH`, `UXCD_RUNNING`, and on
an exit `UXCD_OOM` / `UXCD_SIGNAL` / `UXCD_EXIT_CODE`, plus `UXCD_FAULT` when uxcd
spots a likely cause in the log (see Start-failure hints). Events include `started`,
`exited`, `healthy`, `unhealthy`, `gave_up` (crash-loop give-up), `upgraded`,
`rolled_back`, `rollback_failed`, and `heartbeat`. It runs detached, so a slow
hook never blocks the daemon.

The **heartbeat** is a dead-man's switch: its *absence* tells you the box itself
died (a notifier on a dead box can't fire) — point it at a healthchecks.io-style
"ping, else alert" URL.

Example `/etc/uxcd/notify.sh` — heartbeat ping + push on trouble:

```sh
#!/bin/sh
case "$UXCD_EVENT" in
	heartbeat)
		curl -fsS -m 10 https://hc-ping.com/your-uuid >/dev/null 2>&1 ;;
	gave_up|unhealthy|rollback_failed)
		[ "$UXCD_OOM" = "true" ] && t="OOM-killed" || t="$2"
		curl -fsS -m 10 -H "Title: uxcd: $1" -d "$t (health=$UXCD_HEALTH)" \
			https://ntfy.sh/your-topic >/dev/null 2>&1 ;;
esac
```

## Browser console (`uxcd-console`)

The LuCI overview has a **Console** button that opens a shell into a running
container in a modal terminal (served by [ttyd]). The terminal is
**unauthenticated** — anyone who can reach its port during the short-lived
session gets a root shell in the container — so it is a **separate, opt-in
package**: install `uxcd-console` to enable it, leave it out to keep the feature
off entirely. The package pulls in `ttyd` and sets one switch:

```
config uxcd 'main'
	option console_enabled '1'   # set by the uxcd-console package; the button is inert without it
```

Without the flag (or the package) the **Console** button just prints the
`uxe <name> /bin/sh` command to run in a terminal instead.

How it serves the terminal:

- **The scheme follows the LuCI page** — opened from an https page the console is
  https (reusing the uhttpd cert, so no mixed content); from an http page it is
  plain http (no self-signed-cert prompt on the console's random port). This is
  automatic: browsers block mixed content, so the console must match the page.
- ttyd runs **one-shot** — the session ends when you type `exit` or close the
  modal, and LuCI closes the modal for you. Idle consoles are reaped after 60s.
- It binds to the IP you reached LuCI on, so the terminal is no more exposed than
  LuCI itself. uxcd does not touch the firewall.

> **https note:** on an https page the console reuses the uhttpd cert but on a
> *different* port, which the browser treats as a new origin; some browsers
> (Safari especially) won't let an iframe accept a self-signed cert silently. The
> http path has no such issue — for https, open the console URL once in a normal
> tab to accept the cert first, or use an http LuCI page.

[ttyd]: https://github.com/tsl0922/ttyd

## Start-failure hints

When a container exits non-zero on its own (not stopped, not OOM-killed), uxcd
peeks at the tail of its log for the universal "address already in use" message
and, if found, records it as a fault. This saves you digging through the log for
the most common reason a container won't start - a port it wants is already taken
(by another container in the same network namespace, or a host service such as
uhttpd on `:80`). The fault then shows up:

- in LuCI as a red **port in use** badge on the overview and a **Likely cause**
  line in the container's detail view;
- as `UXCD_FAULT` in the notify hook's environment on the `exited` event.

It is a hint, not a guard - uxcd never blocks a start over it, and it does not
manage ports or the firewall (reaching a container's ports is the admin's job).
