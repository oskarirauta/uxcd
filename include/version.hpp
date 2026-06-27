#pragma once

// Shared package version for uxcd and its companion tools (uxexec, ...).
// Bump this single definition; everything built from this package reports it,
// so the binaries in one OpenWrt package never disagree on their version.
//
// 1.0.0: first stable release (feature set frozen). Bump on each release.
#define UXCD_VERSION "1.0.0"
