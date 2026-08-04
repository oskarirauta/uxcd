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
#define UXCD_VERSION "3.1.0"
