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
  dependency referenced by `frigate.json`.
- **`frigate.json`** - the full set: `volumes` (`src:dst[:ro]` bind mounts),
  `devices` (a node or a directory; gets a device node **and** a cgroup
  device-allow rule, e.g. `/dev/dri`), `env`, `resources` (OCI
  `linux.resources`), `depends_on` (started first, waited for) and a
  `healthcheck` (http + resource here; `tcp`/`exec` are also supported).

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
