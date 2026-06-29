# uxcd examples

Ready-to-adapt sample configs. They are installed under
`/usr/share/uxcd/examples/` and are **not** active - copy what you need into
place and edit it.

## Per-container registry files (`etc/uxc/<name>.json`)

These live in `/etc/uxc/` (same location the stock `uxc` uses). `path` is the OCI
bundle directory; everything else is optional and merged by uxcd into a generated
shadow OCI bundle at launch, so it survives an image update/re-pull.

- **`web.json`** - the minimum: a name, a bundle `path`, autostart + respawn.
- **`mqtt.json`** - a member of the shared `cntr` netns (see below); also the
  dependency referenced by `frigate.json` / `zigbee2mqtt.json`.
- **`frigate.json`** - the full set: `volumes` (`src:dst[:ro]` bind mounts),
  `devices` (a node or a directory; gets a device node **and** a cgroup
  device-allow rule, e.g. `/dev/dri` for the iGPU + a Coral), `env`, `resources`
  (OCI `linux.resources`), `depends_on` (started first, waited for) and a
  `healthcheck` (http + resource here; `tcp`/`exec` are also supported).
- **`jellyfin.json`** - hardware transcoding: `/dev/dri` passed through `devices`,
  a read-only media bind + config/cache, and an http healthcheck.
- **`zigbee2mqtt.json`** - a USB Zigbee coordinator passed through `devices`
  (use the stable `/dev/serial/by-id/...` path), `depends_on` the mqtt broker.
- **`homeassistant.json`** - **host network** (no `infra` -> shares the host
  stack, which HA's discovery often wants) + a USB radio. ⚠ On a router the host
  stack includes WAN; prefer an `infra` netns + firewalling, or run host-network
  apps on a non-router host.
- **`db.json`** - PostgreSQL: a data volume, the password in `env`, a tcp
  healthcheck, and a memory limit; pair it with an app over the `cntr` netns.
- **`nginx.json`** + **`php-fpm.json`** - a **web pod**: both on the `cntr` netns
  sharing a `/srv/www` webroot, nginx `depends_on` php-fpm and reaches it over
  `127.0.0.1:9000` (FastCGI). The two-container pattern for nginx+PHP apps.
- **`caddy.json`** - Caddy web server / reverse proxy: Caddyfile + a persisted
  `/data` (so it does not re-issue TLS certs) + `/config`; on the `cntr` netns it
  can reverse-proxy the other pod members.
- **`exim.json`** - an Exim MTA: config + spool volumes, tcp healthcheck on `:25`.
  ⚠ Receiving external mail means exposing `:25` - firewall it deliberately
  (route to the netns IP); for a smarthost/relay the netns alone is fine.
- **`vaultwarden.json`** - Vaultwarden (Bitwarden): a `/data` volume, an
  `ADMIN_TOKEN` in `env`, an http `/alive` healthcheck.

**Device passthrough** is the registry's job: list nodes in `devices` (each gets
the node **and** the cgroup device-allow rule). A converter `--profile` can tune
the bundle (caps/env/shm) but cannot grant device access - so devices live here.
**Bundle-level tweaks** (capabilities, shm, default mounts) come from `--profile`
at `uxc pull`/`build` time; this registry file is for runtime config
(volumes/devices/env/resources/healthcheck/depends_on/infra).

Install one with, e.g.:

```sh
cp /usr/share/uxcd/examples/etc/uxc/web.json /etc/uxc/web.json
$EDITOR /etc/uxc/web.json          # set the real bundle path etc.
uxc start web
```

## Shared container network (`etc/config/network.example`)

A `netns` interface that creates a persistent, named network namespace several
containers can share (reaching each other over `127.0.0.1`). Append it to
`/etc/config/network`, bring it up, then point containers at it with
`"infra": "cntr"`. The `luci-proto-netns` package renders this as a LuCI form.
