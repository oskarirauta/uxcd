#pragma once

// Shared package version for uxcd and its companion tools (uxexec, ...).
// Bump this single definition; everything built from this package reports it,
// so the binaries in one OpenWrt package never disagree on their version.
//
// 2.0.0: v2 - settings editor, caps/seccomp, pull/build jobs, image prune,
// Prometheus metrics, container env inheritance. Bump on each release.
// 3.0.0: v3 - image provenance + update detection + health-gated safe-upgrade,
// private registries, scheduling, netns IPv6, multi-stage builds, the
// self-describing ubus-api contract, LuCI polish, and a pre-release
// robustness/security audit pass.
// 3.1.0: dev containers (--dev: idle cntrinit init + writable persistent
// overlay), version jumps (upgrade --image, CLI/ubus/LuCI), and safe-update
// fixes proven against a live Frigate 0.18 upgrade (start_period-aware
// window, provenance-restoring rollback, shadow-merge mount dedup).
// 3.2.0: cancel-safe pulls + truthful rollback (provenance swaps with the
// bundle), upgrade locking, new-version tag detection with one-click jumps,
// per-container notes/links, swap_max + oom_score_adj, live-bind device
// directories (USB/PCIe Coral), and the "New container" wizard (a generated
// Dockerfile recipe) unifying all four creation paths in LuCI.
// 3.3.0: profiles that configure the whole container (capabilities added not
// replaced, a _registry half seeding devices/volumes/shm/healthcheck, optional
// mounts, seeded config files) with `uxc profiles` and a self-explaining LuCI
// picker; pulls that measure the image against free space and refuse or abort
// before filling a filesystem; --out defaulting to the configured bundle_dir.
// 3.3.1: `uxc doctor` / LuCI "Check" - a read-only pre-flight of the merged OCI
// spec (missing binds, duplicate mounts, narrowed caps, devices, netns, disk);
// profiles declare the images they are for and get suggested/preselected; and
// resources memory/pids/cpu limits are written to the cgroup, because ujail
// never applied linux.resources at all.
// 3.3.2: fix the disk guard refusing every pull when the blob cache directory
// does not exist yet (it lives in /tmp, so this hit after every reboot):
// unmeasurable now means unknown, not full. Removing a container also drops
// its .json.bak.
// 3.3.3: bind the container's own cgroup read-only at /sys/fs/cgroup, so what
// runs inside can read the limits set for it (Frigate's nginx was sizing its
// worker pool from the whole host because the directory was empty).
// 3.3.4: name a depends_on cycle instead of sitting in it - the members used to
// wait on each other for the whole start_timeout and then fail-open silently;
// now the loop is logged, broken immediately, and reported by `uxc doctor`
// (which also flags a dependency that does not exist or names itself).
// 3.5.0: recipes - a profile carrying a _source block deploys itself, so one
// step (`uxc deploy caddy`, ubus deploy, LuCI Recipes) pulls or builds the
// image, creates its host directories with the ownership the service expects,
// seeds its config files and registers its volumes + healthcheck; idempotent,
// so it is the redeploy tool after a flash too. Underneath it, build
// provenance: a Dockerfile-built container records its base ref + digest and
// its Dockerfile + sha256, so check_updates follows the BASE (or a recipe
// edited on the box) and reports a rebuild, and `uxc upgrade` re-BUILDS through
// the same health gate and .prev rollback - a built rootfs can no longer be
// replaced by a pull of the stock image, which used to discard its compiled
// extensions silently. Ships the caddy, php-fpm and cron recipes.
#define UXCD_VERSION "3.5.0"
