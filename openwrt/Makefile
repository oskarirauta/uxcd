include $(TOPDIR)/rules.mk

PKG_NAME:=uxcd
PKG_VERSION:=0.99.0
PKG_RELEASE:=1

# The release tarball is built recursively (submodules included) by the repo's
# release workflow, so it carries the vendored C++ libraries and docker2uxcd.
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://github.com/oskarirauta/$(PKG_NAME)/releases/download/$(PKG_VERSION)/
PKG_HASH:=skip

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Oskari Rauta <oskari.rauta@gmail.com>

PKG_BUILD_DEPENDS:=libubox libubus

include $(INCLUDE_DIR)/package.mk

define Package/uxcd
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Container supervisor for OpenWrt (uxc alternative)
  URL:=https://github.com/oskarirauta/uxcd
  # libubox/libubus/libblobmsg-json: the daemon + CLIs. jq + a TLS fetcher
  # (uclient-fetch+mbedtls, here pulled via libustream-mbedtls) + ca-bundle:
  # docker2uxcd's registry pull / Dockerfile build (RUN, COPY).
  DEPENDS:=+libubox +libubus +libblobmsg-json +jq +libustream-mbedtls +ca-bundle
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

  Ships three programs - uxcd (daemon), uxc (CLI) and uxe (exec/shell) - the
  netifd "netns" protocol, and the docker2uxcd converter for `uxc pull` (fetch a
  registry image) and `uxc build` (build from a Dockerfile, no Docker daemon).
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

	# docker2uxcd converter (for `uxc pull` / `uxc build`) + its profiles
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/docker2uxcd/docker2uxc $(1)/usr/bin/docker2uxcd
	$(INSTALL_DIR) $(1)/usr/share/docker2uxc/profiles
	$(CP) $(PKG_BUILD_DIR)/docker2uxcd/profiles/. $(1)/usr/share/docker2uxc/profiles/ 2>/dev/null || true
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
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/htdocs/luci-static/resources/view/status/include/30_containers.js \
		$(1)/www/luci-static/resources/view/status/include/30_containers.js

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/root/usr/share/luci/menu.d/luci-app-uxcd.json \
		$(1)/usr/share/luci/menu.d/luci-app-uxcd.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/luci/app-uxcd/root/usr/share/rpcd/acl.d/luci-app-uxcd.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-uxcd.json
endef

$(eval $(call BuildPackage,uxcd))
$(eval $(call BuildPackage,luci-proto-netns))
$(eval $(call BuildPackage,luci-app-uxcd))
