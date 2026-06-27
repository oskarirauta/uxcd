all: world

CXX?=g++
CXXFLAGS?=--std=c++17 -Wall -fPIC
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

include ubus_cpp/json/Makefile.inc
include ubus_cpp/Makefile.inc
include common_cpp/Makefile.inc
include logger_cpp/Makefile.inc
include SIG_cpp/Makefile.inc
include usage_cpp/Makefile.inc
include uci_cpp/Makefile.inc

INCLUDES += -Iinclude

# shared dependency objects, reused by both binaries
LIBOBJS:= $(JSON_OBJS) $(UBUS_OBJS) $(COMMON_OBJS) $(LOGGER_OBJS) $(SIGNAL_OBJS) $(USAGE_OBJS) $(UCI_OBJS)

world: uxcd uxe uxc

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

# libraries go AFTER the objects (needed by --as-needed toolchains like Alpine)
uxcd: $(LIBOBJS) $(OBJS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@;

uxe: $(LIBOBJS) objs/uxe.o
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@;

uxc: $(LIBOBJS) objs/uxc.o
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@;

.PHONY: install
install: uxcd uxe uxc
	install -D -m 0755 uxcd $(DESTDIR)/usr/sbin/uxcd
	install -D -m 0755 uxe $(DESTDIR)/usr/bin/uxe
	install -D -m 0755 uxc $(DESTDIR)/sbin/uxc
	install -D -m 0755 uxcd.init $(DESTDIR)/etc/init.d/uxcd
	install -D -m 0755 netifd/netns.sh $(DESTDIR)/lib/netifd/proto/netns.sh
	[ -f $(DESTDIR)/etc/config/uxcd ] || install -D -m 0644 uxcd.config $(DESTDIR)/etc/config/uxcd

.PHONY: clean
clean:
	@rm -rf objs uxcd uxe uxc
