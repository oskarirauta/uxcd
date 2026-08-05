# Running Frigate under uxcd

[Frigate] is the container this project was born for, and it makes the best
worked example: big image, slow boot, hardware devices, persistent config and
media — every maintenance concern a container can have. Set it up as below and
**staying current is one command**. The same pattern applies to any container.

## The golden rule

**Everything of yours lives in the registry (`/etc/uxc/frigate.json`), never in
the bundle.** The bundle (image + generated `config.json`) is replaceable — an
upgrade re-pulls and regenerates it, and anything hand-edited into it is gone.
Registry overrides are merged into a fresh shadow bundle at every start, so they
survive every upgrade. (If you *have* hand-edited binds in an old bundle, just
add the equivalent `volumes`/`devices` to the registry — the registry entry
replaces a same-destination bundle mount, so the migration is safe.)

## Setup

```sh
uxc pull ghcr.io/blakeblackshear/frigate:0.17.2 frigate --out /srv/uxc/frigate
```

Then the overrides — LuCI's per-container editor, or by hand:

```json
{
  "name": "frigate", "path": "/srv/uxc/frigate", "autostart": true,
  "volumes": [
    "/srv/frigate/config:/config",
    "/srv/media:/media"
  ],
  "devices": [ "/dev/dri" ],
  "shm_size": "256m",
  "env": [ "TZ=Europe/Helsinki" ],
  "healthcheck": {
    "interval": 30, "retries": 3, "start_period": 120,
    "checks": [ { "type": "http", "target": "127.0.0.1:5000/api/version" } ]
  }
}
```

- `volumes` — config and recordings on the host (on storage with room; the
  bundle itself is ~5 GB and an upgrade transiently holds two of them plus the
  `.prev` backup).
- `devices: ["/dev/dri"]` — VA-API hardware acceleration; the directory is
  bind-mounted live and cgroup-allowed.
- **Coral TPU**: USB Coral → add `"/dev/bus/usb"` to `devices` (a live bind, so
  the Coral surviving its own re-enumeration when the delegate loads Just
  Works); PCIe Coral → add `"/dev/apex_0"`.
- Worth considering: `"swap_max": "0"` (keep detection latency out of swap) and
  `"oom_score_adj": -500` (sacrifice other containers before the NVR).
- `start_period: 120` — Frigate boots slowly (model load, migrations on a new
  version); failing probes inside this startup grace don't count as unhealthy,
  and the safe-update window extends by it.
- The healthcheck is what makes upgrades *safe* — without one, an upgrade is a
  blind restart.

## Updating

- **Same tag moved** (e.g. tracking `stable`): the scheduled/on-demand update
  check flags it; press **Upgrade** in LuCI or run `uxc upgrade frigate`. Set
  `"auto_upgrade": true` to let the scheduled check do it hands-free.
- **New version** (`0.17.2` → `0.18.0`): the update check spots newer version
  tags too (a beta only when nothing stable is newer) — the container view then
  shows a **New version** row and an **Upgrade to 0.18.0** button. Or by hand:

  ```sh
  uxc upgrade frigate --image ghcr.io/blakeblackshear/frigate:0.18.0
  ```

That's the whole procedure, either way: uxcd pulls, keeps the old bundle as
`.prev`, restarts with your registry overrides intact, and watches the
healthcheck for `safe_update_window` + `start_period` seconds. Healthy →
`last_update: verified`, done. Not healthy → **automatic rollback** to the old
version (bundle *and* recorded provenance, so the update is offered again) —
your cameras come back on the old release and you read the log at leisure.
Manual escape hatch at any time: `uxc rollback frigate`.

This exact flow — including a broken candidate being rolled back automatically,
then a fixed one verifying healthy — is how the feature was tested against a
real Frigate 0.18 beta.

[Frigate]: https://frigate.video
