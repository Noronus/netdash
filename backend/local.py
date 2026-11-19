"""Collectors that read the firewall itself: interfaces, neighbours/devices, pf traffic, system."""
import collections
import ipaddress
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import xml.etree.ElementTree as ET

from store import now, hour_of

CONFIG_XML = "/conf/config.xml"
LEASES = "/var/db/dnsmasq.leases"
HOSTWATCH = "/var/db/hostwatch/hosts.db"

PRETTY = {"opnsense": "OPNsense", "unraid": "Unraid", "homeassistant": "Home Assistant", "synology": "Synology NAS",
          "unifi": "UniFi OS Server", "idrac": "iDRAC", "jellyfin": "Jellyfin", "immich": "Immich"}
VM_PREFIX = {"52:54:00": "QEMU/KVM VM", "02:42:": "Docker", "00:15:5d": "Hyper-V VM", "00:50:56": "VMware VM",
             "00:0c:29": "VMware VM", "08:00:27": "VirtualBox VM"}
ONLINE_GRACE = 600          # a device counts as gone after 10 min without any sign
RATE_HISTORY = 150          # 2 s samples -> 5 min sparkline per device
WAN_HISTORY = 450           # 2 s samples -> 15 min for interface charts


def run(cmd, timeout=10):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout


def norm_mac(m):
    m = (m or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{1,2}(:[0-9a-f]{1,2}){5}", m):
        return ":".join(p.zfill(2) for p in m.split(":"))
    return None


class ConfigXML:
    """Cached parse of /conf/config.xml (re-read when the file changes)."""

    def __init__(self):
        self.mtime = 0
        self.root = None
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            m = os.stat(CONFIG_XML).st_mtime
            if m != self.mtime:
                self.root = ET.parse(CONFIG_XML).getroot()
                self.mtime = m
            return self.root


class Interfaces:
    """Interface map: device (vlan10) <-> OPNsense name (opt5) <-> description (IoT) + networks."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.by_dev = {}
        self.wan_devs = set()
        self.own_ips = set()
        self.updated = 0

    def refresh(self, force=False):
        if not force and now() - self.updated < 60:
            return
        root = self.cfg.get()
        by_dev = {}
        for el in root.find("interfaces"):
            dev = el.findtext("if")
            if not dev or el.findtext("enable") is None and el.tag not in ("lan", "lo0"):
                continue
            by_dev[dev] = {
                "ifname": el.tag,
                "device": dev,
                "descr": el.findtext("descr") or el.tag.upper(),
                "nets": [],
                "addrs": [],
                "ipaddr": el.findtext("ipaddr"),
            }
        # live addresses (also covers dhcp / slaac / tracked prefixes)
        own = set()
        cur = None
        for line in run(["ifconfig", "-a"]).splitlines():
            if line and not line[0].isspace():
                cur = line.split(":", 1)[0]
                continue
            line = line.strip()
            m = re.match(r"vlan: (\d+) .*parent interface: (\S+)", line)
            if m and cur in by_dev:
                by_dev[cur]["vlan"] = int(m.group(1))
                by_dev[cur]["parent"] = m.group(2)
                continue
            m = re.match(r"inet (\S+) netmask (0x[0-9a-f]+)", line)
            if m:
                ip = m.group(1)
                own.add(ip)
                if cur in by_dev:
                    by_dev[cur]["addrs"].append(ip)
                    plen = bin(int(m.group(2), 16)).count("1")
                    by_dev[cur]["nets"].append(str(ipaddress.ip_interface("%s/%d" % (ip, plen)).network))
                continue
            m = re.match(r"inet6 (\S+) prefixlen (\d+)", line)
            if m:
                ip = m.group(1).split("%")[0]
                own.add(ip)
                if cur in by_dev and not ip.startswith("fe80"):
                    by_dev[cur]["addrs"].append(ip)
                    by_dev[cur]["nets"].append(str(ipaddress.ip_interface("%s/%s" % (ip, m.group(2))).network))
        # gateways decide which interfaces are WAN
        wan_if = set()
        for gw in root.iter("gateway_item"):
            if gw.findtext("disabled") in ("1",):
                continue
            ifn = gw.findtext("interface")
            if ifn:
                wan_if.add(ifn)
        self.wan_devs = {d for d, i in by_dev.items() if i["ifname"] in wan_if and not d.startswith(("wg", "wt"))}
        self.by_dev = by_dev
        self.own_ips = own
        self.updated = now()

    def descr(self, dev):
        i = self.by_dev.get(dev)
        return i["descr"] if i else dev

    def children(self):
        """physical device -> [vlan devices]"""
        out = {}
        for d, i in self.by_dev.items():
            if i.get("parent"):
                out.setdefault(i["parent"], []).append(d)
        return out

    def public(self):
        """Interfaces for the UI. A physical port that carries VLANs is split into the
        port itself (kind "port", totals incl. all VLANs) and its untagged network
        (kind "net", device "<port>.untagged", counters = port minus VLANs)."""
        kids = self.children()
        out = []
        for d, i in sorted(self.by_dev.items(), key=lambda x: x[1]["descr"].lower()):
            base = {"device": d, "netif": d, "ifname": i["ifname"], "descr": i["descr"], "nets": i["nets"],
                    "wan": d in self.wan_devs, "parent": i.get("parent"), "vlan": i.get("vlan")}
            if d.startswith("lo"):
                base["kind"] = "loopback"
            elif d in self.wan_devs:
                base["kind"] = "wan"
            elif d.startswith(("wg", "wt", "tun", "ovpn", "ipsec")) or i["ifname"] in ("wireguard", "openvpn"):
                base["kind"] = "vpn"
            elif i.get("parent"):
                base["kind"] = "vlan"
            else:
                base["kind"] = "net"
            if d in kids and base["kind"] == "net":
                out.append({**base, "kind": "port", "descr": "Port %s" % d, "nets": [], "children": sorted(kids[d]),
                            "port_of": i["descr"]})
                out.append({**base, "device": d + ".untagged", "kind": "net", "parent": d, "untagged": True})
            else:
                out.append(base)
        return out


class Devices:
    """Builds the device list from ARP/NDP, DHCP leases, static mappings and hostwatch."""

    MGMT_RE = re.compile(r"mng|mgmt|manage|ipmi|oob", re.I)

    def _is_mgmt(self, ip):
        """devices with several addresses: one in a management network is not the main address"""
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        for i in self.ifaces.by_dev.values():
            if self.MGMT_RE.search(i.get("descr") or ""):
                if any(a in ipaddress.ip_network(n, strict=False) for n in i.get("nets") or []):
                    return True
        return False

    def __init__(self, state, db, ifaces, cfg):
        self.state = state
        self.db = db
        self.ifaces = ifaces
        self.cfg = cfg
        self.ip2mac = {}            # ip -> mac (current)
        self.mac_if = {}            # mac -> netif
        self.activity = {}          # mac -> last ts with pf traffic (set by Traffic)
        self.extra = {}             # mac -> dict from other sources (UniFi, AdGuard)
        self.own_macs = set()
        self.lock = threading.Lock()
        self.oui = {}
        self._load_oui()
        self.meta = {r[0]: {"name": r[1], "icon": r[2], "note": r[3], "first_seen": r[4], "last_seen": r[5],
                            "online_since": r[6], "last_ip": r[7], "last_if": r[8],
                            "place": json.loads(r[9]) if r[9] else None, "last_name": r[10]}
                     for r in db.q("SELECT mac,name,icon,note,first_seen,last_seen,online_since,last_ip,last_if,place,last_name FROM device")}

    def _load_oui(self):
        try:
            c = sqlite3.connect("file:%s?mode=ro" % HOSTWATCH, uri=True, timeout=5)
            self.oui = {a.upper(): o for a, o in c.execute("SELECT assignment, organization_name FROM oui")}
            c.close()
        except Exception:
            self.oui = {}

    def vendor(self, mac):
        if not mac:
            return None
        for pre, name in VM_PREFIX.items():
            if mac.startswith(pre):
                return name
        first = int(mac[:2], 16)
        if first & 2:
            return "Private MAC"
        return self.oui.get(mac.replace(":", "")[:6].upper())

    def collect(self):
        self.ifaces.refresh()
        t = now()
        seen = {}       # mac -> {ips, netif, src}

        stale_v6 = {}

        def add(mac, ip, netif, src):
            mac = norm_mac(mac)
            if not mac or ip in self.ifaces.own_ips:
                return
            d = seen.setdefault(mac, {"v4": set(), "v6": set(), "netif": None, "src": set(), "ipif": {}})
            if ip:
                (d["v6"] if ":" in ip else d["v4"]).add(ip)
                if netif:
                    d["ipif"][ip] = netif
            if netif and not d["netif"]:
                d["netif"] = netif
            d["src"].add(src)

        for line in run(["arp", "-an"]).splitlines():
            m = re.match(r"\S+ \((\S+)\) at (\S+) on (\S+)(.*)", line)
            if not m or "incomplete" in m.group(2) or "permanent" in m.group(4):
                continue
            add(m.group(2), m.group(1), m.group(3), "arp")
        for line in run(["ndp", "-an"]).splitlines()[1:]:
            p = line.split()
            if len(p) < 5 or p[3] == "permanent" or p[1] in ("(incomplete)",):
                continue
            ip = p[0].split("%")[0]
            if ip.startswith("fe80"):
                continue
            # only live neighbours count as presence; S(tale) entries linger for many hours
            if p[4] in ("R", "D", "P"):
                add(p[1], ip, p[2], "ndp")
            else:
                stale_v6.setdefault(norm_mac(p[1]), set()).add((ip, p[2]))

        leases = {}
        try:
            for line in open(LEASES):
                p = line.split()
                if len(p) >= 4:
                    mac = norm_mac(p[1])
                    if mac:
                        leases[mac] = {"expire": int(p[0]), "ip": p[2], "hostname": None if p[3] == "*" else p[3]}
        except FileNotFoundError:
            pass

        static = {}
        root = self.cfg.get()
        dm = root.find(".//dnsmasq")
        if dm is not None:
            for h in dm.findall("hosts"):
                mac = norm_mac(h.findtext("hwaddr"))
                if mac:
                    static[mac] = {"hostname": h.findtext("host"), "ip": h.findtext("ip"),
                                   "descr": h.findtext("descr") or ""}

        hw = {}
        try:
            c = sqlite3.connect("file:%s?mode=ro" % HOSTWATCH, uri=True, timeout=5)
            rows = c.execute(
                "SELECT ether_address, ip_address, interface_name, strftime('%s', first_seen), strftime('%s', last_seen) "
                "FROM hosts WHERE last_seen > datetime('now', '-60 day')").fetchall()
            c.close()
            for mac, ip, ifn, fs, ls in rows:
                mac = norm_mac(mac)
                if not mac:
                    continue
                e = hw.setdefault(mac, {"first": int(fs), "last": int(ls), "netif": ifn, "ips": set()})
                e["first"] = min(e["first"], int(fs))
                if int(ls) >= e["last"]:
                    e["last"] = int(ls)
                    e["netif"] = ifn
                if ip and not ip.startswith("fe80") and int(ls) > t - 86400:
                    e["ips"].add(ip)
        except Exception:
            pass

        own_macs = set()
        for line in run(["arp", "-an"]).splitlines():
            if "permanent" in line:
                m = re.search(r" at (\S+) on", line)
                if m and norm_mac(m.group(1)):
                    own_macs.add(norm_mac(m.group(1)))

        self.own_macs = own_macs
        macs = set(seen) | set(leases) | set(static) | set(hw) | set(self.meta)
        macs -= own_macs
        ip2mac = {}
        ip_if = {}
        mac_if = {}
        devices = {}
        hints = self.name_hints()
        meta_updates = []
        for mac in macs:
            s = seen.get(mac)
            l = leases.get(mac)
            st = static.get(mac)
            h = hw.get(mac)
            meta = self.meta.get(mac, {})
            ex = self.extra.get(mac, {})
            v4 = set(s["v4"]) if s else set()
            v6 = set(s["v6"]) if s else set()
            if s:
                v6 |= {ip for ip, _ in stale_v6.get(mac, ())}
            if h:
                for ip in h["ips"]:
                    (v6 if ":" in ip else v4).add(ip)
            netif = (s and s["netif"]) or (h and h["netif"]) or meta.get("last_if")
            recent = max(self.activity.get(mac, 0), ex.get("seen", 0))
            online = bool(s) or bool(ex.get("online")) or (t - recent) < ONLINE_GRACE
            last_sign = t if online else max((h["last"] if h else 0), recent, meta.get("last_seen") or 0)
            if not online and not (l or st or h or meta.get("name")):
                continue
            first_seen = min(x for x in [meta.get("first_seen") or t, h["first"] if h else t] if x)
            online_since = meta.get("online_since")
            if online and not online_since:
                online_since = int(t)
            if not online:
                online_since = None
            primary_v4 = sorted(v4, key=lambda ip: (ip != (st or {}).get("ip"), self._is_mgmt(ip), ip))[0] if v4 else ((l or {}).get("ip") or (st or {}).get("ip"))
            if s and primary_v4 in s["ipif"]:
                netif = s["ipif"][primary_v4]
            hostname = (st or {}).get("hostname") or (l or {}).get("hostname") or ex.get("hostname")
            hint = None
            for ip in [primary_v4] + sorted(v4):
                if ip in hints:
                    hint = hints[ip]
                    break
            # UniFi, the DHCP lease and the DNS hint go away when the device is off: keep the last name they gave
            auto_name = ex.get("name") or hostname or hint
            last_name = auto_name or meta.get("last_name")
            dev = {
                "mac": mac,
                "name": meta.get("name") or last_name or primary_v4 or mac,
                "networks": sorted({self.ifaces.descr(n) for n in (s["ipif"].values() if s else [])}),
                "custom_name": meta.get("name"),
                "hostname": hostname,
                "vendor": ex.get("vendor") or self.vendor(mac),
                "icon": meta.get("icon"),
                "ip": primary_v4,
                "ipv4": sorted(v4),
                "ipv6": sorted(v6),
                "netif": netif,
                "network": self.ifaces.descr(netif) if netif else None,
                "online": bool(online),
                "online_since": online_since,
                "first_seen": int(first_seen),
                "last_seen": int(last_sign) if last_sign else meta.get("last_seen"),
                "dhcp": "static" if st else ("dynamic" if l else None),
                "lease_expire": (l or {}).get("expire"),
                "private_mac": bool(int(mac[:2], 16) & 2),
                "place": meta.get("place"),
                "wan_side": bool(netif and netif in self.ifaces.wan_devs),
            }
            devices[mac] = dev
            if online:
                for ip in v4 | v6:
                    ip2mac[ip] = mac
                    ipn = (s["ipif"].get(ip) if s else None) or netif
                    if ipn:
                        ip_if[ip] = ipn
                if netif:
                    mac_if[mac] = netif
            changed = (meta.get("online_since") != online_since or not meta or
                       (online and (t - (meta.get("last_seen") or 0)) > 60) or meta.get("last_ip") != primary_v4 or
                       meta.get("last_name") != last_name)
            if changed:
                meta_updates.append((mac, meta.get("name"), meta.get("icon"), meta.get("note"), int(first_seen),
                                     int(last_sign or t), online_since, primary_v4, netif, last_name))
                self.meta[mac] = {**meta, "first_seen": int(first_seen), "last_seen": int(last_sign or t),
                                  "online_since": online_since, "last_ip": primary_v4, "last_if": netif, "last_name": last_name}
        self.db.many(
            "INSERT INTO device(mac,name,icon,note,first_seen,last_seen,online_since,last_ip,last_if,last_name) VALUES(?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(mac) DO UPDATE SET first_seen=excluded.first_seen, last_seen=excluded.last_seen, "
            "online_since=excluded.online_since, last_ip=excluded.last_ip, last_if=excluded.last_if, last_name=excluded.last_name",
            meta_updates)
        with self.lock:
            self.ip2mac = ip2mac
            self.ip_if = ip_if
            self.mac_if = mac_if
        self.state.put("devices", devices)
        self.state.put("interfaces", self.ifaces.public())

    def name_hints(self):
        """ip -> name from reverse proxy upstream descriptions ("nas-web" -> "Nas")."""
        out = {}
        root = self.cfg.get()
        for gw in root.iter("gateway_item"):
            ip, name = gw.findtext("gateway"), gw.findtext("name")
            if ip and name and re.match(r"^[0-9.]+$", ip):
                out[ip] = "Gateway " + re.sub(r"_DHCP6?$", "", name)
        ng = root.find(".//OPNsense/Nginx")
        if ng is None:
            return out
        by_base = {}
        for u in ng.findall("upstream_server"):
            ip, desc = u.findtext("server"), (u.findtext("description") or "").strip()
            if not ip or not desc:
                continue
            parts = re.split(r"[-_ ]", desc)
            by_base.setdefault(parts[0].lower(), []).append((ip, parts))
        pretty = lambda w: PRETTY.get(w.lower(), w[:1].upper() + w[1:])
        for base, items in by_base.items():
            ips = collections.Counter(ip for ip, _ in items)
            main = ips.most_common(1)[0][0]
            for ip, parts in items:
                if ip in out:
                    continue
                # "nas-ipmi" on another IP than the other "nas-*" entries is the management board, not the NAS
                out[ip] = pretty(parts[0]) if ip == main or len(parts) < 2 else pretty(parts[1])
        return out

    def set_meta(self, mac, **fields):
        mac = norm_mac(mac)
        meta = self.meta.setdefault(mac, {})
        meta.update(fields)
        place = meta.get("place")
        self.db.x(
            "INSERT INTO device(mac,name,icon,note,place) VALUES(?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET "
            "name=excluded.name, icon=excluded.icon, note=excluded.note, place=excluded.place",
            (mac, meta.get("name"), meta.get("icon"), meta.get("note"), json.dumps(place) if place else None))


ADDR_RE = re.compile(r"([0-9a-fA-F:.]+)(?:\[(\d+)\]|:(\d+))?(?:\s+\(([0-9a-fA-F:.]+)(?:\[(\d+)\]|:(\d+))?\))?")


def _endpoint_ips(txt):
    """'1.2.3.4:5 (192.168.1.2:6)' -> {'1.2.3.4', '192.168.1.2'}"""
    out = set()
    txt = txt.strip()
    main, _, rest = txt.partition(" ")
    for tok in (main, rest.strip("() ")):
        if not tok:
            continue
        if tok.count(":") > 1 and "[" in tok:
            out.add(tok.split("[")[0])
        elif tok.count(":") == 1:
            out.add(tok.split(":")[0])
        else:
            out.add(tok.split("[")[0])
    return out


class Traffic:
    """Per-device throughput and totals from pf state byte counters, per-interface from netstat."""

    def __init__(self, state, db, devices, ifaces, acc_dev, acc_if):
        self.state = state
        self.db = db
        self.devices = devices
        self.ifaces = ifaces
        self.acc_dev = acc_dev
        self.acc_if = acc_if
        self.prev_states = {}
        self.started = False
        self.prev_if = {}
        self.prev_t = None
        self.dev_hist = collections.defaultdict(lambda: collections.deque(maxlen=RATE_HISTORY))
        self.if_hist = collections.defaultdict(lambda: collections.deque(maxlen=WAN_HISTORY))
        self.rates = {}
        self.if_rates = {}
        self.conns = {}

    def _parse_states(self, out):
        states = {}
        cur = None
        for line in out.splitlines():
            if not line.startswith(" "):
                p = line.split(None, 2)
                if len(p) < 3:
                    cur = None
                    continue
                rest = p[2]
                if " <- " in rest:
                    left, right = rest.split(" <- ", 1)
                    initiator, responder = right, left
                elif " -> " in rest:
                    left, right = rest.split(" -> ", 1)
                    initiator, responder = left, right
                else:
                    cur = None
                    continue
                responder = re.split(r"\s{2,}", responder.strip())[0]
                cur = {"i": _endpoint_ips(initiator), "r": _endpoint_ips(responder), "proto": p[1]}
                continue
            if cur is None:
                continue
            s = line.strip()
            if s.startswith("age "):
                m = re.search(r"(\d+):(\d+) bytes", s)
                if m:
                    cur["b"] = (int(m.group(1)), int(m.group(2)))
            elif s.startswith("id: "):
                cur["id"] = s.split()[1] + s.split()[3]
            elif s.startswith("origif: "):
                cur["if"] = s.split()[1]
                if "id" in cur and "b" in cur:
                    states[cur["id"]] = cur
                cur = None
        return states

    def collect(self):
        t = now()
        dt = (t - self.prev_t) if self.prev_t else None
        with self.devices.lock:
            ip2mac = dict(self.devices.ip2mac)
            ip_if = dict(getattr(self.devices, "ip_if", {}))
        states = self._parse_states(run(["pfctl", "-vvss"], timeout=20))
        inc = collections.defaultdict(lambda: [0, 0])
        conns = collections.Counter()
        for sid, st in states.items():
            c, d = st["b"]
            pc, pd = self.prev_states.get(sid, (0, 0) if self.started else (c, d))
            dc, dd = c - pc, d - pd
            if dc < 0 or dd < 0:
                dc, dd = c, d
            for side, (up, down) in (("i", (dc, dd)), ("r", (dd, dc))):
                for ip in st[side]:
                    mac = ip2mac.get(ip)
                    if mac and ip_if.get(ip) == st["if"]:
                        conns[mac] += 1
                        if up or down:
                            inc[mac][0] += up
                            inc[mac][1] += down
        self.prev_states = {sid: st["b"] for sid, st in states.items()}
        self.started = True

        rates = {}
        for mac, (up, down) in inc.items():
            if up or down:
                self.acc_dev.add(mac, t, up, down)
            if up:
                # only traffic *from* the device proves it is there (pings to an offline host also create states)
                self.devices.activity[mac] = t
        if dt:
            for mac in set(inc) | set(self.dev_hist):
                up, down = inc.get(mac, (0, 0))
                h = self.dev_hist[mac]
                h.append((round(t), int(up / dt), int(down / dt)))
                win = list(h)[-3:]
                rates[mac] = (sum(x[1] for x in win) // len(win), sum(x[2] for x in win) // len(win))
            for mac in [m for m, h in self.dev_hist.items() if all(x[1] == 0 and x[2] == 0 for x in h)]:
                del self.dev_hist[mac]
        self.rates = rates
        self.conns = dict(conns)

        # interface counters
        cur_if = {}
        for line in run(["netstat", "-ibnW", "-f", "link"]).splitlines()[1:]:
            p = line.split()
            if len(p) < 11:
                continue
            name = p[0].rstrip("*")
            try:
                cur_if[name] = (int(p[7]), int(p[10]))
            except ValueError:
                continue
        if_rates = {}
        if dt:
            deltas = {}
            for name, (rx, tx) in cur_if.items():
                if name not in self.ifaces.by_dev:
                    continue
                prx, ptx = self.prev_if.get(name, (rx, tx))
                deltas[name] = (max(rx - prx, 0), max(tx - ptx, 0))
            # untagged share of a VLAN trunk port = port counters minus its VLANs
            for port, kids in self.ifaces.children().items():
                if port in deltas:
                    drx = deltas[port][0] - sum(deltas.get(k, (0, 0))[0] for k in kids)
                    dtx = deltas[port][1] - sum(deltas.get(k, (0, 0))[1] for k in kids)
                    deltas[port + ".untagged"] = (max(drx, 0), max(dtx, 0))
            for name, (drx, dtx) in deltas.items():
                if drx or dtx:
                    self.acc_if.add(name, t, drx, dtx)
                r = (int(drx / dt), int(dtx / dt))
                self.if_hist[name].append((round(t), r[0], r[1]))
                if_rates[name] = r
        self.prev_if = cur_if
        self.prev_t = t
        self.if_rates = if_rates
        self.state.put("traffic", {
            "devices": {m: {"up": r[0], "down": r[1], "conns": self.conns.get(m, 0)} for m, r in rates.items()},
            "conns": self.conns,
            "interfaces": {n: {"rx": r[0], "tx": r[1]} for n, r in if_rates.items()},
            "states": len(states),
            "t": t,
        })

    def device_history(self, mac):
        return list(self.dev_hist.get(mac, []))

    def interface_history(self):
        return {n: list(h) for n, h in self.if_hist.items()}


class System:
    """CPU, memory, load, temperature, uptime and disk of the firewall."""

    def __init__(self, state):
        self.state = state
        self.prev_cp = None
        self.cpu_hist = collections.deque(maxlen=WAN_HISTORY)

    def collect(self):
        keys = ["kern.cp_time", "kern.boottime", "vm.loadavg", "hw.physmem", "vm.stats.vm.v_page_size",
                "vm.stats.vm.v_free_count", "vm.stats.vm.v_inactive_count", "vm.stats.vm.v_cache_count",
                "kstat.zfs.misc.arcstats.size", "hw.model", "hw.ncpu", "kern.osrelease"]
        vals = {}
        for k in keys:
            out = run(["sysctl", "-n", k]).strip()
            vals[k] = out
        cp = [int(x) for x in vals["kern.cp_time"].split()]
        cpu = None
        if self.prev_cp:
            d = [a - b for a, b in zip(cp, self.prev_cp)]
            tot = sum(d) or 1
            cpu = round(100.0 * (tot - d[4]) / tot, 1)
            self.cpu_hist.append((round(now()), cpu))
        self.prev_cp = cp
        boot = int(re.search(r"sec = (\d+)", vals["kern.boottime"]).group(1))
        load = [float(x) for x in vals["vm.loadavg"].strip("{} ").split()]
        page = int(vals["vm.stats.vm.v_page_size"] or 4096)
        total = int(vals["hw.physmem"])
        free = (int(vals["vm.stats.vm.v_free_count"] or 0) + int(vals["vm.stats.vm.v_inactive_count"] or 0) +
                int(vals["vm.stats.vm.v_cache_count"] or 0)) * page
        arc = int(vals["kstat.zfs.misc.arcstats.size"] or 0)
        temps = []
        for line in run(["sysctl", "hw.acpi.thermal", "dev.cpu"]).splitlines():
            m = re.match(r"(\S+temperature): ([\d.]+)C", line)
            if m:
                temps.append({"sensor": m.group(1), "c": float(m.group(2))})
        st = os.statvfs("/")
        pf = run(["pfctl", "-si"])
        m = re.search(r"current entries\s+(\d+)", pf)
        self.state.put("system", {
            "model": vals["hw.model"], "cores": int(vals["hw.ncpu"] or 0), "os": vals["kern.osrelease"],
            "cpu": cpu, "cpu_hist": list(self.cpu_hist)[-150:], "load": load, "boot": boot, "uptime": int(now() - boot),
            "mem_total": total, "mem_used": total - free, "arc": arc,
            "temps": temps,
            "disk_total": st.f_blocks * st.f_frsize, "disk_used": (st.f_blocks - st.f_bfree) * st.f_frsize,
            "pf_states": int(m.group(1)) if m else None,
        })
