#!/usr/local/bin/python3
"""netdash - network dashboard backend for OPNsense.

Runs on the firewall. Listen address, port and TLS come from /usr/local/etc/netdash.conf
(default: LAN address, port 8098, HTTPS with the web GUI certificate or a self-signed one).
Auth uses the OPNsense user database (WebGui service, admins only).
"""
import http.server
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import actions  # noqa: E402
import diag  # noqa: E402
import firewall  # noqa: E402
import gatuscfg  # noqa: E402
import icons  # noqa: E402
import integrations  # noqa: E402
import switch  # noqa: E402
import vps  # noqa: E402
import proxy  # noqa: E402
import local  # noqa: E402
import remote  # noqa: E402
from store import DB, Accumulator, State, hour_of, now  # noqa: E402

BASE = os.environ.get("NETDASH_BASE", "/usr/local/netdash")
WWW = os.path.join(BASE, "www")
CONF_FILE = os.environ.get("NETDASH_CONF", "/usr/local/etc/netdash.conf")
SESSION_DAYS = 30
VERSION = "1.1.0"


def load_conf():
    """{"listen": "lan" | "0.0.0.0" | "127.0.0.1" | <ip>, "port": 8098, "tls": true}"""
    c = {"listen": "lan", "port": 8098, "tls": True}
    try:
        with open(CONF_FILE) as f:
            c.update(json.load(f))
    except FileNotFoundError:
        pass
    except ValueError as e:
        log("netdash.conf is not valid JSON (%s), using defaults" % e)
    if os.environ.get("NETDASH_PORT"):
        c["port"] = int(os.environ["NETDASH_PORT"])
    return c


def _config_root():
    import xml.etree.ElementTree as ET
    return ET.parse("/conf/config.xml").getroot()


def lan_ip():
    try:
        ip = _config_root().findtext("interfaces/lan/ipaddr") or ""
        ipaddress.ip_address(ip)
        return ip
    except (OSError, ValueError, AttributeError):
        return None


def listen_addr(c):
    want = str(c.get("listen") or "lan")
    if want != "lan":
        return want
    return lan_ip() or "0.0.0.0"


def tls_context():
    """use the certificate of the OPNsense web GUI if there is one, otherwise a self-signed one"""
    import base64
    import ssl
    pem = os.path.join(BASE, "data", "tls.pem")
    try:
        root = _config_root()
        ref = root.findtext("system/webgui/ssl-certref")
        cert = next((c for c in root.findall("cert") if c.findtext("refid") == ref), None) if ref else None
        if cert is not None and cert.findtext("crt") and cert.findtext("prv"):
            data = base64.b64decode(cert.findtext("crt")) + b"\n" + base64.b64decode(cert.findtext("prv"))
            old = os.umask(0o077)
            try:
                with open(pem, "wb") as f:
                    f.write(data)
            finally:
                os.umask(old)
    except Exception as e:
        log("web GUI certificate not usable (%s)" % e)
    if not os.path.exists(pem):
        log("creating a self-signed certificate for netdash")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
                        "-subj", "/CN=netdash", "-keyout", pem, "-out", pem + ".crt"],
                       check=True, capture_output=True)
        with open(pem, "ab") as f:
            f.write(open(pem + ".crt", "rb").read())
        os.unlink(pem + ".crt")
        os.chmod(pem, 0o600)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(pem)
    return ctx


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def load_secrets():
    try:
        with open(os.path.join(BASE, "secrets.json")) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


class App:
    def __init__(self):
        self.secrets = load_secrets()
        self.state = State()
        self.db = DB()
        self.cfg = local.ConfigXML()
        self.ifaces = local.Interfaces(self.cfg)
        self.acc_dev = Accumulator(self.db, "traffic", ["up", "down"], "mac")
        self.acc_if = Accumulator(self.db, "iftraffic", ["rx", "tx"], "ifname")
        self.acc_dns = Accumulator(self.db, "dns", ["queries", "blocked"], "mac")
        self.devices = local.Devices(self.state, self.db, self.ifaces, self.cfg)
        self.traffic = local.Traffic(self.state, self.db, self.devices, self.ifaces, self.acc_dev, self.acc_if)
        self.system = local.System(self.state)
        self.opn = remote.OPNsense(self.state, self.secrets["opnsense"]) if "opnsense" in self.secrets else None
        self.adguard = remote.AdGuard(self.state, self.db, self.devices, self.acc_dns, self.secrets.get("adguard"))
        self.gatus = remote.Gatus(self.state, (self.secrets.get("gatus") or {}).get("url") or "")
        self.unifi = remote.UniFi(self.state, self.devices, self.secrets.get("unifi"))
        self.unraid = remote.Unraid(self.state, self.secrets.get("unraid"))
        self.netbird = remote.NetBird(self.state)
        gatuscfg.set_dir((self.secrets.get("gatus") or {}).get("dir"))
        self.gatuscfg = gatuscfg.GatusConfig()
        self.proxy = proxy.Proxy(self.opn, self.cfg, self.secrets.get("adguard"), lan_ip()) if self.opn else None
        self.switch = switch.Switch(self.state, self.devices, self.secrets.get("switch"))
        self.fw = firewall.Firewall(self)
        self.vps = vps.VPS(self.state, self.secrets.get("vps"))
        self.vps.sink = self._vps_sink
        self.actions = actions.Actions(self)
        self.diag = diag.Diag(self)
        self.totals = {"today": {}, "month": {}, "if_today": {}}
        self.full_cache = (0, None)
        self.fail_log = {}

    # ------------------------------------------------------------ scheduling
    def enabled(self, integ):
        return integ is None or (self.secrets.get(integ) or {}).get("enabled", True)

    def every(self, name, interval, fn, delay=0, integ=None):
        def loop():
            time.sleep(delay)
            while True:
                t0 = time.time()
                if not self.enabled(integ):
                    self.state.fail(name, "disabled")
                    time.sleep(interval)
                    continue
                try:
                    fn()
                except Exception as e:
                    if str(e) == "not configured":   # integration without settings yet: no log noise
                        self.state.fail(name, "not configured")
                        time.sleep(interval)
                        continue
                    self.state.fail(name, "%s: %s" % (type(e).__name__, e))
                    last = self.fail_log.get(name, 0)
                    if time.time() - last > 300:
                        self.fail_log[name] = time.time()
                        log("collector %s failed: %s" % (name, traceback.format_exc(limit=3)))
                time.sleep(max(0.2, interval - (time.time() - t0)))
        threading.Thread(target=loop, name=name, daemon=True).start()

    def start(self):
        try:
            self.devices.collect()
        except Exception:
            log("initial device scan failed", traceback.format_exc(limit=3))
        self.every("devices", 10, self.devices.collect, 10)
        self.every("traffic", 2, self.traffic.collect)
        self.every("system", 5, self.system.collect)
        # registered even without an API key, so entering one later in the UI starts them right away
        self.every("gateways", 5, lambda: self._opn().collect_fast(), integ="opnsense")
        self.every("services", 10, lambda: self._opn().collect_services(), integ="opnsense")
        self.every("wireguard", 10, lambda: self._opn().collect_wireguard(), integ="opnsense")
        self.every("ifinfo", 60, lambda: self._opn().collect_slow(), integ="opnsense")
        self.every("dns_log", 5, self.adguard.collect_log)
        self.every("adguard", 30, lambda: self.adguard.collect_api(), integ="adguard")
        self.every("gatus", 30, lambda: self.gatus.collect(), integ="gatus")
        self.every("unifi", 10, lambda: self.unifi.collect(), integ="unifi")
        self.every("unraid", 15, lambda: self.unraid.collect(), integ="unraid")
        self.every("netbird", 15, lambda: self.netbird.collect(), integ="netbird")
        self.every("switch", 30, lambda: self.switch.collect(), 5, integ="switch")
        self.every("switch_links", 5, lambda: self.switch.poll_links(), 12, integ="switch")
        self.every("fwlog", 1, self.fw.collect_log)
        self.every("vps", 30, lambda: self.vps.collect(), 3, integ="vps")
        self.every("vps_if", 10, lambda: self.vps.collect_ifaces(), 6, integ="vps")
        self.every("blocksync", 60, lambda: self.actions.sync(), 40, integ="opnsense")
        self.every("flush", 30, self.flush, 30)
        self.every("totals", 60, self.compute_totals, 5)
        self.every("prune", 86400, self.db.prune, 600)

    def _opn(self):
        if not self.opn:
            raise RuntimeError("not configured")
        return self.opn

    def apply_integration(self, name):
        """re-create the client of one integration from secrets.json (no restart)"""
        self.secrets = load_secrets()
        cfg = self.secrets.get(name) or {}
        if name == "opnsense":
            self.opn = remote.OPNsense(self.state, cfg)
            if self.proxy:
                self.proxy.opn = self.opn
            else:
                self.proxy = proxy.Proxy(self.opn, self.cfg, self.secrets.get("adguard"), lan_ip())
        elif name == "adguard":
            self.adguard.set_cfg(cfg)
            if self.proxy:
                self.proxy.ag = cfg
        elif name == "unifi":
            self.unifi = remote.UniFi(self.state, self.devices, cfg)
            if not cfg.get("enabled", True):
                self.devices.extra = {}
        elif name == "unraid":
            self.unraid = remote.Unraid(self.state, cfg)
        elif name == "gatus":
            self.gatus = remote.Gatus(self.state, cfg.get("url") or "")
            gatuscfg.set_dir(cfg.get("dir"))
        elif name == "switch":
            self.switch = switch.Switch(self.state, self.devices, cfg)
        elif name == "vps":
            self.vps = vps.VPS(self.state, cfg)
            self.vps.sink = self._vps_sink
        if not cfg.get("enabled", True):
            for sec in {"unifi": ["unifi"], "unraid": ["unraid"], "switch": ["switch"], "gatus": ["gatus"],
                        "adguard": ["adguard"], "netbird": ["netbird"]}.get(name, []):
                with self.state.lock:
                    self.state.sections.pop(sec, None)

    def refresh_gatus_later(self):
        # Gatus polls its config files every ~30 s; pick up the new state after that
        for wait in (35, 40, 60):
            time.sleep(wait)
            try:
                self.gatus.collect()
            except Exception:
                pass

    def flush(self):
        self.acc_dev.flush()
        self.acc_if.flush()
        self.acc_dns.flush()

    def compute_totals(self):
        self.flush()
        lt = time.localtime()
        midnight = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))
        month = int(time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, 0, 0, -1)))
        today = {m: (u, d) for m, u, d in self.db.q(
            "SELECT mac, SUM(up), SUM(down) FROM traffic WHERE hour >= ? GROUP BY mac", (midnight,))}
        mon = {m: (u, d) for m, u, d in self.db.q(
            "SELECT mac, SUM(up), SUM(down) FROM traffic WHERE hour >= ? GROUP BY mac", (month,))}
        ift = {n: (rx, tx) for n, rx, tx in self.db.q(
            "SELECT ifname, SUM(rx), SUM(tx) FROM iftraffic WHERE hour >= ? GROUP BY ifname", (midnight,))}
        ifm = {n: (rx, tx) for n, rx, tx in self.db.q(
            "SELECT ifname, SUM(rx), SUM(tx) FROM iftraffic WHERE hour >= ? GROUP BY ifname", (month,))}
        self.totals = {"today": today, "month": mon, "if_today": ift, "if_month": ifm}

    # ------------------------------------------------------------ views
    def build_devices(self):
        devs = self.state.get("devices", {}) or {}
        tr = (self.state.get("traffic") or {}).get("devices", {})
        dns = self.state.get("dns_clients", {}) or {}
        uni = (self.state.get("unifi") or {}).get("clients", {})
        infra = {d["mac"]: d for d in (self.state.get("unifi") or {}).get("devices", [])}
        sw = self.state.get("switch")
        port_of, lldp_at, uplink = {}, {}, None
        if sw:
            own = self.devices.own_macs
            for p in sw["ports"]:
                for m in p["macs"]:
                    port_of.setdefault(m["mac"], p)
                if any(m["mac"] in own for m in p["macs"]):
                    uplink = p["name"]
                if p["lldp"]:
                    lldp_at[p["name"]] = p["lldp"][0]
        self.sw_uplink = uplink
        if self.switch:
            self.switch.uplink = uplink
        names_by_mac = {m: d.get("name") for m, d in devs.items()}
        blocked = set(self.db.kv_get("blocked_macs", []))
        out = []
        for mac, d in devs.items():
            r = tr.get(mac, {})
            td = self.totals["today"].get(mac, (0, 0))
            mo = self.totals["month"].get(mac, (0, 0))
            q = dns.get(mac)
            if not q:
                for ip in d["ipv4"] + d["ipv6"]:
                    if "ip:" + ip in dns:
                        q = dns["ip:" + ip]
                        break
            w = uni.get(mac)
            item = dict(d)
            item.update({
                "up": r.get("up", 0), "down": r.get("down", 0), "conns": r.get("conns", 0),
                "today_up": td[0] or 0, "today_down": td[1] or 0,
                "month_up": mo[0] or 0, "month_down": mo[1] or 0,
                "dns_q24": (q or {}).get("q24", 0), "dns_b24": (q or {}).get("b24", 0),
                "wifi": None, "link": "unknown",
            })
            if w:
                item["link"] = "wired" if w["wired"] else "wifi"
                if not w["wired"]:
                    item["wifi"] = {k: w.get(k) for k in ("essid", "ap_mac", "radio", "channel", "signal", "rssi",
                                                          "satisfaction", "tx_rate", "rx_rate", "uptime",
                                                          "assoc_time", "proto", "guest")}
                    ap = infra.get(w.get("ap_mac"))
                    item["wifi"]["ap"] = ap["name"] if ap else None
                else:
                    item["switch"] = {"mac": w.get("sw_mac"), "port": w.get("sw_port"),
                                      "name": (infra.get(w.get("sw_mac")) or {}).get("name")}
                if w.get("uptime"):
                    item["connected_since"] = int(now() - w["uptime"])
            if mac in infra:
                item["infra"] = infra[mac]["type"]
            if sw and mac == sw.get("mac"):
                item["infra"] = "usw"
                if not item.get("custom_name") and not item.get("hostname"):
                    item["name"] = sw.get("name") or "Switch"
                item["vendor"] = sw.get("model") or item.get("vendor")
            # where is it plugged in
            p = port_of.get(mac)
            att = None
            if item["link"] == "wifi" and item.get("wifi"):
                apmac = (item["wifi"] or {}).get("ap_mac")
                ap_port = port_of.get(apmac)
                att = {"kind": "wifi", "ap": item["wifi"].get("ap"), "ap_mac": apmac, "ssid": item["wifi"].get("essid"),
                       "port": ap_port["name"] if ap_port else None}
            elif p and p["name"] != uplink:
                ln = lldp_at.get(p["name"])
                via = via_mac = None
                if ln and ln.get("mac") and ln["mac"] != mac:
                    via_mac = ln["mac"]
                    via = names_by_mac.get(via_mac) or ln.get("name") or via_mac
                stale = next((m.get("stale") for m in p["macs"] if m["mac"] == mac and m.get("stale")), None)
                att = {"kind": "switch", "switch": sw.get("name") or "Switch", "port": p["name"], "descr": p["descr"],
                       "speed": p["speed"], "media": p["media"], "via": via, "via_mac": via_mac, "stale": stale}
            elif p and p["name"] == uplink:
                att = {"kind": "firewall", "iface": item.get("network"), "note": "über den Switch-Uplink %s" % uplink}
            elif item.get("netif") and item["netif"] in self.ifaces.by_dev and not self.ifaces.by_dev[item["netif"]].get("parent") \
                    and item["netif"] not in self.ifaces.children():
                att = {"kind": "firewall", "iface": item.get("network")}
            # a fixed assignment wins over "no idea" and over a remembered (stale) port; only a live sighting beats it
            if item.get("place") and (att is None or att.get("stale")):
                pl = item["place"]
                if pl.get("kind") == "switch" and sw:
                    pp = next((x for x in sw["ports"] if x["name"] == pl.get("port")), None)
                    att = {"kind": "switch", "switch": sw.get("name") or "Switch", "port": pl.get("port"),
                           "descr": pp["descr"] if pp else "", "speed": pp["speed"] if pp else None,
                           "media": pp["media"] if pp else None, "via": None, "via_mac": None, "manual": True,
                           "stale": None if (pp and pp["up"]) else int(item.get("last_seen") or 0) or None}
                elif pl.get("kind") == "via" and pl.get("via_mac"):
                    host = devs.get(pl["via_mac"])
                    hp = port_of.get(pl["via_mac"])
                    att = {"kind": "switch", "switch": sw.get("name") if sw else None, "port": hp["name"] if hp else None,
                           "descr": hp["descr"] if hp else "", "speed": hp["speed"] if hp else None,
                           "via": (host or {}).get("name") or pl["via_mac"], "via_mac": pl["via_mac"], "manual": True}
                elif pl.get("kind") == "firewall":
                    att = {"kind": "firewall", "iface": pl.get("iface") or item.get("network"), "manual": True}
            if att and att.get("kind") == "firewall" and item.get("wan_side"):
                att["wan"] = True
            item["attach"] = att
            # a known switch port (own switch, manual placement or behind the uplink) means a cable, even without UniFi data
            if item["link"] == "unknown" and att and (att["kind"] == "switch" or att.get("note")):
                item["link"] = "wired"
            item["blocked"] = mac in blocked
            item["icon_auto"] = icons.guess(item, w, infra.get(mac))
            if item.get("online") and not item.get("connected_since"):
                item["connected_since"] = item.get("online_since")
            out.append(item)
        out.sort(key=lambda x: (not x["online"], -(x["up"] + x["down"]), (x["name"] or "").lower()))
        return out

    def _vps_sink(self, name, t, drx, dtx, r):
        key = "vps:" + name
        if drx or dtx:
            self.acc_if.add(key, t, drx, dtx)
        self.traffic.if_hist[key].append((round(t), r[0], r[1]))

    def build_full(self):
        s = self.state.snapshot()
        sec = s["sections"]
        tr = sec.get("traffic") or {}
        ifr = tr.get("interfaces", {})
        ifinfo = {r["device"]: r for r in sec.get("ifinfo") or [] if r.get("device")}
        ifaces = []
        for i in sec.get("interfaces") or []:
            r = ifr.get(i["device"], {})
            info = ifinfo.get(i.get("netif") or i["device"], {})
            t = self.totals.get("if_today", {}).get(i["device"], (0, 0))
            m = self.totals.get("if_month", {}).get(i["device"], (0, 0))
            ifaces.append({**i, "rx": r.get("rx", 0), "tx": r.get("tx", 0),
                           "today_rx": t[0] or 0, "today_tx": t[1] or 0,
                           "month_rx": m[0] or 0, "month_tx": m[1] or 0,
                           "status": info.get("status"), "media": info.get("media"),
                           "addr4": info.get("addr4"), "addr6": info.get("addr6"), "vlan": i.get("vlan") or info.get("vlan_tag")})
        devices = self.build_devices()
        return {
            "t": now(), "version": VERSION,
            "sources": s["sources"],
            "system": sec.get("system"),
            "gateways": sec.get("gateways"),
            "services": sec.get("services"),
            "wireguard": sec.get("wireguard"),
            "netbird": sec.get("netbird"),
            "gatus": sec.get("gatus"),
            "unraid": sec.get("unraid"),
            "unifi_devices": (sec.get("unifi") or {}).get("devices"),
            "wlans": (sec.get("unifi") or {}).get("wlans"),
            "wifi_blocked": (sec.get("unifi") or {}).get("blocked"),
            "switch": dict(sec["switch"], uplink=getattr(self, "sw_uplink", None)) if sec.get("switch") else None,
            "vps": sec.get("vps"),
            "vps_ifaces": [{**i, "today_rx": self.totals.get("if_today", {}).get("vps:" + i["name"], (0, 0))[0] or 0,
                            "today_tx": self.totals.get("if_today", {}).get("vps:" + i["name"], (0, 0))[1] or 0,
                            "month_rx": self.totals.get("if_month", {}).get("vps:" + i["name"], (0, 0))[0] or 0,
                            "month_tx": self.totals.get("if_month", {}).get("vps:" + i["name"], (0, 0))[1] or 0}
                           for i in sec.get("vps_ifaces") or []],
            "own_ips": sorted(self.ifaces.own_ips),
            "setup": {"opnsense_api": bool(self.opn)},
            "adguard": sec.get("adguard"),
            "dns_top": sec.get("dns_top"),
            "interfaces": ifaces,
            "devices": devices,
            "pf_states": tr.get("states"),
        }

    def switch_recollect(self):
        """the switch web UI sometimes reports a change a few seconds late; read it again shortly after"""
        def run():
            try:
                self.switch.collect()
            except Exception:
                pass
        for delay in (3, 10):
            t = threading.Timer(delay, run)
            t.daemon = True
            t.start()

    def build_fast(self):
        tr = self.state.get("traffic") or {}
        sysd = self.state.get("system") or {}
        sw = self.state.get("switch") or {}
        return {
            "sw": {p["name"]: [p["up"], p["speed"]] for p in sw.get("ports", [])},
            "t": now(),
            "dev": {m: [r["up"], r["down"]] for m, r in (tr.get("devices") or {}).items()},
            "if": {n: [r["rx"], r["tx"]] for n, r in (tr.get("interfaces") or {}).items()},
            "cpu": sysd.get("cpu"),
        }

    def device_detail(self, mac):
        mac = mac.lower()
        dev = next((d for d in self.build_devices() if d["mac"] == mac), None)
        if not dev:
            return None
        since = hour_of(now()) - 47 * 3600
        hours = {h: [u, d] for h, u, d in self.db.q(
            "SELECT hour, up, down FROM traffic WHERE mac=? AND hour>=? ORDER BY hour", (mac, since))}
        for h, v in self.acc_dev.pending(mac, since).items():
            cur = hours.setdefault(h, [0, 0])
            cur[0] += v[0]
            cur[1] += v[1]
        days = [{"day": d, "up": u, "down": dn} for d, u, dn in self.db.q(
            "SELECT (hour - hour % 86400) AS d, SUM(up), SUM(down) FROM traffic WHERE mac=? AND hour>=? GROUP BY d ORDER BY d",
            (mac, hour_of(now()) - 30 * 86400))]
        key = mac
        dns = self.adguard.device_detail(key)
        if not dns["hours"]:
            for ip in dev["ipv4"] + dev["ipv6"]:
                alt = self.adguard.device_detail("ip:" + ip)
                if alt["hours"]:
                    dns = alt
                    break
        uni = ((self.state.get("unifi") or {}).get("clients") or {}).get(mac)
        return {
            "device": dev,
            "live": self.traffic.device_history(mac),
            "hours": [{"hour": h, "up": v[0], "down": v[1]} for h, v in sorted(hours.items())],
            "days": days,
            "dns": dns,
            "unifi": uni,
        }


# ---------------------------------------------------------------- auth

AUTH_PHP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "auth.php")


def opnsense_auth(user, password):
    if not re.fullmatch(r"[A-Za-z0-9._@-]{1,64}", user or ""):
        return False
    try:
        p = subprocess.run(["/usr/local/bin/php", AUTH_PHP], input=json.dumps({"user": user, "pass": password}),
                           capture_output=True, text=True, timeout=20, cwd="/usr/local/opnsense/mvc")
        r = json.loads(p.stdout.strip().splitlines()[-1])
        return bool(r.get("ok") and r.get("admin"))
    except Exception:
        log("auth helper failed", traceback.format_exc(limit=2))
        return False


class Sessions:
    def __init__(self, db):
        self.db = db
        self.fails = {}

    def create(self, user, ip):
        tok = secrets.token_urlsafe(32)
        t = int(now())
        self.db.x("INSERT INTO session(token,user,created,expires,ip) VALUES(?,?,?,?,?)",
                  (tok, user, t, t + SESSION_DAYS * 86400, ip))
        return tok

    def check(self, tok):
        if not tok:
            return None
        r = self.db.q("SELECT user, expires FROM session WHERE token=?", (tok,))
        if not r or r[0][1] < now():
            return None
        if r[0][1] - now() < (SESSION_DAYS - 1) * 86400:
            self.db.x("UPDATE session SET expires=? WHERE token=?", (int(now()) + SESSION_DAYS * 86400, tok))
        return r[0][0]

    def drop(self, tok):
        self.db.x("DELETE FROM session WHERE token=?", (tok,))

    def blocked(self, ip):
        lst = [t for t in self.fails.get(ip, []) if t > now() - 900]
        self.fails[ip] = lst
        return len(lst) >= 5

    def failed(self, ip):
        self.fails.setdefault(ip, []).append(now())


# ---------------------------------------------------------------- http

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "netdash"
    protocol_version = "HTTP/1.1"
    app = None
    sessions = None

    def log_message(self, fmt, *args):
        pass

    def client_ip(self):
        return self.headers.get("X-Real-IP") or (self.headers.get("X-Forwarded-For") or "").split(",")[-1].strip() \
            or self.client_address[0]

    def cookie(self, name):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return None

    def user(self):
        return self.sessions.check(self.cookie("nd_s"))

    def send_json(self, obj, code=200, headers=None):
        body = json.dumps(obj, separators=(",", ":"), default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536:
            raise ValueError("body too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            return self.api_get(path)
        return self.static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/login":
            return self.login()
        user = self.user()
        if not user:
            return self.send_json({"error": "auth"}, 401)
        if self.headers.get("X-ND") != "1":
            return self.send_json({"error": "csrf"}, 403)
        if path == "/api/logout":
            self.sessions.drop(self.cookie("nd_s"))
            return self.send_json({"ok": True}, headers={"Set-Cookie": "nd_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"})
        if path.startswith("/api/proxy"):
            return self.proxy_post(path, user)
        if path.startswith("/api/firewall/"):
            return self.fw_post(path, user)
        if path == "/api/diag/speedtest/install":
            try:
                r = self.app.diag.speedtest_install()
            except Exception as e:
                return self.send_json({"error": "Installation fehlgeschlagen: %s" % e}, 500)
            log("speedtest cli installed by", user)
            return self.send_json(r)
        if path == "/api/diag/stop":
            return self.send_json({"ok": self.app.diag.stop(str(self.read_json().get("rid", "")))})
        if path == "/api/vps/wg":
            body = self.read_json()
            try:
                if body.get("action") == "create":
                    r = self.app.vps.wg_create(str(body.get("name", "")).strip().lower(), str(body.get("route", "home")),
                                               str(body.get("dns", "adguard")))
                else:
                    r = self.app.vps.wg_action(str(body.get("name", "")), str(body.get("action", "")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            if body.get("action") not in ("config",):
                log("vps wg", body, "by", user)
            return self.send_json(r)
        if path in ("/api/vps/forwards", "/api/vps/test"):
            body = self.read_json()
            try:
                if path == "/api/vps/forwards":
                    r = {"ok": True, "status": self.app.vps.apply(body.get("forwards") or [])}
                else:
                    r = self.app.vps.test(str(body.get("ip")), int(body.get("port")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("vps action failed", path, traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("vps", path, "by", user, json.dumps(body, ensure_ascii=False)[:300])
            return self.send_json(r)
        if path == "/api/switch/vlans":
            body = self.read_json()
            name = str(body.get("port", ""))
            try:
                if name == getattr(self.app, "sw_uplink", None) and not body.get("force"):
                    raise ValueError("Das ist der Uplink zur OPNsense (Trunk). Änderungen hier können den ganzen Switch und das Dashboard abhängen.")
                r = self.app.switch.set_vlans(name, body.get("untagged"), body.get("tagged") or [])
                self.app.switch.collect()
                self.app.switch_recollect()
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("switch vlan failed", traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("switch vlans", name, "by", user, json.dumps(body)[:200])
            return self.send_json({"ok": True, "vlans": r})
        if path in ("/api/switch/port", "/api/switch/save"):
            body = self.read_json()
            sw = self.app.switch
            try:
                if path == "/api/switch/port":
                    name = str(body.get("port", ""))
                    if not body.get("enabled", True) and name == getattr(self.app, "sw_uplink", None) and not body.get("force"):
                        raise ValueError("Das ist der Uplink zur OPNsense. Abschalten trennt den ganzen Switch vom Netz.")
                    sw.set_port(name, body.get("descr", ""), bool(body.get("enabled", True)), body.get("speed") or "auto")
                else:
                    sw.save_config()
                sw.collect()
                self.app.switch_recollect()
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("switch action failed", path, traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("switch", path, "by", user, json.dumps(body)[:200])
            return self.send_json({"ok": True, "unsaved": sw.unsaved})
        m = re.fullmatch(r"/api/integrations/([a-z]+)(/test)?", path)
        if m and m.group(1) in integrations.SCHEMA:
            name = m.group(1)
            body = self.read_json()
            cfg = integrations.merged(name, body)
            ok, msg = integrations.test(name, cfg, self.app.devices) if cfg.get("enabled", True) else (True, "deaktiviert")
            if m.group(2):
                return self.send_json({"ok": ok, "message": msg})
            if not ok and not body.get("force"):
                return self.send_json({"ok": False, "message": msg, "saved": False}, 400)
            d = integrations.load()
            d[name] = cfg
            integrations.save(d)
            self.app.apply_integration(name)
            log("integration", name, "saved by", user, "enabled=%s" % cfg.get("enabled", True))
            return self.send_json({"ok": ok, "message": msg, "saved": True})
        if path == "/api/gatus/endpoint":
            body = self.read_json()
            try:
                ep = self.app.gatuscfg.upsert(body.get("ep") or {}, body.get("old"))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            log("gatus endpoint saved by", user, ep.get("group"), ep.get("name"))
            old = body.get("old") or {}
            if old and (old.get("name"), old.get("group") or "") != (ep.get("name"), ep.get("group") or ""):
                self.app.gatus.forget(str(old.get("group", "")), str(old.get("name", "")))
            threading.Thread(target=self.app.refresh_gatus_later, daemon=True).start()
            return self.send_json({"ok": True, "ep": ep})
        if path == "/api/gatus/delete":
            body = self.read_json()
            try:
                self.app.gatuscfg.delete(str(body.get("group", "")), str(body.get("name", "")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            log("gatus endpoint deleted by", user, body.get("group"), body.get("name"))
            # Gatus drops it on its next config poll (30-60 s); hide it until then
            self.app.gatus.forget(str(body.get("group", "")), str(body.get("name", "")))
            threading.Thread(target=self.app.refresh_gatus_later, daemon=True).start()
            return self.send_json({"ok": True})
        if path == "/api/dns/hidden":
            body = self.read_json()
            self.app.adguard.set_hidden(str(body.get("domain", ""))[:253], bool(body.get("hidden", True)))
            self.app.state.put("dns_top", self.app.adguard.global_tops())
            return self.send_json({"ok": True, "hidden": sorted(self.app.adguard.hidden)})
        if path.startswith("/api/adguard/"):
            body = self.read_json()
            ag = self.app.adguard
            try:
                what = path.rsplit("/", 1)[1]
                if what == "protection":
                    ag.set_protection(bool(body.get("enabled")))
                elif what == "filter":
                    if body.get("delete"):
                        ag.del_filter(str(body.get("url")))
                    elif body.get("add"):
                        ag.add_filter(str(body.get("name", "")), str(body.get("url", "")))
                    else:
                        ag.set_filter(str(body.get("url")), bool(body.get("enabled")))
                elif what == "refresh":
                    ag.refresh()
                elif what == "rules":
                    ag.set_rules(list(body.get("rules") or []))
                elif what == "domain":
                    ag.domain_rule(str(body.get("domain", "")), str(body.get("action", "")))
                else:
                    return self.send_json({"error": "not found"}, 404)
                ag.collect_api()
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("adguard action failed", path, traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("adguard", path, "by", user, json.dumps(body)[:200])
            return self.send_json({"ok": True, "filtering": ag.filtering()})
        if path.startswith("/api/unifi/"):
            body = self.read_json()
            u = self.app.unifi
            try:
                what = path.rsplit("/", 1)[1]
                if what == "wlan":
                    u.set_wlan(str(body.get("id", "")), body)
                    r = {"ok": True}
                elif what == "wlanpass":
                    r = {"ok": True, "pass": next((w["pass"] for w in u.wlans(with_pass=True) if w["id"] == body.get("id")), None)}
                elif what == "client":
                    r = {"ok": True, "result": u.sta_cmd(str(body.get("cmd")), str(body.get("mac")))}
                elif what == "device":
                    r = {"ok": True, "result": u.dev_cmd(str(body.get("cmd")), str(body.get("mac")))}
                else:
                    return self.send_json({"error": "not found"}, 404)
                u._wl_at = 0
                if what != "wlanpass":
                    u.collect()
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("unifi action failed", path, traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            if what != "wlanpass":
                log("unifi", path, "by", user, json.dumps({k: v for k, v in body.items() if k != "pass"})[:200])
            return self.send_json(r)
        if path == "/api/service":
            body = self.read_json()
            try:
                r = self.app.actions.service(str(body.get("id", "")), str(body.get("action", "")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("service", body, "by", user)
            return self.send_json({"ok": True, "result": r})
        m = re.fullmatch(r"/api/device/([0-9a-f:]{17})/(wol|static|block)", path)
        if m:
            body = self.read_json()
            act = self.app.actions
            try:
                if m.group(2) == "wol":
                    r = act.wol(m.group(1))
                elif m.group(2) == "static":
                    r = act.unstatic(m.group(1)) if body.get("remove") else act.static(
                        m.group(1), str(body.get("ip", "")), str(body.get("hostname", "")), str(body.get("descr", "")))
                else:
                    r = act.block(m.group(1), bool(body.get("on")))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            except Exception as e:
                log("device action failed", path, traceback.format_exc(limit=3))
                return self.send_json({"error": "Fehler: %s" % e}, 500)
            log("device", m.group(2), m.group(1), "by", user, json.dumps(body)[:120])
            return self.send_json(r)
        m = re.fullmatch(r"/api/device/([0-9a-f:]{17})", path)
        if m:
            body = self.read_json()
            fields = {k: (str(body[k])[:80] if body[k] else None) for k in ("name", "icon", "note") if k in body}
            if "place" in body:
                pl = body["place"]
                if pl and isinstance(pl, dict) and pl.get("kind") in ("switch", "via", "firewall"):
                    fields["place"] = {k: str(v)[:40] for k, v in pl.items() if k in ("kind", "port", "via_mac", "iface") and v}
                else:
                    fields["place"] = None
            self.app.devices.set_meta(m.group(1), **fields)
            self.app.devices.collect()
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)

    def fw_post(self, path, user):
        fw = self.app.fw
        body = self.read_json()
        try:
            if path == "/api/firewall/rule":
                r = {"uuid": fw.add(body.get("rule") or {})}
            elif path == "/api/firewall/rule/update":
                fw.update(str(body["uuid"]), body.get("rule") or {})
                r = {"ok": True}
            elif path == "/api/firewall/rule/delete":
                fw.delete(str(body["uuid"]))
                r = {"ok": True}
            elif path == "/api/firewall/rule/toggle":
                fw.toggle(str(body["uuid"]), bool(body.get("enabled")))
                r = {"ok": True}
            elif path == "/api/firewall/rule/move":
                fw.move(str(body["uuid"]), str(body["before"]))
                r = {"ok": True}
            elif path == "/api/firewall/apply":
                fw.apply()
                r = {"ok": True}
            elif path == "/api/firewall/confirm":
                fw.confirm()
                r = {"ok": True}
            elif path == "/api/firewall/revert":
                r = {"ok": True, "errors": fw.revert()}
            else:
                return self.send_json({"error": "not found"}, 404)
        except (ValueError, KeyError) as e:
            return self.send_json({"error": str(e), "txn": fw.txn()}, 400)
        except Exception as e:
            log("firewall action failed", path, traceback.format_exc(limit=3))
            return self.send_json({"error": "Fehler: %s" % e, "txn": fw.txn()}, 500)
        log("firewall", path, "by", user, json.dumps(body, default=str)[:300])
        r["txn"] = fw.txn()
        return self.send_json(r)

    def proxy_post(self, path, user):
        p = self.app.proxy
        if not p:
            return self.send_json({"error": "OPNsense-API ist nicht eingerichtet (Einstellungen → Integrationen)"}, 503)
        body = self.read_json()
        try:
            if path == "/api/proxy":
                r = p.create(body.get("domain"), body.get("host"), body.get("port"), bool(body.get("https")),
                             bool(body.get("websocket")), bool(body.get("rewrite", True)))
            elif path == "/api/proxy/update":
                r = p.update(str(body.get("uuid")), body.get("host"), body.get("port"), bool(body.get("https")),
                             bool(body.get("websocket")))
            elif path == "/api/proxy/delete":
                r = p.delete(str(body.get("uuid")), bool(body.get("rewrite", True)))
            elif path == "/api/proxy/rewrite":
                r = {"ok": p.add_rewrite(str(body.get("domain", "")).strip().lower())}
            else:
                return self.send_json({"error": "not found"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:
            log("proxy action failed", path, traceback.format_exc(limit=3))
            return self.send_json({"error": "Fehler: %s" % e}, 500)
        log("proxy", path, "by", user, json.dumps(body, default=str)[:200])
        return self.send_json(r)

    def login(self):
        ip = self.client_ip()
        if self.sessions.blocked(ip):
            return self.send_json({"error": "Zu viele Versuche, bitte 15 Minuten warten."}, 429)
        try:
            body = self.read_json()
        except Exception:
            return self.send_json({"error": "bad request"}, 400)
        user, pw = str(body.get("user", "")), str(body.get("pass", ""))
        if opnsense_auth(user, pw):
            tok = self.sessions.create(user, ip)
            log("login ok", user, ip)
            return self.send_json({"ok": True, "user": user}, headers={
                "Set-Cookie": "nd_s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Strict" % (tok, SESSION_DAYS * 86400)})
        self.sessions.failed(ip)
        log("login failed", user, ip)
        time.sleep(1)
        return self.send_json({"error": "Benutzername oder Passwort falsch (nur OPNsense-Admins)."}, 401)

    def api_get(self, path):
        user = self.user()
        if not user:
            return self.send_json({"error": "auth"}, 401)
        if path == "/api/me":
            return self.send_json({"user": user, "version": VERSION})
        if path == "/api/whoami":
            ip = self.client_ip()
            with self.app.devices.lock:
                mac = self.app.devices.ip2mac.get(ip)
            return self.send_json({"ip": ip, "mac": mac})
        if path == "/api/state":
            return self.send_json(self.app.build_full())
        if path == "/api/switch/vlaninfo":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                return self.send_json(self.app.switch.vlan_info((q.get("port") or [""])[0]))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        if path == "/api/adguard/filtering":
            return self.send_json(self.app.adguard.filtering())
        if path == "/api/firewall/rules":
            fw = self.app.fw
            return self.send_json({"rules": fw.rules(), "txn": fw.txn()})
        if path == "/api/firewall/options":
            return self.send_json(self.app.fw.options())
        if path == "/api/firewall/txn":
            return self.send_json(self.app.fw.txn())
        m = re.fullmatch(r"/api/firewall/rule/([0-9a-f-]{20,40})", path)
        if m:
            return self.send_json(self.app.fw.get(m.group(1)))
        if path == "/api/firewall/log":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            since = int((q.get("since") or ["0"])[0])
            fw = self.app.fw
            return self.send_json({"entries": fw.log_since(since), "seq": fw.seq, "stats": fw.log_stats()})
        if path == "/api/integrations":
            return self.send_json({"integrations": integrations.public(self.app.state.snapshot()["sources"])})
        if path.startswith("/api/proxy") and not self.app.proxy:
            return self.send_json({"error": "OPNsense-API ist nicht eingerichtet (Einstellungen → Integrationen)"}, 503)
        if path == "/api/proxy":
            ents = self.app.proxy.list()
            return self.send_json({"entries": ents, "suffix": self.app.proxy.suffix(ents), "answer": self.app.proxy.answer_ip})
        if path == "/api/proxy/health":
            ents = self.app.proxy.list()
            return self.send_json(self.app.proxy.health([e["domain"] for e in ents]))
        if path == "/api/gatus/endpoints":
            g = self.app.gatuscfg
            if not g.available():
                return self.send_json({"available": False, "endpoints": []})
            eps = g.load()
            return self.send_json({"available": True, "endpoints": eps,
                                   "groups": sorted({e.get("group") or "" for e in eps})})
        if path == "/api/history":
            return self.send_json({"interfaces": self.app.traffic.interface_history(),
                                   "cpu": list(self.app.system.cpu_hist)})
        m = re.fullmatch(r"/api/device/([0-9a-fA-F:]{17})", path)
        if m:
            d = self.app.device_detail(m.group(1))
            return self.send_json(d) if d else self.send_json({"error": "not found"}, 404)
        if path == "/api/events":
            return self.events()
        if path == "/api/diag/sources":
            return self.send_json({"sources": self.app.diag.sources()})
        if path == "/api/diag/check":
            q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()}
            try:
                argv, limit = self.app.diag.command(q)
                return self.send_json({"ok": True, "argv": argv, "limit": limit})
            except ValueError as e:
                return self.send_json({"ok": False, "error": str(e)})
        if path == "/api/diag/run":
            return self.diag_run(user)
        if path == "/api/unraid/zfs":
            try:
                return self.send_json(self.app.unraid.zfs(force="force=1" in (urllib.parse.urlparse(self.path).query or "")))
            except Exception as e:
                return self.send_json({"error": str(e)[:200]}, 502)
        if path == "/api/diag/speedtest":
            return self.send_json(self.app.diag.speedtest_info())
        m = re.fullmatch(r"/api/diag/pcap/([0-9a-f]{32})", path)
        if m:
            c = self.app.diag.pcap(m.group(1))
            if not c:
                return self.send_json({"error": "Mitschnitt nicht mehr vorhanden"}, 404)
            data = open(c["path"], "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.tcpdump.pcap")
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % c["name"])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        return self.send_json({"error": "not found"}, 404)

    def diag_run(self, user):
        q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()}
        try:
            self.app.diag.command(q)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        log("diag", user, json.dumps(q)[:200])
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def emit(ev, data):
            self.wfile.write(("event: %s\ndata: %s\n\n" % (ev, json.dumps(data))).encode())
            self.wfile.flush()

        def write(line):
            emit("line", line)
        try:
            try:
                code, extra = self.app.diag.stream(q, write, emit)
            except ValueError as e:
                write("Fehler: %s" % e)
                code, extra = 1, {}
            self.wfile.write(("event: done\ndata: %s\n\n" % json.dumps({"code": code, **extra})).encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        tick = 0
        try:
            while True:
                if tick % 5 == 0:
                    ev, data = "full", self.app.build_full()
                else:
                    ev, data = "fast", self.app.build_fast()
                payload = json.dumps(data, separators=(",", ":"), default=str)
                self.wfile.write(("event: %s\ndata: %s\n\n" % (ev, payload)).encode())
                self.wfile.flush()
                tick += 1
                time.sleep(2)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def static(self, path):
        rel = os.path.normpath(urllib.parse.unquote(path)).lstrip("/")
        full = os.path.join(WWW, rel)
        if not full.startswith(WWW) or not os.path.isfile(full):
            full = os.path.join(WWW, "index.html")
        if not os.path.isfile(full):
            body = b"netdash: frontend not installed"
            self.send_response(503)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        with open(full, "rb") as f:
            body = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "/assets/" in full:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(body)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        import ssl
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, TimeoutError, ssl.SSLError)):
            return
        super().handle_error(request, client_address)


def main():
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("image/svg+xml", ".svg")
    mimetypes.add_type("font/woff2", ".woff2")
    app = App()
    app.start()
    Handler.app = app
    Handler.sessions = Sessions(app.db)
    conf = load_conf()
    addr = (listen_addr(conf), int(conf["port"]))
    srv = Server(addr, Handler)
    if conf.get("tls"):
        # handshake happens in the handler thread, so a slow client cannot block accept()
        srv.socket = tls_context().wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    log("netdash %s listening on %s://%s:%d" % (VERSION, "https" if conf.get("tls") else "http", *addr))
    srv.serve_forever()


if __name__ == "__main__":
    main()
