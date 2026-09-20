# Metrics (Prometheus)

uxcd exposes per-container and daemon metrics in the Prometheus text format. The
**`uxcd-metrics`** package ships a CGI endpoint at **`/cgi-bin/uxcd-metrics`**
(served by uhttpd, which LuCI already pulls in) -- point a Prometheus scrape at
it. `uxc metrics` prints the same text, and `ubus call uxcd metrics` returns it
as `{ "metrics": "..." }`; both come from the daemon itself and work whether or
not the endpoint package is installed.

The endpoint is its own package because `/cgi-bin` is not behind the LuCI login
(see [Access](#access)): a router that never scrapes need not carry it. It is
selected by default when uxcd is, so image builds keep the endpoint; `opkg
remove uxcd-metrics` takes it away without touching the daemon, and an existing
install upgrading from 3.6.0 or earlier has to install it once by hand.

```
uxcd_up 1
uxcd_containers_total 3
uxcd_containers_running 2
uxcd_container_up{name="frigate"} 1
uxcd_container_memory_bytes{name="frigate"} 1234567890
uxcd_container_cpu_seconds_total{name="frigate"} 1234.567890
uxcd_container_pids{name="frigate"} 42
uxcd_container_restarts_total{name="frigate"} 0
uxcd_container_health{name="frigate"} 1            # 1 healthy, 0 unhealthy, -1 unknown
uxcd_container_oom_kills_total{name="frigate"} 0
```

## Access

Like other `/cgi-bin` endpoints the metrics CGI is **unauthenticated** (Prometheus
can't log in), so by default uxcd serves it to **localhost only**. To allow a
remote scrape from a trusted network:

```sh
uci set uxcd.main.metrics_public=1 && uci commit uxcd
/etc/init.d/uxcd restart
```

Otherwise scrape it locally, or put it behind your own firewall — the usual
Prometheus convention.
