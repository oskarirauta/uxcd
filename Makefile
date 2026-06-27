all: world

CXX?=g++
CXXFLAGS?=--std=c++17 -Wall -fPIC
LDFLAGS?=-L/lib -L/usr/lib

OBJS:= \
	objs/container.o \
	objs/main.o

# dependency trees: ubus_cpp -> json_cpp, logger_cpp -> common -> rva/tsl
JSON_DIR:=ubus_cpp/json
UBUSCPP_DIR:=ubus_cpp
COMMON_DIR:=common_cpp
LOGGER_DIR:=logger_cpp
SIGNAL_DIR:=SIG_cpp

include ubus_cpp/json/Makefile.inc
include ubus_cpp/Makefile.inc
include common_cpp/Makefile.inc
include logger_cpp/Makefile.inc
include SIG_cpp/Makefile.inc

INCLUDES += -Iinclude

world: uxcd

$(shell mkdir -p objs)

objs/main.o: src/main.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

objs/container.o: src/container.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<;

# libraries go AFTER the objects (needed by --as-needed toolchains like Alpine)
uxcd: $(JSON_OBJS) $(UBUS_OBJS) $(COMMON_OBJS) $(LOGGER_OBJS) $(SIGNAL_OBJS) $(OBJS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) $^ $(LIBS) -o $@;

.PHONY: install
install: uxcd
	install -D -m 0755 uxcd $(DESTDIR)/usr/sbin/uxcd
	install -D -m 0755 uxcd.init $(DESTDIR)/etc/init.d/uxcd
	install -D -m 0755 netifd/netns.sh $(DESTDIR)/lib/netifd/proto/netns.sh

.PHONY: clean
clean:
	@rm -rf objs uxcd
