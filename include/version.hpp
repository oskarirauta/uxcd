#pragma once

// Shared package version for uxcd and its companion tools (uxexec, ...).
// Bump this single definition; everything built from this package reports it,
// so the binaries in one OpenWrt package never disagree on their version.
//
// 2.0.0: v2 - settings editor, caps/seccomp, pull/build jobs, image prune,
// Prometheus metrics, container env inheritance. Bump on each release.
#define UXCD_VERSION "2.0.0"
