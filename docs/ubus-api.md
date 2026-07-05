# ubus API contract

[`docs/ubus.md`](ubus.md) is the how-to — every method with a `ubus call` example.
This file is the **contract**: the self-describing `api` method, the versioning
rules, the feature flags, and the committed JSON schema
([`ubus-api.schema.json`](ubus-api.schema.json)) that pins the response shapes a
client can rely on — so a field rename can't silently break the LuCI app or a
script.

## The `api` method

```sh
ubus call uxcd api
```

Returns:

- **`daemon_version`** — the uxcd software version (`UXCD_VERSION`).
- **`api_version`** — the wire-contract version (integer). Bumped only on a
  breaking change (see [Versioning](#versioning)).
- **`methods`** — every registered method mapped to its parameter type hints.
  Generated from the *same* table that is served, so the advertised list can
  never drift from what actually answers.
- **`features`** — capability flags a client keys on.

```json
{
  "daemon_version": "2.0.0",
  "api_version": 1,
  "methods": {
    "info": { "name": "string" },
    "pull": { "image": "string", "name": "string", "autostart": "bool", "infra": "string", "profile": "string" },
    "...": {}
  },
  "features": [ "multi_stage", "ipv6", "safe_update", "..." ]
}
```

A client should read `api` once at startup: check `api_version`, confirm the
methods it needs exist, and gate optional UI on `features` — not on the software
version.

## Versioning

- **`daemon_version`** is the software release; it changes every release.
- **`api_version`** is the wire contract. It stays stable across releases that
  only *add* methods or fields (backward-compatible), and is incremented only
  when an existing method/field is **removed**, renamed, or changes type/meaning.
- Parameter types in `methods` are one of:
  `string`, `int`, `float`, `bool`, `object`, `array`, `null`.

## Feature flags

| flag | meaning |
|------|---------|
| `multi_stage` | multi-stage Dockerfile builds (`FROM … AS`, `COPY --from=`) |
| `ipv6` | opt-in IPv6 in the `netns` proto |
| `safe_update` | health-gated upgrade with automatic rollback |
| `metrics` | Prometheus metrics endpoint |
| `profiles` | profile overlays (`profiles/<name>.json`) applied at pull/build |
| `read_only_rootfs` | read-only container rootfs with tmpfs writables |
| `compose` | one-shot `compose` import |
| `schedule` | cron-scheduled per-container actions |
| `health` | healthchecks (tcp / http / resource / exec) |
| `exec` | in-container command execution |
| `console` | in-browser shell (ttyd) |
| `events` | daemon event timeline |
| `registries` | private / authenticated registry credentials |

New flags may be added over time; treat an absent flag as "not supported".

## Data shapes

The committed schema [`ubus-api.schema.json`](ubus-api.schema.json) (JSON Schema
draft-07) defines the reusable object shapes under `definitions`; the methods
compose them:

- **`container`** — one entry from `list` (summary) or `info` (full). The `list`
  response is an object **keyed by container name** (like `job_list` is keyed by
  job id), so the per-entry objects don't repeat the name — only `info` sets a
  `name` field, which is why `name` is *not* in the definition's `required`. Key
  fields: `running`, `desired`, `image`, `health`, `uptime`, `memory`,
  `cpu_usec`, `pids`, `infra`, `web_ports`, `update_available`, `config_changed`.
  `info` adds the config-derived detail (caps, seccomp, mounts, devices,
  resources, healthcheck, schedules, network addresses, …).
- **`event`** — one entry from `events`, and the payload broadcast on the
  `uxcd.container` ubus event: `event`, `name`, `ts`, plus `health` / `running`
  and, on `exited`, the exit reason (`oom` / `signal` / `exit_code`).
- **`job`** — a pull / build / upgrade job from `job_list` / `job_status`.
- **`web_port`** — a served web interface (`port`, `label`, `scheme`, `path`).

Objects are `additionalProperties: true`: the documented fields are the contract;
new fields may appear and must not break a validating client.

### Validating

Any JSON Schema (draft-07) validator works. For example, to validate an `api`
response against the schema's `api` definition:

```sh
ubus call uxcd api > api.json
# e.g. with python's jsonschema, or ajv/check-jsonschema:
jsonschema -i api.json <(jq '. + {"$ref":"#/definitions/api"}' docs/ubus-api.schema.json)
```

## Events & metrics

Two data streams live *outside* the request/response methods:

- **Events** — container state changes are broadcast on the **`uxcd.container`**
  ubus event; subscribe with `ubus subscribe uxcd.container` (or the C++
  `ubus_cpp` `subscribe()` helper). The payload is an `event` object. Because a
  browser cannot subscribe to ubus, the LuCI app instead polls `uxcd.events`,
  which returns the recent in-memory timeline (`{"limit": <n>}`); it resets when
  uxcd restarts.
- **Metrics** — a Prometheus text endpoint at **`/cgi-bin/uxcd-metrics`** (served
  by uhttpd; localhost-only by default, see *Settings → Metrics*). It is *not*
  part of the ubus object. See [`docs/metrics.md`](metrics.md).

## Per-method reference

For each method's arguments and a runnable `ubus call` example, see
[`docs/ubus.md`](ubus.md). The `api` method's `methods` map is the
machine-readable version of the same list.
