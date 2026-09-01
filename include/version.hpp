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
#define UXCD_VERSION "3.3.0"
