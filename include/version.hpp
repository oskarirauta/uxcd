#pragma once

// Shared package version for uxcd and its companion tools (uxexec, ...).
// Bump this single definition; everything built from this package reports it,
// so the binaries in one OpenWrt package never disagree on their version.
//
// Stays at 0.x until the feature set is frozen for the 1.0.0 release.
#define UXCD_VERSION "0.99.0"
