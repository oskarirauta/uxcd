# ubus interface

uxcd registers a ubus object **`uxcd`**. `uxc` and the LuCI app are thin clients
over it; you can call it directly. `ubus -v list uxcd` prints the live method
signatures.

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
ubus call uxcd rollback '{"name":"web"}'               # swap back to the .prev bundle + restart
ubus call uxcd registry_set    '{"registry":"ghcr.io","username":"me","password":"<token>"}'
ubus call uxcd registry_list                           # hosts + usernames (never passwords)
ubus call uxcd registry_remove '{"registry":"ghcr.io"}'
```

`pull`/`build` accept the converter's bundle options too (`profile`, `caps`,
`network`, `privileged`, `arch`, `infra`, `autostart`, `out`, …) — see
[images.md](images.md).

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
