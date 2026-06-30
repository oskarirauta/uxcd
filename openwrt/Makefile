include $(TOPDIR)/rules.mk

PKG_NAME:=uxcd
PKG_VERSION:=2.0.0
PKG_RELEASE:=1

# The release tarball is built recursively (submodules included) by the repo's
# release workflow, so it carries the vendored C++ libraries and docker2uxcd.
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://github.com/oskarirauta/$(PKG_NAME)/releases/download/$(PKG_VERSION)/
PKG_HASH:=skip

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Oskari Rauta <oskari.rauta@gmail.com>

include $(INCLUDE_DIR)/package.mk

define Package/uxcd
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Containers
  TITLE:=Container supervisor for OpenWrt (uxc alternative)
  URL:=https://github.com/oskarirauta/uxcd
  # libstdcpp: uxcd/uxc/uxe are C++ (g++), so they link libstdc++.so. uxcd and
  # uxc now link the docker2uxc converter directly (uxc pull/build call it after
  # fork - no exec, no separate package), which pulls in libcurl + the
  # compression libs and the CA store for registry HTTPS.
  DEPENDS:=+libubox +libubus +libblobmsg-json +libstdcpp +libcurl +zlib +libzstd +liblzma +ca-bundle
  CONFLICTS:=uxc
endef

define Package/uxcd/description
  uxcd is a small supervisor daemon for OpenWrt containers and a drop-in-style
  replacement for the stock uxc: it owns the container lifecycle (launches ujail
  itself) with intent-aware restart and crash backoff, re-adopts containers
  across a uxcd restart, captures logs, runs tcp/http/resource/exec healthchecks,
  emits ubus events, and supports host / isolated / shared-netns (infra)
  networking plus per-container volumes/devices/env/resources kept in the
  registry (so they survive image updates).

  Ships three programs - uxcd (daemon), uxc (CLI) and uxe (exec/shell) - and the
  netifd "netns" protocol. `uxc pull` (fetch a registry image) and `uxc build`
  (build from a Dockerfile, no Docker daemon) are built in: the converter is
  linked into uxcd/uxc, so no separate package is required.
endef

# /etc/config/uxcd is preserved across sysupgrade.
define Package/uxcd/conffiles
/etc/config/uxcd
endef

define Build/Configure
endef

define Build/Compile
	$(MAKE) -C $(PKG_BUILD_DIR) \
		CXX="$(TARGET_CXX)" \
		CXXFLAGS="$(TARGET_CXXFLAGS) $(TARGET_CPPFLAGS) --std=c++17 -fPIC" \
		LDFLAGS="$(TARGET_LDFLAGS)"
	# the standalone docker2uxcd CLI (optional package) - same converter sources
	# built as a separate binary for terminal use with the full flag set
	$(MAKE) -C $(PKG_BUILD_DIR)/docker2uxcd \
		CXX="$(TARGET_CXX)" \
		CXXFLAGS="$(TARGET_CXXFLAGS) $(TARGET_CPPFLAGS) --std=c++17 -fPIC" \
		LDFLAGS="$(TARGET_LDFLAGS)"
	# cntrinit (optional package): a fully-STATIC C PID-1 init. Pass only CC +
	# CFLAGS (for the cross toolchain + sysroot); its own STATIC_LDFLAGS keeps the
	# -static link and its `override CFLAGS += -D_GNU_SOURCE` survives this CFLAGS.
	$(MAKE) -C $(PKG_BUILD_DIR)/cntrinit \
		CC="$(TARGET_CC)" \
		CFLAGS="$(TARGET_CFLAGS)"
endef

define Package/uxcd/install
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/sbin $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/uxcd $(1)/usr/sbin/uxcd
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/uxc  $(1)/sbin/uxc
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/uxe  $(1)/usr/bin/uxe

	$(INSTALL_DIR) $(1)/lib/netifd/proto
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/netifd/netns.sh $(1)/lib/netifd/proto/netns.sh

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/uxcd.init $(1)/etc/init.d/uxcd

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/uxcd.config $(1)/etc/config/uxcd

	# Prometheus metrics endpoint (served by uhttpd at /cgi-bin/uxcd-metrics)
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/uxcd-metrics $(1)/www/cgi-bin/uxcd-metrics

	# bundled docker2uxc profiles, so `uxc pull --profile <name>` finds them
	# without the optional standalone docker2uxcd package
	$(INSTALL_DIR) $(1)/usr/share/docker2uxc/profiles
	$(CP) $(PKG_BUILD_DIR)/docker2uxcd/profiles/. $(1)/usr/share/docker2uxc/profiles/

	# preserve the container registry (/etc/uxc) across sysupgrade
	# (/etc/config/uxcd is kept automatically); bundles are regenerable.
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/uxcd.keep $(1)/lib/upgrade/keep.d/uxcd
endef

define Package/luci-proto-netns
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Support for the uxcd netns protocol
  DEPENDS:=+luci-base +uxcd
  PKGARCH:=all
endef

define Package/luci-proto-netns/description
  LuCI protocol handler that adds the uxcd "netns" shared-namespace network
  protocol to the LuCI interface configuration, rendering its options as form
  fields (address/netmask/gateway/dns on General; name/device/peer on Advanced).
endef

define Package/luci-proto-netns/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/protocol
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/proto-netns/netns.js $(1)/www/luci-static/resources/protocol/netns.js
endef

define Package/luci-app-uxcd
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Container management UI for uxcd
  DEPENDS:=+luci-base +uxcd
  # uxcd replaces uxc (uxcd CONFLICTS:=uxc), so their LuCI front-ends must not
  # coexist either - both drive container management and would clash.
  CONFLICTS:=luci-app-uxc
  PKGARCH:=all
endef

define Package/luci-app-uxcd/description
  LuCI web interface for uxcd: a "Containers" tab listing every supervised
  container with live state/health/memory/cpu, start/stop/restart buttons and a
  per-container detail + log view, plus a compact "remote control" widget on the
  Status overview page. It talks to the uxcd ubus object over rpcd (polling) and
  ships an rpcd ACL granting the LuCI user the needed uxcd ubus methods.
endef

define Package/luci-app-uxcd/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/uxcd
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/status/include
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/uxcd.js \
		$(1)/www/luci-static/resources/uxcd.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/uxcd/overview.js \
		$(1)/www/luci-static/resources/view/uxcd/overview.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/uxcd/activity.js \
		$(1)/www/luci-static/resources/view/uxcd/activity.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/uxcd/storage.js \
		$(1)/www/luci-static/resources/view/uxcd/storage.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/uxcd/settings.js \
		$(1)/www/luci-static/resources/view/uxcd/settings.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/uxcd/registries.js \
		$(1)/www/luci-static/resources/view/uxcd/registries.js
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/status/include/30_containers.js \
		$(1)/www/luci-static/resources/view/status/include/30_containers.js

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/root/usr/share/luci/menu.d/luci-app-uxcd.json \
		$(1)/usr/share/luci/menu.d/luci-app-uxcd.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/root/usr/share/rpcd/acl.d/luci-app-uxcd.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-uxcd.json
endef

define Package/uxcd-console
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Containers
  TITLE:=Browser console for uxcd (opt-in, UNAUTHENTICATED)
  URL:=https://github.com/oskarirauta/uxcd
  DEPENDS:=+uxcd +luci-app-uxcd +ttyd
  PKGARCH:=all
endef

define Package/uxcd-console/description
  Opt-in in-browser container terminal for uxcd. Installing it shows a "Console"
  button in the LuCI app that opens a per-container shell served by ttyd over TLS
  (reusing the LuCI certificate, so the browser already trusts it) inside a modal.
  The console is UNAUTHENTICATED: anyone who can reach the random TLS port during
  the short one-shot window gets a root shell in the container. It is therefore a
  SEPARATE package so the risk is opt-in - do NOT install on a WAN-exposed or
  untrusted-LAN router. Installing sets uxcd 'console_enabled'; removing clears it.
endef

define Package/uxcd-console/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/openwrt/files/uxcd-console.defaults \
		$(1)/etc/uci-defaults/99-uxcd-console
endef

define Package/uxcd-console/prerm
#!/bin/sh
[ -n "$$$$IPKG_INSTROOT" ] || { uci -q set uxcd.main.console_enabled='0'; uci -q commit uxcd; }
exit 0
endef

define Package/docker2uxcd
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Containers
  TITLE:=Image converter / Dockerfile builder for uxcd
  URL:=https://github.com/oskarirauta/docker2uxc
  # The C++ converter links libcurl (registry HTTP) + the compression libs and
  # needs ca-bundle (cert store for registry HTTPS); JSON, tar and sha256 are
  # built in (no jq/wget), chroot/mount (Dockerfile builds) come from busybox.
  # Optional: uxcd/uxc already include this converter - install this only for the
  # standalone command with the full flag set (--profile, --caps, ...).
  DEPENDS:=+uxcd +libstdcpp +libcurl +zlib +libzstd +liblzma +ca-bundle
  PKGARCH:=all
endef

define Package/docker2uxcd/description
  The standalone docker2uxc CLI (C++): fetches and converts an OCI/registry
  image (or builds one from a Dockerfile, single-stage, host architecture, no
  Docker daemon) into a uxc OCI bundle and registers it with uxcd. uxcd and uxc
  already link this converter (uxc pull/build need nothing extra); install this
  package only for the standalone command with the full flag set (--profile,
  --caps, --network, --emit-keeper, ...).
endef

define Package/docker2uxcd/install
	# just the standalone binary - the profiles ship with the uxcd package now
	# (uxc pull/build use them), so they are not installed twice (opkg conflict)
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/docker2uxcd/docker2uxc $(1)/usr/bin/docker2uxcd
endef

define Package/uxcd-examples
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Containers
  TITLE:=Example container + network configs for uxcd
  URL:=https://github.com/oskarirauta/uxcd
  DEPENDS:=+uxcd
  PKGARCH:=all
endef

define Package/uxcd-examples/description
  Sample, ready-to-adapt configurations for uxcd installed under
  /usr/share/uxcd/examples (NOT into /etc, so nothing is auto-registered):
  per-container /etc/uxc/<name>.json examples covering volumes, devices, env,
  resources, depends_on and healthchecks, plus an /etc/config/network snippet
  for a shared "netns" container network namespace. Copy what you need.
endef

define Package/uxcd-examples/install
	$(INSTALL_DIR) $(1)/usr/share/uxcd/examples
	$(CP) $(PKG_BUILD_DIR)/examples/. $(1)/usr/share/uxcd/examples/
endef

define Package/cntrinit
  SECTION:=utils
  CATEGORY:=Utilities
  SUBMENU:=Containers
  TITLE:=Minimal static PID 1 init for containers
  URL:=https://github.com/oskarirauta/cntrinit
  # Fully static, NO runtime dependencies on purpose - an init you can drop into
  # any bundle's rootfs (scratch included). Hence no DEPENDS and no +libc.
  DEPENDS:=
endef

define Package/cntrinit/description
  cntrinit is a tiny PID 1 / init for containers (tini/catatonit-like): it
  launches the container's process, forwards signals, reaps zombie/orphaned
  processes and propagates the child's exit status - or runs childless as the
  init of an infra / pause container. Built fully static with no runtime
  dependencies, so the binary can be copied into any container rootfs. Optional
  companion to uxcd: run a container's command under cntrinit when the image
  ships no init, or use it as the infra-netns init.
endef

define Package/cntrinit/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/cntrinit/cntrinit $(1)/usr/bin/cntrinit
endef

$(eval $(call BuildPackage,uxcd))
$(eval $(call BuildPackage,docker2uxcd))
$(eval $(call BuildPackage,cntrinit))
$(eval $(call BuildPackage,uxcd-examples))
$(eval $(call BuildPackage,luci-proto-netns))
$(eval $(call BuildPackage,luci-app-uxcd))
$(eval $(call BuildPackage,uxcd-console))
