# Recipes: deploy a common container in one step

A **recipe** is a profile that also knows *where its container comes from*. One
command, or one click, does the whole sequence a container used to take by hand:

```sh
uxc recipes                       # what can be deployed
uxc deploy php-fpm                # build it, create /srv/php-fpm + the webroot,
                                  # seed the pool config, register volumes+health
uxc start php-fpm
```

LuCI: **Containers → Recipes**.

## Why this exists

Profiles have always described how to *run* an application — capabilities,
mounts, and the `_registry` half (volumes, devices, healthcheck). What they could
not say is where the image comes from. So every deployment still began with the
operator writing a `uxc pull` line or a Dockerfile, creating host directories
with the right owner, writing a config file, and editing
`/etc/uxc/<name>.json`. Rebuilding a box after a flash meant reconstructing all
of it from memory — a "20 minute" job that reliably becomes an afternoon.

A recipe is the same profile file plus a `_source` block. A profile *without*
`_source` is exactly what it always was, so this is **one mechanism with an
optional half**, not a second system beside profiles.

## Shipped recipes

| Recipe | Source | What it sets up |
|---|---|---|
| **caddy** | pull `caddy:2-alpine` | `/srv/caddy` + persistent ACME storage, a starting Caddyfile with a `/healthz` endpoint, volumes, http healthcheck, web-port links |
| **php-fpm** | **build** on `php:8.5-fpm-alpine` | gd (JPEG/PNG/WebP/FreeType), zip, intl, exif compiled in; webroot owned by 82:82; a pool override; `SIGQUIT` stop signal; exec healthcheck on `:9000` |
| **cron** | **build** on `alpine:3.24` | BusyBox `crond` in the foreground + PHP CLI, crontabs/scripts/state binds, an example job and a health-check script |

`caddy` + `php-fpm` + `cron` are the web-stack trio; deploy all three with the
same `--infra <netns>` (or none, for the host network) and they reach each other
over `127.0.0.1`.

The other files in the profile directory (`frigate`, `mosquitto`, `postgres`,
`mariadb`, `icecc`) are still overlay-only profiles — they have no `_source` yet,
so they apply at `uxc pull --profile <name>` time as before.

## Deploying

```sh
uxc deploy <recipe> [container] [options]
```

`container` defaults to the recipe name. The converter options (`--infra`,
`--autostart`, `--out`, `--caps`, `--arch`, ...) all apply, and anything you pass
**wins over the recipe** — an explicit `--infra cntr` or `--profile` is never
overridden.

A deploy:

1. creates the recipe's `_paths` host directories with their stated mode/owner,
2. pulls the image, or writes the recipe's Dockerfile to
   `<bundle_dir>/<name>.Dockerfile` and builds it,
3. writes the `_seed` config files — **only those that do not exist**,
4. registers `/etc/uxc/<container>.json`: bundle path, provenance, and the
   `_registry` keys the entry does not already have,
5. records which recipe deployed it (`"recipe"` in the entry).

Nothing is started: review the entry and the seeded config first, then
`uxc start <container>`.

**Deploying again is safe and idempotent.** The bundle is rebuilt; your edited
config files, your registry overrides and your data are left alone. That is what
makes a recipe a redeploy tool and not just a first-run installer.

## Upgrading a recipe container

A pulled container re-pulls its tag. A **built** container re-*builds* — see
[images.md § Update detection](images.md) — from the Dockerfile the deploy wrote,
on the current base image:

```sh
uxc upgrade php-fpm        # rebuild on the current php:8.5-fpm-alpine
```

Both go through the same health-gated safe-update: the old bundle is kept as
`.prev`, and if the new one does not become healthy inside the window it is
rolled back automatically.

The generated `<name>.Dockerfile` is **yours from then on**. Edit it (add an
extension, pin a package) and `uxc upgrade` rebuilds from your version;
`check_updates` notices the edit and reports a rebuild. Re-running `uxc deploy`
overwrites it with the recipe's version again.

## Writing a recipe

Start from an existing one (`profiles/php-fpm.json` is the most complete) or from
`profiles/_template.json`. Everything from
[the profile format](../docker2uxcd/profiles/README.md) applies; a recipe adds:

### `_source` — where the container comes from

Exactly one of `image` or `build`:

```jsonc
"_source": {
  "image": "caddy:2-alpine"
}
```

```jsonc
"_source": {
  "build": {
    "base": "php:8.5-fpm-alpine",
    "dockerfile": [
      "FROM ${base}",
      "RUN apk add --no-cache ..."
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `image` | the ref to pull. Prefer a major/minor tag over `:latest` so an upgrade is a deliberate move |
| `build.base` | the **tracked** base image. `check_updates` re-resolves this ref, and `${base}` in the Dockerfile expands to it — so the `FROM` line and the tracked ref cannot drift apart |
| `build.dockerfile` | the Dockerfile, as an array of lines (readable inside JSON) or one string. Plain, standard Dockerfile syntax — it builds with docker/podman too |
| `build.dockerfile_path` | instead of `dockerfile`: read the body from a file on the host, keeping a hand-maintained Dockerfile the single source of truth |
| `infra` | a default netns for the container (still overridable with `--infra`) |
| `autostart` | default autostart |

Only `${base}` is substituted. There is deliberately no templating language: a
recipe is a starting point to be edited on the box, not a program.

### `_paths` — host directories, with ownership

```jsonc
"_paths": [
  { "path": "/srv/php-fpm/conf", "mode": "0755" },
  { "path": "/srv/htdocs", "mode": "0755", "uid": 82, "gid": 82 }
]
```

A bare string (`"/srv/caddy/data"`) works too. uxcd already creates a missing
bind source at start — what it cannot know is that PHP-FPM's webroot must belong
to uid 82. Mode and owner are (re)applied on every deploy, so a redeploy onto
restored data repairs ownership; contents are never touched.

### `_seed` — starting configuration files

```jsonc
"_seed": {
  "/srv/caddy/Caddyfile": [ "# lines", "..." ],
  "/srv/cron/scripts/healthcheck": {
    "mode": "0755",
    "content": [ "#!/bin/sh", "..." ]
  }
}
```

A string, an array of lines, or `{ content, mode }` when the file must be
executable. **Never overwrites an existing file** — your edits survive every
deploy and upgrade. Write these as a working default with the site-specific
parts clearly marked `EDIT ME`.

### `_registry` — the uxcd half

Unchanged from profiles: `volumes`, `devices`, `healthcheck`, `web_ports`,
`respawn`, `stop_signal`, `notes`, `urls`, ... Written only for keys the entry
does not already have. Identity and provenance (`name`, `path`, `image`,
`digest`, `created`, `build`) can never come from a recipe.

Give every recipe a `healthcheck` — it is what makes the safe upgrade able to
verify a rebuild and roll a bad one back — and a `notes` line saying where the
config lives and what must be backed up.

## Where recipes live

The same directory the converter reads profiles from:
`/usr/share/docker2uxc/profiles`, overridable with `$DOCKER2UXC_PROFILES` (a dev
tree uses `profiles/` next to the binary). `uxc recipes` prints the resolved
path.

There is **no remote catalogue and no download**: recipes ship with the package
or you write them. A recipe runs `RUN` steps as root on your box, which is not
something to fetch from the internet on a whim.

## What this is not

- **Not a stack/compose runtime.** A recipe deploys one container. Several
  containers that belong together share an infra netns and use `depends_on` —
  see [networking.md](networking.md); `uxc compose` imports a compose file
  one-shot.
- **Not a package manager.** `apk add` inside a build is not reproducible: a
  rebuild may bring newer packages. That is usually the point (it *is* the
  update), and it is exactly why the health gate and `.prev` rollback are not
  optional for built containers.
- **Not a secrets store.** Put credentials in the registry entry's `env` /
  `env_file` (0600) after deploying, not in a shared recipe.
