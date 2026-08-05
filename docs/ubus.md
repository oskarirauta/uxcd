# ubus interface

uxcd registers a ubus object **`uxcd`**. `uxc` and the LuCI app are thin clients
over it; you can call it directly. `ubus -v list uxcd` prints the live method
signatures.

> The machine-readable **contract** — the `api` method, versioning, feature flags
> and a committed JSON schema — is in [`ubus-api.md`](ubus-api.md).

## Lifecycle & inspection

```sh
ubus call uxcd list                                   # all containers + state + stats + health + update/upgrade
ubus call uxcd info    '{"name":"frigate"}'           # one container, full detail
ubus call uxcd log     '{"name":"frigate","lines":50}'
ubus call uxcd log_clear '{"name":"frigate"}'
ubus call uxcd start   '{"name":"frigate"}'
ubus call uxcd stop    '{"name":"frigate"}'
ubus call uxcd restart '{"name":"frigate"}'
```

`info` returns everything `list` reports for one container plus the OCI command/
cwd/hostname/root, uptime, restart count, the config file path, the effective
settings, the network namespace + addresses, exit reason / OOM / PSI, image +
digest provenance and schedules — a single place for a UI to read it all.

## Exec & console

Run a one-off command inside a **running** container and get its result back (the
`exec` feature; the reply is deferred, so a slow command never blocks the daemon):

```sh
ubus call uxcd exec '{"name":"web","command":["ps","aux"]}'                          # -> {"exit_code":0,"output":"…"}
ubus call uxcd exec '{"name":"web","command":["sh","-lc","sleep 5"],"timeout":10}'  # timeout in seconds (default 30)
```

`command` is an argv array executed in the container's namespaces with combined
stdout+stderr captured into `output`; the reply also carries `exit_code` (plus
`signal` / `timed_out` when they apply), or `error` if the container isn't running.

The in-browser shell is the opt-in **`uxcd-console`** package (ttyd); these two
methods back it:

```sh
ubus call uxcd console        '{"name":"web"}'                            # spawn a one-shot ttyd -> {"port":<n>,"scheme":"http"}
ubus call uxcd console        '{"name":"web","tls":1,"bind":"192.168.1.1"}'  # https (reuse the LuCI cert); optional bind address
ubus call uxcd console_active '{"port":<n>}'                              # -> {"active":true} while that ttyd is still up
```

`console` allocates a random port and returns `{port, scheme}` for the LuCI app to
iframe; if the console is disabled or ttyd is missing it returns `{error, command}`
with the manual `uxe <name> /bin/sh` fallback. `console_active` lets the app close
the browser tab once the one-shot session ends.

## Registration & config

```sh
ubus call uxcd create   '{"name":"web","bundle":"/srv/web","autostart":true,"infra":"cntr"}'
ubus call uxcd remove   '{"name":"web"}'
ubus call uxcd rename   '{"name":"web","new_name":"web2"}'   # stopped containers only
ubus call uxcd getconfig '{"name":"web"}'                    # raw /etc/uxc/web.json
ubus call uxcd setconfig '{"name":"web","config":{ ... }}'   # replace it (atomic, validated, applies on restart)
```

## Images: pull / build / updates / registries

```sh
ubus call uxcd pull    '{"image":"docker.io/library/nginx:alpine","name":"web","profile":"frigate"}'  # -> {"job":"j1"}
ubus call uxcd build   '{"dockerfile":"/root/app/Dockerfile","name":"app"}'                            # -> {"job":"j2"}
ubus call uxcd list_profiles                           # { "profiles": ["frigate", ...] }
ubus call uxcd check_updates                           # on-demand; flags update_available in list/info
ubus call uxcd upgrade  '{"name":"web"}'               # re-pull + restart (health-gated safe-update) -> {"job":...}
ubus call uxcd upgrade  '{"name":"web","image":"nginx:1.29-alpine"}'  # version/tag jump through the same gate
ubus call uxcd rollback '{"name":"web"}'               # swap back to the .prev bundle + restart
ubus call uxcd registry_set    '{"registry":"ghcr.io","username":"me","password":"<token>"}'
ubus call uxcd registry_list                           # hosts + usernames (never passwords)
ubus call uxcd registry_remove '{"registry":"ghcr.io"}'
```

`pull`/`build` accept the converter's bundle options too (`profile`, `caps`,
`network`, `privileged`, `arch`, `infra`, `autostart`, `out`, `dev`, …) — see
[images.md](images.md); `dev: true` makes a dev container
([dev-containers.md](dev-containers.md)). `build` also takes
`dockerfile_content` (inline recipe; written to `<bundle>.Dockerfile` and built
from there — the LuCI wizard's path), and `host_devices` reports the attachable
devices the box has (`gpu`/`usb`/`tun` booleans + `serial[]`/`apex[]` paths).

## Jobs (async pull/build/upgrade)

A pull/build/upgrade runs as a captured background job; poll its progress:

```sh
ubus call uxcd job_list
ubus call uxcd job_status '{"id":"j1"}'
ubus call uxcd job_log    '{"id":"j1","lines":50}'
ubus call uxcd job_cancel '{"id":"j1"}'
```

## Disk, metrics & events

```sh
ubus call uxcd images                                  # bundle sizes (+ .prev) and the blob cache
ubus call uxcd prune  '{"target":"cache"}'             # cache | prev | all -> { removed, freed }
ubus call uxcd metrics                                 # { "metrics": "<Prometheus text>" }
ubus call uxcd events '{"limit":50}'                   # recent event timeline
ubus call uxcd events_clear
```

uxcd also broadcasts a ubus event **`uxcd.container`** on each state change
(`started`, `exited`, `healthy`, `unhealthy`, `adopted`, `update_available`,
`auto_upgrade`, `scheduled_*`, …) with `{name, event, running, health}`, so a UI
updates live instead of polling:

```sh
ubus listen uxcd.container
```
