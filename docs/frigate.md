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
uxc pull --profile frigate ghcr.io/blakeblackshear/frigate:0.17.2 frigate \
         --out /srv/uxc/frigate
```

The **profile** is doing the work here. It sets the things Frigate cannot start
without and that nothing else can infer:

| The profile sets | Why |
|------------------|-----|
| `_caps_add: CAP_SYS_ADMIN, CAP_PERFMON` | Frigate's s6 init chowns `/dev/shm/logs` and remounts things. Anything less than the full default set **plus** these dies at startup with *Operation not permitted*. `CAP_PERFMON` is also what makes the statistics page work |
| `shm_size: 1280m` | Frigate sizes `/dev/shm` by camera count and resolution and refuses to start when it is too small — **it logs the exact figure it wants**, so raise this if the log asks |
| `devices: /dev/dri, /dev/bus/usb, /dev/apex_0` | VA-API, USB Coral, PCIe Coral. Devices the box does not have are skipped |
| `/tmp` sized at 1 GB | model and clip scratch; the default tmpfs is unbounded, and it is RAM |
| an HTTP healthcheck on `:5000/api/version` with `start_period: 120` | this is what makes an upgrade *safe* instead of a blind restart — Frigate boots slowly, and probes inside the grace period do not count against it |
| `web_ports: 5000, scheme http` | the click-through icon in the overview. The scheme is stated explicitly because a browser on an https LuCI page will otherwise try to upgrade the link |
| `env: TZ, FRIGATE_RTSP_PASSWORD` | **change both.** `TZ` is what puts recordings and the timeline in your local time; `FRIGATE_RTSP_PASSWORD` is what `{FRIGATE_RTSP_PASSWORD}` in `config.yml` expands to |
| `volumes: /srv/frigate/config:/config`, `/srv/frigate/media:/media` | **edit these** to your layout before the first start |

The pull prints what it set, and warns about any host path that does not exist
yet. Then edit the rest in LuCI's per-container editor, or by hand:

```json
{
  "name": "frigate", "path": "/srv/uxc/frigate", "autostart": true,
  "volumes": [
    "/srv/frigate/config:/config",
    "/media/media:/media"
  ],
  "devices": [ "/dev/dri", "/dev/bus/usb" ],
  "shm_size": "1280m",
  "env": [ "TZ=Europe/Helsinki", "FRIGATE_RTSP_PASSWORD=..." ],
  "healthcheck": {
    "interval": 30, "retries": 3, "start_period": 120,
    "checks": [ { "type": "http", "target": "127.0.0.1:5000/api/version" } ]
  }
}
```

- `volumes` — config and recordings on the host, on storage with room: the
  bundle alone is a few GB and an upgrade transiently holds two of them plus the
  `.prev` backup. `/media` in particular wants your biggest partition.
- **Coral TPU**: a USB Coral needs the whole `/dev/bus/usb` bus, not one node —
  the TPU re-enumerates itself when its delegate uploads firmware, and a live
  bind of the directory (which is how uxcd passes device directories) follows it.
  A PCIe/M.2 Coral is the single node `/dev/apex_0`.
- Worth considering: `"swap_max": "0"` (keep detection latency out of swap) and
  `"oom_score_adj": -500` (sacrifice other containers before the NVR).

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

## If it will not start

- **`Operation not permitted` around `/dev/shm/logs`** — the capability set is
  too narrow. Use `--profile frigate`; if you wrote your own profile, add
  capabilities with `_caps_add`, never by writing `process.capabilities` (that
  *replaces* the set and quietly drops `CAP_CHOWN`).
- **Frigate complains about shared memory** — it prints the size it needs. Put
  that in `shm_size`.
- **`parsing of OCI JSON spec has failed`** — two mounts on one destination.
  Registry `volumes`/`devices`/`shm_size` replace a same-destination bundle
  mount, so prefer them over hand-edited binds.
- **The web icon opens https and fails** — set `scheme: http` on the port in
  Configure → Web UI.
- **`cpu.cfs_quota_us not found. Falling back to /proc/cpuinfo`** — harmless in
  itself (Frigate only sizes nginx's workers with it), and it goes away on its
  own: uxcd binds the container's cgroup read-only at `/sys/fs/cgroup`, so a
  CPU limit is visible from inside. The message names cgroup **v1** paths,
  which no longer exist on a v2 host; Frigate falls back correctly either way.
- **The pull ran the box out of space** — put the bundle somewhere with room
  (`--out`, or the `bundle_dir` setting) and the blob cache on disk rather than
  in RAM (`cache_dir`). A pull now refuses up front when it will not fit; see
  [images.md](images.md#running-out-of-space).

[Frigate]: https://frigate.video
