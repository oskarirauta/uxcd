all: world

CXX?=g++
CXXFLAGS?=--std=c++17 -Wall -fPIC
# -MMD -MP: emit a .d per object so a changed HEADER rebuilds what includes it.
# Without this a struct that grows a field (e.g. emit::ProfileInfo) is compiled
# with two different layouts into two objects, and the link succeeds - the crash
# comes later, somewhere else entirely.
CXXFLAGS += -MMD -MP
LDFLAGS?=-L/lib -L/usr/lib

OBJS:= \
	objs/config.o \
	objs/container.o \
	objs/main.o

# dependency trees: ubus_cpp -> json_cpp, logger_cpp -> common -> rva/tsl
JSON_DIR:=ubus_cpp/json
UBUSCPP_DIR:=ubus_cpp
COMMON_DIR:=common_cpp
LOGGER_DIR:=logger_cpp
SIGNAL_DIR:=SIG_cpp
USAGECPP_DIR:=usage_cpp
UCI_DIR:=uci_cpp
DOCKER2UXC_DIR:=docker2uxcd

include ubus_cpp/json/Makefile.inc
include ubus_cpp/Makefile.inc
include common_cpp/Makefile.inc
include logger_cpp/Makefile.inc
include SIG_cpp/Makefile.inc
include usage_cpp/Makefile.inc
include uci_cpp/Makefile.inc
include docker2uxcd/Makefile.inc

INCLUDES += -Iinclude

# shared dependency objects, reused by both binaries
LIBOBJS:= $(JSON_OBJS) $(UBUS_OBJS) $(COMMON_OBJS) $(LOGGER_OBJS) $(SIGNAL_OBJS) $(USAGE_OBJS) $(UCI_OBJS)

# the docker2uxc converter, linked into uxcd + uxc so they drive a pull/build by
# calling docker2uxc::convert() after fork() instead of exec'ing a separate tool
D2U_LIBS:= -lcurl -lz -lzstd -llzma

world: uxcd uxe uxc

-include $(wildcard objs/*.d)

$(shell mkdir -p objs)

objs/main.o: src/main.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/config.o: src/config.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/container.o: src/container.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/uxe.o: src/uxe.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/uxc.o: src/uxc.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/compose.o: src/compose.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

# libraries go AFTER the objects (needed by --as-needed toolchains like Alpine)
uxcd: $(LIBOBJS) $(DOCKER2UXC_OBJS) $(OBJS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) $(D2U_LIBS) -o $@;

uxe: $(LIBOBJS) objs/uxe.o
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@;

uxc: $(LIBOBJS) $(DOCKER2UXC_OBJS) objs/compose.o objs/uxc.o
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) $(D2U_LIBS) -o $@;

.PHONY: install
install: uxcd uxe uxc
	install -D -m 0755 uxcd $(DESTDIR)/usr/sbin/uxcd
	install -D -m 0755 uxe $(DESTDIR)/usr/bin/uxe
	install -D -m 0755 uxc $(DESTDIR)/sbin/uxc
	install -D -m 0755 uxcd-metrics $(DESTDIR)/www/cgi-bin/uxcd-metrics
	install -D -m 0755 uxcd.init $(DESTDIR)/etc/init.d/uxcd
	install -D -m 0755 netifd/netns.sh $(DESTDIR)/lib/netifd/proto/netns.sh
	install -D -m 0644 uxcd.keep $(DESTDIR)/lib/upgrade/keep.d/uxcd
	# The docker2uxc profiles AND recipes: without these `uxc profiles` is empty
	# and `uxc deploy` has nothing to deploy, so a from-source install would be
	# missing the whole recipe feature. Same set the OpenWrt package ships.
	install -d -m 0755 $(DESTDIR)/usr/share/docker2uxc/profiles
	install -m 0644 $(DOCKER2UXC_DIR)/profiles/README.md $(DOCKER2UXC_DIR)/profiles/*.json \
		$(DESTDIR)/usr/share/docker2uxc/profiles/
	[ -f $(DESTDIR)/etc/config/uxcd ] || install -D -m 0644 uxcd.config $(DESTDIR)/etc/config/uxcd

.PHONY: clean
clean:
	@rm -rf objs uxcd uxe uxc
