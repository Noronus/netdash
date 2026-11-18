#!/usr/bin/env python3
"""netdash demo server: the real frontend with simulated data, for screenshots and UI work without an OPNsense.

    cd frontend && npm run build && cd .. && python3 tools/demo/server.py [port]   ->  http://127.0.0.1:8090

Everything here is made up: names, addresses (RFC 1918 and the documentation ranges 192.0.2.0/24,
198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) and traffic. Write actions answer "ok" and change nothing.
"""
import http.server
import json
import math
import os
import random
import re
import socketserver
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
WWW = os.path.join(ROOT, "..", "..", "frontend", "dist")
NOW = time.time()
R = random.Random(42)
H = 3600
D = 86400

# ------------------------------------------------------------------ network
NETS = {  # device: (descr, net, vlan)
    "igb1.untagged": ("LAN", "192.168.1.0/24", None),
    "vlan10": ("IoT", "192.168.10.0/24", 10),
    "vlan20": ("Gäste", "192.168.20.0/24", 20),
    "vlan30": ("Server", "192.168.30.0/24", 30),
}
SWITCH_PORTS = [  # name, form, speed when up, description
    ("P1", "rj45", 2500, "Desktop"), ("P2", "rj45", 1000, "Drucker"), ("P3", "rj45", 0, ""),
    ("P4", "rj45", 1000, "Kamera Einfahrt"), ("P5", "rj45", 2500, "Access Point"), ("P6", "rj45", 1000, "TV"),
    ("P7", "rj45", 0, ""), ("P8", "rj45", 1000, "Konsole"), ("X1", "sfp", 10000, "NAS"), ("X2", "sfp", 10000, "Firewall"),
]

# name, icon, vendor, net, host, link, where, online, avg kbit/s down
DEVICES = [
    ("Desktop", "desktop", "ASUSTek", "igb1.untagged", 20, "switch", "P1", True, 9000),
    ("Laptop Anna", "laptop", "Apple", "igb1.untagged", 21, "wifi", "Zuhause", True, 4200),
    ("Laptop Ben", "laptop", "Lenovo", "igb1.untagged", 22, "wifi", "Zuhause", True, 800),
    ("iPhone Anna", "phone", "Apple", "igb1.untagged", 30, "wifi", "Zuhause", True, 1500),
    ("Pixel Ben", "phone", "Google", "igb1.untagged", 31, "wifi", "Zuhause", True, 350),
    ("iPad", "tablet", "Apple", "igb1.untagged", 32, "wifi", "Zuhause", False, 0),
    ("Fernseher", "tv", "Samsung", "igb1.untagged", 40, "switch", "P6", True, 16000),
    ("Spielkonsole", "game", "Sony", "igb1.untagged", 41, "switch", "P8", True, 300),
    ("Drucker", "printer", "Brother", "igb1.untagged", 50, "switch", "P2", True, 2),
    ("Access Point", "ap", "Ubiquiti", "igb1.untagged", 5, "switch", "P5", True, 40),
    ("Switch", "switch", "Realtek", "igb1.untagged", 4, None, None, True, 5),
    ("NAS", "nas", "Dell", "vlan30", 10, "switch", "X1", True, 2500),
    ("Home Assistant", "homeassistant", "QEMU/KVM VM", "vlan30", 11, "switch", "X1", True, 60),
    ("Mediaserver", "vm", "QEMU/KVM VM", "vlan30", 12, "switch", "X1", True, 6000),
    ("Kamera Einfahrt", "camera", "Reolink", "vlan10", 20, "switch", "P4", True, 1),
    ("Steckdose Waschmaschine", "plug", "Shelly", "vlan10", 30, "wifi", "IoT", True, 1),
    ("Steckdose Büro", "plug", "Shelly", "vlan10", 31, "wifi", "IoT", True, 1),
    ("Wechselrichter", "solar", "Espressif", "vlan10", 32, "wifi", "IoT", True, 2),
    ("Lautsprecher Küche", "speaker", "Sonos", "vlan10", 33, "wifi", "IoT", True, 90),
    ("Gast-Handy", "phone", "Samsung", "vlan20", 100, "wifi", "Gäste", True, 700),
    ("Router (Modem)", "router", "AVM", "wan", 1, None, None, True, 0),
]


def mac(i):
    return "02:5d:%02x:%02x:%02x:%02x" % (0x10 + i, (i * 37) % 256, (i * 91) % 256, (i * 53) % 256)


def ip_of(net, host):
    if net == "wan":
        return "192.168.178.%d" % host
    return NETS[net][1].rsplit(".", 1)[0] + ".%d" % host


def wave(base, phase=0.0, t=None):
    t = NOW if t is None else t
    return max(0, int(base * (0.55 + 0.45 * math.sin(t / 47 + phase) + R.random() * 0.35)))


def build_devices(t):
    out = []
    for i, (name, icon, vendor, net, host, link, where, online, kbit) in enumerate(DEVICES):
        m = mac(i)
        down = wave(kbit * 125, i, t) if online else 0
        up = int(down * (0.08 + (i % 5) * 0.03))
        wifi = None
        attach = None
        if link == "wifi":
            wifi = {"essid": where, "ap_mac": mac(9), "radio": "6e" if i % 3 == 0 else "na", "channel": 37 if i % 3 == 0 else 44,
                    "signal": -48 - (i * 7) % 25, "rssi": 48, "satisfaction": 98 - (i * 3) % 20, "tx_rate": 1200000, "rx_rate": 860000,
                    "uptime": 3 * H + i * 600, "assoc_time": int(t - 3 * H), "proto": "ax", "guest": where == "Gäste", "ap": "Access Point"}
            attach = {"kind": "wifi", "ap": "Access Point", "ap_mac": mac(9), "ssid": where, "port": "P5"}
        elif link == "switch":
            sp = next(p for p in SWITCH_PORTS if p[0] == where)
            attach = {"kind": "switch", "switch": "Switch", "port": where, "descr": sp[3], "speed": sp[2],
                      "media": "fiber" if sp[1] == "sfp" else "copper", "via": None, "via_mac": None, "stale": None}
        elif net == "wan":
            attach = {"kind": "firewall", "iface": "WAN", "wan": True}
        out.append({
            "mac": m, "name": name, "networks": [NETS[net][0]] if net in NETS else ["WAN"], "custom_name": name,
            "hostname": name.lower().replace(" ", "-"), "vendor": vendor, "icon": None, "icon_auto": icon,
            "ip": ip_of(net, host), "ipv4": [ip_of(net, host)], "ipv6": ["2001:db8:1::%x" % (0x100 + i)] if net == "igb1.untagged" else [],
            "netif": "igb1" if net == "igb1.untagged" else ("igb0" if net == "wan" else net),
            "network": NETS[net][0] if net in NETS else "WAN", "online": online, "online_since": int(t - (2 + i) * H),
            "first_seen": int(t - (40 + i) * D), "last_seen": int(t if online else t - 5 * H),
            "dhcp": "static" if icon in ("nas", "printer", "ap", "switch", "camera", "homeassistant") else "dynamic",
            "lease_expire": int(t + 6 * H), "private_mac": False, "place": None, "wan_side": net == "wan",
            "up": up, "down": down, "conns": (i * 7) % 40 + (3 if online else 0),
            "today_up": int(kbit * 125 * 3000 * 0.1), "today_down": int(kbit * 125 * 3000),
            "month_up": int(kbit * 125 * 70000 * 0.1), "month_down": int(kbit * 125 * 70000),
            "dns_q24": (i * 613) % 9000 + 200 if online else 0, "dns_b24": (i * 97) % 600,
            "wifi": wifi, "link": link if link in ("wifi",) else ("wired" if link else "unknown"), "attach": attach,
            "blocked": False, "connected_since": int(t - (2 + i) * H),
        })
    return out


def build_interfaces(t, devs):
    by_net = {}
    for d in devs:
        by_net.setdefault(d["netif"], [0, 0])
        by_net[d["netif"]][0] += d["up"]
        by_net[d["netif"]][1] += d["down"]
    wan_rx = sum(d["down"] for d in devs) + 20000
    wan_tx = sum(d["up"] for d in devs) + 8000
    rows = [{"device": "igb0", "netif": "igb0", "ifname": "wan", "descr": "WAN", "nets": ["192.168.178.0/24"], "wan": True,
             "parent": None, "vlan": None, "kind": "wan", "rx": wan_rx, "tx": wan_tx, "status": "up", "media": "2500Base-T <full-duplex>",
             "addr4": "192.168.178.2", "addr6": "2001:db8::2"}]
    kids = [n for n in NETS if n.startswith("vlan")]
    port_rx = sum(by_net.get(n if n != "igb1.untagged" else "igb1", [0, 0])[0] for n in NETS)
    port_tx = sum(by_net.get(n if n != "igb1.untagged" else "igb1", [0, 0])[1] for n in NETS)
    rows.append({"device": "igb1", "netif": "igb1", "ifname": "lan", "descr": "Port igb1", "nets": [], "wan": False, "parent": None,
                 "vlan": None, "kind": "port", "children": kids, "port_of": None, "rx": port_rx, "tx": port_tx, "status": "up",
                 "media": "10Gbase-SR <full-duplex>", "addr4": "192.168.1.1", "addr6": ""})
    for dev, (descr, net, vlan) in NETS.items():
        key = "igb1" if dev == "igb1.untagged" else dev
        r = by_net.get(key, [0, 0])
        row = {"device": dev, "netif": key, "ifname": descr.lower(), "descr": descr, "nets": [net], "wan": False,
               "parent": "igb1", "vlan": vlan, "kind": "net" if vlan is None else "vlan", "rx": r[0], "tx": r[1], "status": "up",
               "media": "", "addr4": net.rsplit(".", 1)[0] + ".1", "addr6": ""}
        if vlan is None:
            row["untagged"] = True
        rows.append(row)
    rows.append({"device": "wg0", "netif": "wg0", "ifname": "opt5", "descr": "wg_unterwegs", "nets": ["10.10.0.0/24"], "wan": False,
                 "parent": None, "vlan": None, "kind": "vpn", "rx": wave(30000, 1, t), "tx": wave(90000, 2, t), "status": "up",
                 "media": "", "addr4": "10.10.0.1", "addr6": ""})
    rows.append({"device": "lo0", "netif": "lo0", "ifname": "lo0", "descr": "Loopback", "nets": ["127.0.0.0/8"], "wan": False,
                 "parent": None, "vlan": None, "kind": "loopback", "rx": wave(60000, 3, t), "tx": 0, "status": "up", "media": "",
                 "addr4": "127.0.0.1", "addr6": ""})
    for r in rows:
        if r["kind"] == "loopback":
            r["tx"] = r["rx"]
        r.update(today_rx=r["rx"] * 2500, today_tx=r["tx"] * 2500, month_rx=r["rx"] * 60000, month_tx=r["tx"] * 60000)
    return rows


def build_full():
    t = time.time()
    devs = build_devices(t)
    ifs = build_interfaces(t, devs)
    ok = {"ok": True, "updated": t}
    switch_ports = []
    for i, (n, form, speed, descr) in enumerate(SWITCH_PORTS):
        macs = [{"mac": d["mac"], "vlan": 1} for d in devs if (d.get("attach") or {}).get("port") == n and d["attach"]["kind"] == "switch"]
        switch_ports.append({"idx": i, "name": n, "descr": descr, "up": speed > 0, "speed": speed or None,
                             "media": "fiber" if form == "sfp" else "copper", "type": "10G SFP+" if form == "sfp" else "2.5G Copper",
                             "admin": True, "form": form, "admin_speed": "auto", "admin_duplex": "auto", "admin_flow": "disable",
                             "ten_gig": form == "sfp", "vlans": "1,10,20,30" if n in ("X1", "X2", "P5") else "1",
                             "vlan_mode": 2 if n in ("X1", "X2", "P5") else 1,
                             "lldp": [{"name": "opnsense", "mac": "02:00:00:00:00:01", "port_id": "igb1"}] if n == "X2" else
                                     [{"name": "Access Point", "mac": mac(9), "port_id": "eth0"}] if n == "P5" else [],
                             "macs": macs, "util": None})
    cpu = round(8 + 6 * math.sin(t / 30) + R.random() * 4, 1)
    return {
        "t": t, "version": "1.0.0", "sources": {k: ok for k in ("devices", "interfaces", "traffic", "netbird", "unraid", "adguard",
                                                                 "wireguard", "gatus", "gateways", "unifi", "services", "ifinfo",
                                                                 "system", "vps", "dns_top", "vps_ifaces", "switch")},
        "system": {"model": "Intel(R) Celeron(R) J6412 @ 2.00GHz", "cores": 4, "os": "15.1-RELEASE", "cpu": cpu,
                   "cpu_hist": [[int(t - (60 - k) * 5), round(8 + 6 * math.sin((t - (60 - k) * 5) / 30), 1)] for k in range(60)],
                   "load": [0.42, 0.38, 0.35], "boot": int(t - 12 * D), "uptime": 12 * D + 4 * H, "mem_total": 8 << 30,
                   "mem_used": int(2.9 * (1 << 30)), "arc": 1 << 30, "temps": [{"sensor": "cpu0", "c": 47.0}],
                   "disk_total": 110 << 30, "disk_used": 9 << 30, "pf_states": 1843},
        "gateways": [{"name": "WAN_DHCP", "address": "192.168.178.1", "status": "none", "loss": "0.0 %", "delay": "4.1 ms",
                      "stddev": "0.6 ms", "monitor": "192.168.178.1", "status_translated": "Online"}],
        "services": [{"id": n, "locked": 0, "running": 0 if n == "ntopng" else 1, "description": d, "name": n} for n, d in [
            ("AdGuardHome", "AdGuardHome"), ("configd", "System Configuration Daemon"), ("cron", "Cron"), ("dnsmasq", "Dnsmasq DNS/DHCP"),
            ("netdash", "netdash Netzwerk-Dashboard"), ("nginx", "nginx"), ("ntpd", "Network Time Daemon"), ("openssh", "Secure Shell Daemon"),
            ("syslog-ng", "Syslog-ng Daemon"), ("webgui", "Web GUI"), ("wireguard", "WireGuard"), ("ntopng", "ntopng")]],
        "wireguard": [
            {"if": "wg0", "type": "interface", "public-key": "dGVzdGtleQ==", "listen-port": "51820", "status": "up", "name": "wg_unterwegs", "ifname": "opt5"},
            {"if": "wg0", "type": "peer", "public-key": "cGVlcjE=", "endpoint": "198.51.100.77:41022", "allowed-ips": "10.10.0.2/32",
             "transfer-rx": 182 << 20, "transfer-tx": 1900 << 20, "latest-handshake": int(t - 40), "latest-handshake-age": 40, "name": "Handy Anna"},
            {"if": "wg0", "type": "peer", "public-key": "cGVlcjI=", "endpoint": "", "allowed-ips": "10.10.0.3/32",
             "transfer-rx": 0, "transfer-tx": 0, "latest-handshake": 0, "latest-handshake-age": None, "name": "Laptop Ben"}],
        "netbird": {"ip": "100.92.0.1/16", "fqdn": "opnsense.netbird.cloud", "management": True, "signal": True, "version": "0.36.0",
                    "peers": [{"name": "vps", "fqdn": "vps.netbird.cloud", "ip": "100.92.0.2", "status": "Connected", "type": "P2P",
                               "latency_ms": 14.2, "rx": 1900 << 20, "tx": 4100 << 20, "handshake": "2026-11-18T12:00:00Z", "since": ""},
                              {"name": "laptop-anna", "fqdn": "laptop-anna.netbird.cloud", "ip": "100.92.0.3", "status": "Connecting",
                               "type": "", "latency_ms": 0, "rx": 0, "tx": 0, "handshake": "", "since": ""}]},
        "gatus": [{"key": "%s_%s" % (g, n), "name": n, "group": g, "ok": n != "Drucker", "uptime": 99.9 if n != "Drucker" else 81.0,
                   "ms": ms, "hist": [True] * 18 + ([True, True] if n != "Drucker" else [False, False]), "t": "", "errors": None}
                  for g, n, ms in [("Internet", "Cloudflare DNS", 9), ("Internet", "Quad9", 11), ("Dienste", "Home Assistant", 23),
                                   ("Dienste", "Mediaserver", 41), ("Dienste", "NAS Web", 18), ("Netzwerk", "Access Point", 2),
                                   ("Netzwerk", "Switch", 3), ("Netzwerk", "Drucker", 0)]],
        "unraid": {"ip": "192.168.30.10", "zfs": True, "hostname": "tower", "boot": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t - 20 * D)),
                   "cpu_model": "AMD Ryzen 7 5700G", "threads": 16, "cpu": round(11 + 5 * math.sin(t / 40), 1),
                   "mem": {"total": 64 << 30, "used": 22 << 30, "available": 42 << 30, "percentTotal": 34.0, "swapTotal": 0, "swapUsed": 0},
                   "array_state": "STARTED",
                   "pools": [{"name": "tank", "size": 24 << 20, "temp": 34, "status": "DISK_OK", "fs_size": int(21.8 * (1 << 30)), "fs_used": int(12.1 * (1 << 30))},
                             {"name": "ssd", "size": 2 << 30, "temp": 41, "status": "DISK_OK", "fs_size": int(1.8 * (1 << 30)), "fs_used": int(0.7 * (1 << 30))}],
                   "containers": [{"name": n, "state": "RUNNING" if n != "backup" else "EXITED", "status": "Up 3 days" if n != "backup" else "Exited (0) 6 hours ago",
                                   "auto": True, "image": "example/" + n} for n in ["jellyfin", "nextcloud", "immich", "paperless", "vaultwarden", "backup"]]},
        "unifi_devices": [{"mac": mac(9), "name": "Access Point", "model": "U7 Pro", "type": "uap", "state": 1, "ip": "192.168.1.5",
                           "version": "8.0.0", "uptime": 9 * D, "clients": 9, "cpu": "6.1", "mem": "41.0", "upgradable": False, "satisfaction": 97,
                           "radios": [{"radio": "ng", "channel": 6, "cu": 31, "clients": 3, "tx_power": 17},
                                      {"radio": "na", "channel": 44, "cu": 18, "clients": 4, "tx_power": 20},
                                      {"radio": "6e", "channel": 37, "cu": 6, "clients": 2, "tx_power": 22}], "ports": []}],
        "wlans": [{"id": "w1", "name": "Zuhause", "enabled": True, "hidden": False, "security": "wpapsk", "wpa": "wpa3", "bands": ["2g", "5g", "6e"], "guest": False, "pass": None, "has_pass": True},
                  {"id": "w2", "name": "IoT", "enabled": True, "hidden": True, "security": "wpapsk", "wpa": "wpa2", "bands": ["2g"], "guest": False, "pass": None, "has_pass": True},
                  {"id": "w3", "name": "Gäste", "enabled": True, "hidden": False, "security": "wpapsk", "wpa": "wpa2", "bands": ["2g", "5g"], "guest": True, "pass": None, "has_pass": True}],
        "wifi_blocked": [],
        "switch": {"name": "Switch", "model": "8x2.5G+2x10G web managed", "mac": mac(10), "ip": "192.168.1.4", "fw": "1.0.2",
                   "uptime": "9 Tage, 4 Std.", "serial": "DEMO0001", "ports": switch_ports, "unsaved": False, "uplink": "X2"},
        "vps": {"wan_ip": "198.51.100.25", "forwards_file": "/etc/netdash-vps/forwards.json",
                "forwards": [{"proto": "tcp", "port": 25565, "to_ip": "192.168.30.20", "to_port": 25565, "comment": "Minecraft", "enabled": True, "packets": 182340, "bytes": 912 << 20},
                             {"proto": "udp", "port": 34197, "to_ip": "192.168.30.21", "to_port": 34197, "comment": "Factorio", "enabled": False, "packets": 0, "bytes": 0}],
                "pending": False, "timer": "inactive", "other_dnat": [], "listeners": ["tcp/22", "tcp/80", "tcp/443"], "time": int(t),
                "name": "VPS", "history": [],
                "wg": [{"name": "wg-anna", "active": True, "autostart": True, "created": True, "has_client": True, "address": "10.99.0.1/30", "port": "51820",
                        "pub": "a2V5", "hooks": 1, "peers": [{"pub": "cA==", "comment": "anna", "allowed": "10.99.0.2/32", "endpoint": "203.0.113.50:50211",
                                                             "keepalive": None, "handshake": int(t - 70), "rx": 420 << 20, "tx": 3100 << 20}]},
                       {"name": "wg-ben", "active": False, "autostart": False, "created": True, "has_client": True, "address": "10.99.0.5/30", "port": "51821",
                        "pub": "a2V5Mg==", "hooks": 1, "peers": [{"pub": "cQ==", "comment": "ben", "allowed": "10.99.0.6/32", "endpoint": "",
                                                                  "keepalive": None, "handshake": 0, "rx": None, "tx": None}]}],
                "wg_defaults": {"home_routes": "192.168.0.0/16", "dns": "192.168.1.1", "tun_net": "10.99.0.0/24", "ports": "51820-51899"}},
        "vps_ifaces": [
            {"name": "eth0", "kind": "public", "label": "Internet (öffentlich)", "state": "UP", "mtu": 1500, "addrs": ["198.51.100.25/32", "2001:db8:99::1/128"],
             "rx": wave(90000, 4, t), "tx": wave(70000, 5, t), "rx_total": 61 << 30, "tx_total": 55 << 30, "rx_drop": 0, "tx_drop": 0, "t": int(t),
             "today_rx": 2 << 30, "today_tx": 1 << 30, "month_rx": 40 << 30, "month_tx": 31 << 30},
            {"name": "wg-anna", "kind": "wireguard", "label": "WireGuard anna", "state": "UNKNOWN", "mtu": 1420, "addrs": ["10.99.0.1/30"],
             "rx": wave(4000, 6, t), "tx": wave(30000, 7, t), "rx_total": 420 << 20, "tx_total": 3100 << 20, "rx_drop": 0, "tx_drop": 0, "t": int(t),
             "today_rx": 30 << 20, "today_tx": 210 << 20, "month_rx": 420 << 20, "month_tx": 3100 << 20},
            {"name": "wt0", "kind": "netbird", "label": "NetBird", "state": "UNKNOWN", "mtu": 1280, "addrs": ["100.92.0.2/16"],
             "rx": wave(40000, 8, t), "tx": wave(60000, 9, t), "rx_total": 4 << 30, "tx_total": 2 << 30, "rx_drop": 0, "tx_drop": 0, "t": int(t),
             "today_rx": 300 << 20, "today_tx": 200 << 20, "month_rx": 4 << 30, "month_tx": 2 << 30}],
        "own_ips": ["192.168.1.1"], "setup": {"opnsense_api": True},
        "adguard": {"protection": True, "version": "v0.107.55", "running": True, "queries": 61234, "blocked": 7311, "avg_ms": 6.4,
                    "series_q": [2000 + int(900 * math.sin(k / 3)) for k in range(24)], "series_b": [240 + int(110 * math.sin(k / 3)) for k in range(24)],
                    "top_domains": [], "top_blocked": [], "top_clients": [], "clients": []},
        "dns_top": {"domains": [[d, n] for d, n in [("i.ytimg.com", 4210), ("api.github.com", 2950), ("www.wikipedia.org", 1980),
                                                    ("time.cloudflare.com", 1440), ("updates.example.org", 1210), ("cdn.example.net", 930)]],
                    "blocked": [[d, n] for d, n in [("telemetry.example.com", 1880), ("ads.example.net", 1020), ("tracker.example.org", 640)]],
                    "clients": [[d["mac"], d["dns_q24"]] for d in devs[:6]], "unique": 1843, "hidden": []},
        "interfaces": ifs, "devices": devs, "pf_states": 1843,
    }


def history():
    """15 min of 2 s points, computed with the same model as the live values"""
    t = time.time()
    out = {}
    for k in range(450):
        tk = t - (450 - k) * 2
        for i in build_interfaces(tk, build_devices(tk)):
            out.setdefault(i["device"], []).append([int(tk), i["rx"], i["tx"]])
    for n, base in (("vps:eth0", 80000), ("vps:wg-anna", 15000), ("vps:wt0", 50000)):
        out[n] = [[int(t - (90 - k) * 10), wave(base, k / 5.0, t - (90 - k) * 10), wave(base * 0.8, k / 6.0, t - (90 - k) * 10)] for k in range(90)]
    return {"interfaces": out, "cpu": [[int(t - (450 - k) * 2), round(9 + 5 * math.sin(k / 20), 1)] for k in range(450)]}


def detail(m):
    full = build_full()
    d = next((x for x in full["devices"] if x["mac"] == m), None)
    if not d:
        return None
    t = int(time.time())
    hour0 = t - t % H
    return {"device": d,
            "live": [[t - (150 - k) * 2, int(d["up"] * (0.45 + 0.3 * math.sin(k / 9) + 0.5 * R.random())),
                      int(d["down"] * (0.45 + 0.3 * math.sin(k / 7) + 0.5 * R.random()))] for k in range(150)],
            "hours": [{"hour": hour0 - (47 - k) * H, "up": int((d["today_up"] or 1e6) / 20 * (0.5 + R.random())),
                       "down": int((d["today_down"] or 1e7) / 20 * (0.5 + R.random()))} for k in range(48)],
            "days": [{"day": (t - t % D) - (29 - k) * D, "up": int(d["month_up"] / 30 * (0.5 + R.random())),
                      "down": int(d["month_down"] / 30 * (0.5 + R.random()))} for k in range(30)],
            "dns": {"top": [["api.github.com", 820], ["i.ytimg.com", 640], ["www.wikipedia.org", 210], ["time.cloudflare.com", 96]],
                    "top_blocked": [["telemetry.example.com", 120]],
                    "hours": [{"hour": hour0 - (23 - k) * H, "q": 40 + int(30 * math.sin(k / 3)), "b": 4} for k in range(24)],
                    "recent": [{"t": t - k * 37, "domain": ["api.github.com", "i.ytimg.com", "telemetry.example.com"][k % 3], "type": "A", "blocked": k % 3 == 2} for k in range(20)]},
            "unifi": None}


def zfs():
    t = int(time.time())

    def ds(name, used, ratio=1.0, mount=True):
        return {"name": name, "used": used, "avail": 0, "refer": used, "snap": 0, "child": 0, "ratio": ratio, "quota": None,
                "type": "filesystem", "mount": "/mnt/" + name if mount else None}
    G = 1 << 30
    tank = [ds("tank", 12 * 1024 * G), ds("tank/media", int(8.2 * 1024 * G)), ds("tank/backup", int(1.9 * 1024 * G), 1.31),
            ds("tank/fotos", int(1.1 * 1024 * G)), ds("tank/dokumente", 92 * G, 1.6), ds("tank/isos", 64 * G)]
    ssd = [ds("ssd", 700 * G), ds("ssd/appdata", 140 * G, 1.5), ds("ssd/vms", 480 * G, 1.8), ds("ssd/vms/homeassistant", 32 * G, 1.9),
           ds("ssd/vms/mediaserver", 120 * G, 1.4), ds("ssd/system", 30 * G, 1.5)]
    return {"t": t, "pools": [
        {"name": "tank", "health": "ONLINE", "frag": 6, "cap": 55, "raw_size": 36 << 40, "raw_alloc": 19 << 40, "raw_free": 17 << 40,
         "used": 12 << 40, "total": int(21.8 * (1 << 40)), "datasets": tank},
        {"name": "ssd", "health": "ONLINE", "frag": 21, "cap": 38, "raw_size": 2 << 40, "raw_alloc": 700 << 30, "raw_free": 1300 << 30,
         "used": 700 << 30, "total": int(1.8 * (1 << 40)), "datasets": ssd}]}


SPEEDTESTS = [{"t": int(NOW - k * 7 * H), "down": round(480 - k * 13.5, 1), "up": round(48 - k * 1.2, 1), "ping": round(10.8 + k * 0.6, 1),
               "jitter": 1.4, "loaded_down": 38.0, "loaded_up": 12.0, "loss": 0, "isp": "Example ISP", "server": "Example Server, Berlin",
               "iface": "igb0", "ip": "203.0.113.10", "url": None} for k in range(5)]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WWW, **kw)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        return self.send_json({"ok": True})

    def do_GET(self):
        p = self.path.split("?")[0]
        if not p.startswith("/api/"):
            if not os.path.exists(os.path.join(WWW, p.lstrip("/"))) or p == "/":
                self.path = "/index.html"
            return super().do_GET()
        if p == "/api/me":
            return self.send_json({"user": "admin"})
        if p == "/api/state":
            return self.send_json(build_full())
        if p == "/api/history":
            return self.send_json(history())
        if p == "/api/events":
            return self.events()
        m = re.fullmatch(r"/api/device/([0-9a-f:]{17})", p)
        if m:
            return self.send_json(detail(m.group(1)) or {"error": "not found"})
        if p == "/api/unraid/zfs":
            return self.send_json(zfs())
        if p == "/api/diag/sources":
            return self.send_json({"sources": [{"device": "igb0", "descr": "WAN", "v4": ["192.168.178.2"], "v6": ["2001:db8::2"]},
                                               {"device": "igb1", "descr": "LAN", "v4": ["192.168.1.1"], "v6": []},
                                               {"device": "vlan30", "descr": "Server", "v4": ["192.168.30.1"], "v6": []}]})
        if p == "/api/diag/speedtest":
            return self.send_json({"installed": True, "servers": [{"id": 1, "name": "Example Server", "location": "Berlin"}],
                                   "history": SPEEDTESTS, "running": False})
        if p == "/api/gatus/endpoints":
            return self.send_json({"available": True, "endpoints": [], "groups": ["Internet", "Dienste", "Netzwerk"]})
        if p == "/api/firewall/rules":
            return self.send_json({"rules": FW_RULES, "txn": {"status": "idle", "pending": 0, "can_undo": False, "remaining": None, "history": []}})
        if p == "/api/firewall/log":
            t = int(time.time())
            ents = [{"seq": 1000 + k, "t": t - k * 3, "if": ["IoT", "Gäste", "WAN"][k % 3], "action": "block" if k % 4 == 0 else "pass",
                     "dir": "in", "proto": ["tcp", "udp"][k % 2], "src": ["192.168.10.31", "192.168.20.100", "203.0.113.77"][k % 3],
                     "dst": ["192.168.1.20", "1.1.1.1", "192.168.178.2"][k % 3], "sport": str(40000 + k), "dport": ["443", "53", "22"][k % 3],
                     "rule": "IoT: keine privaten Netze" if k % 4 == 0 else "IoT: Internet"} for k in range(40)]
            return self.send_json({"entries": ents, "seq": 1040, "stats": {"pass": 1832, "block": 214, "top_src": [["203.0.113.77", 120]]}})
        if p == "/api/proxy":
            return self.send_json({"entries": [], "suffix": ".home.example.com", "answer": "192.168.1.1"})
        return self.send_json({})

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        tick = 0
        try:
            while True:
                f = build_full()
                if tick % 5 == 0:
                    ev, data = "full", f
                else:
                    sw = {p["name"]: [p["up"], p["speed"]] for p in f["switch"]["ports"]}
                    ev, data = "fast", {"t": f["t"], "dev": {d["mac"]: [d["up"], d["down"]] for d in f["devices"]},
                                        "if": {i["device"]: [i["rx"], i["tx"]] for i in f["interfaces"]}, "cpu": f["system"]["cpu"], "sw": sw}
                self.wfile.write(("event: %s\ndata: %s\n\n" % (ev, json.dumps(data))).encode())
                self.wfile.flush()
                tick += 1
                time.sleep(2)
        except (BrokenPipeError, ConnectionResetError):
            return


def _rule(seq, iface, action, src, dst, dport, descr, pk=0, proto="any"):
    return {"uuid": "00000000-0000-4000-8000-%012d" % seq, "enabled": True, "auto": False, "sequence": seq, "sort": str(seq), "action": action,
            "quick": True, "interface": iface.lower(), "interface_label": iface, "direction": "in", "ipprotocol": "inet", "protocol": proto,
            "source": src, "source_not": False, "source_port": "", "destination": dst, "destination_not": False, "destination_port": dport,
            "log": action == "block", "description": descr, "categories": "", "gateway": "", "packets": pk, "bytes": pk * 900, "states": pk // 400, "evaluations": pk * 3}


FW_RULES = [_rule(10, "IoT", "pass", "IoT net", "This Firewall", "53", "IoT: DNS", 18230, "TCP/UDP"),
            _rule(20, "IoT", "block", "IoT net", "RFC1918", "", "IoT: keine privaten Netze", 4421),
            _rule(30, "IoT", "pass", "IoT net", "any", "", "IoT: Internet", 90210),
            _rule(40, "Gäste", "block", "Gäste net", "RFC1918", "", "Gäste: nur Internet", 1310),
            _rule(50, "Gäste", "pass", "Gäste net", "any", "", "Gäste: Internet", 22018),
            _rule(60, "LAN", "pass", "LAN net", "any", "", "LAN: alles erlaubt", 1820331)]


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    print("netdash demo on http://127.0.0.1:%d" % port)
    Server(("127.0.0.1", port), Handler).serve_forever()
