"""Collectors for APIs: OPNsense, AdGuard (API + query log), Gatus, UniFi, Unraid, NetBird."""
import base64
import collections
import re
import datetime
import http.cookiejar
import json
import os
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from store import now, hour_of

INSECURE = ssl.create_default_context()
INSECURE.check_hostname = False
INSECURE.verify_mode = ssl.CERT_NONE


def http_json(url, method="GET", data=None, headers=None, timeout=10, opener=None, ctx=None):
    body = None
    h = {"Accept": "application/json"}
    if headers:
        h.update(headers)
    if data is not None:
        body = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    if opener:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read()
    else:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read()
    return json.loads(raw) if raw else None


def local_gui_url():
    """address of the local web GUI from config.xml (protocol and port as configured)"""
    import xml.etree.ElementTree as ET
    try:
        w = ET.parse("/conf/config.xml").getroot().find("system/webgui")
        proto = (w.findtext("protocol") or "https").strip()
        port = (w.findtext("port") or "").strip()
    except (OSError, ET.ParseError, AttributeError):
        proto, port = "https", ""
    return "%s://127.0.0.1%s" % (proto, ":" + port if port else "")


class OPNsense:
    def __init__(self, state, cfg):
        self.state = state
        self.url = (cfg.get("url") or local_gui_url()).rstrip("/")
        # the local GUI usually has a self-signed certificate
        host = urllib.parse.urlparse(self.url).hostname or ""
        self.ctx = INSECURE if host in ("127.0.0.1", "localhost", "::1") else None
        self.auth = "Basic " + base64.b64encode(("%s:%s" % (cfg.get("key", ""), cfg.get("secret", ""))).encode()).decode()

    def get(self, path, timeout=15):
        return http_json(self.url + path, headers={"Authorization": self.auth}, timeout=timeout, ctx=self.ctx)

    def post(self, path, data=None, timeout=30):
        return http_json(self.url + path, method="POST", data=data if data is not None else {},
                         headers={"Authorization": self.auth}, timeout=timeout, ctx=self.ctx)

    def collect_fast(self):
        gw = self.get("/api/routes/gateway/status")
        self.state.put("gateways", gw.get("items", []))

    def collect_services(self):
        svc = self.get("/api/core/service/search?rowCount=-1")
        self.state.put("services", svc.get("rows", []))

    def collect_wireguard(self):
        wg = self.get("/api/wireguard/service/show")
        self.state.put("wireguard", wg.get("rows", []))

    def collect_slow(self):
        info = self.get("/api/interfaces/overview/interfaces_info")
        rows = []
        for r in info.get("rows", []):
            rows.append({k: r.get(k) for k in ("device", "description", "identifier", "status", "media", "macaddr",
                                               "ipv4", "ipv6", "gateways", "routes", "enabled", "is_physical",
                                               "link_type", "addr4", "addr6", "vlan_tag", "mtu")})
        self.state.put("ifinfo", rows)
        # version info locally: /api/core/firmware/info makes pkg query every repository (DNS + HTTPS each call)
        try:
            out = subprocess.run(["opnsense-version", "-O"], capture_output=True, text=True, timeout=10).stdout
            self.state.put("firmware", {"product": json.loads(out)})
        except Exception:
            pass


BLOCK_REASONS = {3, 4, 5, 6, 8}   # blacklist, safebrowsing, parental, invalid, blocked service


def _ts(s):
    # "2026-11-18T18:29:10.127228212+01:00" -> epoch (sub-second precision not needed)
    try:
        return datetime.datetime.fromisoformat(s[:19] + s[-6:]).timestamp()
    except Exception:
        return None


class AdGuard:
    """Per-device DNS from the query log file (incremental), totals from the AdGuard API."""

    QDIR = "/usr/local/AdGuardHome/data"

    def __init__(self, state, db, devices, acc_dns, cfg):
        self.state = state
        self.db = db
        self.devices = devices
        self.acc = acc_dns
        self.cfg = cfg
        self.auth = self.make_auth(cfg)
        self.lock = threading.Lock()
        self.recent = collections.defaultdict(lambda: collections.deque(maxlen=300))
        self.hourly = collections.defaultdict(dict)   # key -> hour -> [q, b, Counter(domains), Counter(blocked)]
        self.last_ts = self.db.kv_get("dns_last_ts", 0)
        self.pos = None
        self.bootstrapped = False
        self.hidden = set(self.db.kv_get("dns_hidden", []))
        self.tops_at = 0

    # ---- hidden domains (only hidden from lists, still counted)
    def is_hidden(self, dom):
        if dom in self.hidden:
            return True
        for h in self.hidden:
            if h.startswith("*.") and (dom == h[2:] or dom.endswith(h[1:])):
                return True
        return False

    def set_hidden(self, dom, hide):
        dom = dom.strip().lower().rstrip(".")
        if not dom:
            return
        if hide:
            self.hidden.add(dom)
        else:
            self.hidden.discard(dom)
        self.db.kv_set("dns_hidden", sorted(self.hidden))
        self.tops_at = 0

    def _top(self, counter, n):
        out = []
        for d, c in counter.most_common(n + 200):
            if not self.is_hidden(d):
                out.append((d, c))
                if len(out) >= n:
                    break
        return out

    @staticmethod
    def make_auth(cfg):
        if not cfg or not cfg.get("user"):
            return None
        return "Basic " + base64.b64encode(("%s:%s" % (cfg["user"], cfg.get("pass", ""))).encode()).decode()

    def set_cfg(self, cfg):
        self.cfg = cfg
        self.auth = self.make_auth(cfg)

    def api(self, path):
        return http_json(self.cfg["url"].rstrip("/") + path, headers={"Authorization": self.auth}, timeout=15)

    def _key(self, ip):
        with self.devices.lock:
            mac = self.devices.ip2mac.get(ip)
        return mac or ("ip:" + ip)

    def _line(self, raw, persist):
        try:
            e = json.loads(raw)
        except ValueError:
            return
        ts = _ts(e.get("T", ""))
        if ts is None:
            return
        ip = e.get("IP", "")
        key = self._key(ip)
        res = e.get("Result") or {}
        reason = res.get("Reason", 0) or 0
        blocked = bool(res.get("IsFiltered")) and reason in BLOCK_REASONS
        dom = (e.get("QH") or "").rstrip(".")
        h = hour_of(ts)
        with self.lock:
            b = self.hourly[key].get(h)
            if b is None:
                b = self.hourly[key][h] = [0, 0, collections.Counter(), collections.Counter()]
            b[0] += 1
            if blocked:
                b[1] += 1
                b[3][dom] += 1
            b[2][dom] += 1
            self.recent[key].append((int(ts), dom, e.get("QT"), blocked, ip))
        if persist and ts > self.last_ts:
            self.acc.add(key, ts, 1, 1 if blocked else 0)
            self.last_ts = ts

    def _read_from(self, path, offset, persist):
        with open(path, "rb") as f:
            f.seek(offset)
            data = f.read()
        end = data.rfind(b"\n")
        if end < 0:
            return offset
        for raw in data[:end].split(b"\n"):
            if raw:
                self._line(raw, persist)
        return offset + end + 1

    def _bootstrap(self):
        cur = os.path.join(self.QDIR, "querylog.json")
        old = cur + ".1"
        horizon = now() - 86400
        # tail of the rotated file back to 24 h, read in 8 MB chunks from the end
        if os.path.exists(old):
            size = os.path.getsize(old)
            pos = size
            chunks = []
            while pos > 0:
                step = min(8 << 20, pos)
                pos -= step
                with open(old, "rb") as f:
                    f.seek(pos)
                    chunk = f.read(step)
                chunks.append(chunk)
                nl = chunk.find(b"\n")
                first = chunk[nl + 1:chunk.find(b"\n", nl + 1)] if nl >= 0 else b""
                try:
                    ft = _ts(json.loads(first).get("T", ""))
                except Exception:
                    ft = None
                if ft and ft < horizon:
                    break
            data = b"".join(reversed(chunks))
            if pos > 0:
                data = data[data.find(b"\n") + 1:]
            for raw in data.split(b"\n"):
                if raw:
                    self._line(raw, persist=True)
        st = os.stat(cur)
        self.pos = (st.st_ino, self._read_from(cur, 0, persist=True))
        self.bootstrapped = True

    def collect_log(self):
        cur = os.path.join(self.QDIR, "querylog.json")
        if not self.bootstrapped:
            self._bootstrap()
        else:
            st = os.stat(cur)
            ino, off = self.pos
            if st.st_ino != ino:
                old = cur + ".1"
                if os.path.exists(old) and os.stat(old).st_ino == ino:
                    self._read_from(old, off, persist=True)
                off = 0
            elif st.st_size < off:
                off = 0
            self.pos = (st.st_ino, self._read_from(cur, off, persist=True))
        self.db.kv_set("dns_last_ts", self.last_ts)
        self._prune()
        self.state.put("dns_clients", self.summary())
        if now() - self.tops_at > 30:
            self.state.put("dns_top", self.global_tops())
            self.tops_at = now()

    def _prune(self):
        cut = hour_of(now()) - 24 * 3600
        with self.lock:
            for key in list(self.hourly):
                hb = self.hourly[key]
                for h in [h for h in hb if h < cut]:
                    del hb[h]
                if not hb:
                    del self.hourly[key]
                    self.recent.pop(key, None)

    def summary(self):
        out = {}
        with self.lock:
            for key, hb in self.hourly.items():
                q = sum(b[0] for b in hb.values())
                bl = sum(b[1] for b in hb.values())
                last = self.recent[key][-1][0] if self.recent.get(key) else None
                out[key] = {"q24": q, "b24": bl, "last": last}
        return out

    def device_detail(self, key, top=15):
        with self.lock:
            hb = self.hourly.get(key, {})
            doms = collections.Counter()
            blk = collections.Counter()
            hours = []
            for h in sorted(hb):
                b = hb[h]
                doms.update(b[2])
                blk.update(b[3])
                hours.append({"hour": h, "q": b[0], "b": b[1]})
            recent = list(self.recent.get(key, []))[-100:]
        return {
            "top": self._top(doms, top),
            "top_blocked": self._top(blk, top),
            "hours": hours,
            "recent": [{"t": r[0], "domain": r[1], "type": r[2], "blocked": r[3], "ip": r[4]}
                       for r in reversed(recent) if not self.is_hidden(r[1])],
        }

    def global_tops(self, n=25):
        doms = collections.Counter()
        blk = collections.Counter()
        clients = collections.Counter()
        cblk = collections.Counter()
        with self.lock:
            for key, hb in self.hourly.items():
                for b in hb.values():
                    doms.update(b[2])
                    blk.update(b[3])
                    clients[key] += b[0]
                    cblk[key] += b[1]
        return {
            "domains": self._top(doms, n),
            "blocked": self._top(blk, n),
            "clients": [(k, c, cblk[k]) for k, c in clients.most_common(n)],
            "unique": len(doms),
            "hidden": sorted(self.hidden),
        }

    # ---- settings
    def post(self, path, data):
        req = urllib.request.Request(self.cfg["url"].rstrip("/") + path, data=json.dumps(data).encode(), method="POST",
                                     headers={"Authorization": self.auth, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read().decode("utf-8", "replace")

    def filtering(self):
        d = self.api("/control/filtering/status")
        st = self.api("/control/status")
        return {"enabled": d.get("enabled"), "interval": d.get("interval"), "protection": st.get("protection_enabled"),
                "filters": [{"id": f["id"], "name": f.get("name"), "url": f.get("url"), "enabled": f.get("enabled"),
                             "rules": f.get("rules_count"), "updated": f.get("last_updated")} for f in d.get("filters") or []],
                "user_rules": [r for r in d.get("user_rules") or [] if r.strip()]}

    def set_protection(self, on):
        self.post("/control/protection", {"enabled": bool(on)})

    def set_filter(self, url, enabled):
        f = next((x for x in self.filtering()["filters"] if x["url"] == url), None)
        if not f:
            raise ValueError("Filterliste unbekannt")
        self.post("/control/filtering/set_url", {"url": url, "whitelist": False,
                                                 "data": {"name": f["name"], "url": url, "enabled": bool(enabled)}})

    def add_filter(self, name, url):
        if not re.match(r"^https?://", url or ""):
            raise ValueError("URL muss mit http(s):// beginnen")
        self.post("/control/filtering/add_url", {"name": name[:60] or url, "url": url, "whitelist": False})

    def del_filter(self, url):
        self.post("/control/filtering/remove_url", {"url": url, "whitelist": False})

    def refresh(self):
        return self.post("/control/filtering/refresh", {"whitelist": False})

    def set_rules(self, rules):
        rules = [str(r).strip()[:300] for r in rules if str(r).strip()][:2000]
        self.post("/control/filtering/set_rules", {"rules": rules})

    def domain_rule(self, domain, action):
        """block: ||d^   allow: @@||d^$important   remove: drop both"""
        domain = (domain or "").strip().lower().rstrip(".")
        if not re.fullmatch(r"(\*\.)?[a-z0-9_.-]+\.[a-z0-9-]+", domain):
            raise ValueError("Ungültige Domain")
        d = domain[2:] if domain.startswith("*.") else domain
        block, allow = "||%s^" % d, "@@||%s^$important" % d
        rules = [r for r in self.filtering()["user_rules"] if r not in (block, allow, "@@||%s^" % d)]
        if action == "block":
            rules.append(block)
        elif action == "allow":
            rules.append(allow)
        self.set_rules(rules)

    def collect_api(self):
        if not self.cfg:
            return
        st = self.api("/control/stats")
        status = self.api("/control/status")
        clients = self.api("/control/clients")
        self.state.put("adguard", {
            "protection": status.get("protection_enabled"),
            "version": status.get("version"),
            "running": status.get("running"),
            "queries": st.get("num_dns_queries"),
            "blocked": st.get("num_blocked_filtering"),
            "avg_ms": round((st.get("avg_processing_time") or 0) * 1000, 1),
            "series_q": st.get("dns_queries", []),
            "series_b": st.get("blocked_filtering", []),
            "top_domains": [list(d.items())[0] for d in st.get("top_queried_domains", [])[:10]],
            "top_blocked": [list(d.items())[0] for d in st.get("top_blocked_domains", [])[:10]],
            "top_clients": [list(d.items())[0] for d in st.get("top_clients", [])[:10]],
            "clients": [{"name": c.get("name"), "ids": c.get("ids", [])} for c in (clients.get("clients") or [])],
        })


class Gatus:
    def __init__(self, state, url=""):
        self.state = state
        self.url = (url or "").rstrip("/")
        self.gone = {}   # (group, name) -> ts: deleted/renamed in netdash, Gatus has not reloaded yet

    def forget(self, group, name):
        self.gone[(group or "", name)] = time.time()
        cur = self.state.get("gatus") or []
        self.state.put("gatus", [g for g in cur if ((g.get("group") or ""), g.get("name")) != ((group or ""), name)])

    def collect(self):
        if not self.url:
            self.state.fail("gatus", "not configured")
            return
        data = http_json(self.url + "/api/v1/endpoints/statuses?page=1&pageSize=100", timeout=10)
        present = {((ep.get("group") or ""), ep.get("name")) for ep in data or []}
        for k, ts in list(self.gone.items()):
            if k not in present or time.time() - ts > 600:
                del self.gone[k]
        out = []
        for ep in data or []:
            if ((ep.get("group") or ""), ep.get("name")) in self.gone:
                continue
            res = ep.get("results") or []
            last = res[-1] if res else {}
            ok = sum(1 for r in res if r.get("success"))
            out.append({
                "key": ep.get("key"), "name": ep.get("name"), "group": ep.get("group"),
                "ok": bool(last.get("success")) if res else None,
                "uptime": round(100.0 * ok / len(res), 1) if res else None,
                "ms": round(last.get("duration", 0) / 1e6) if last else None,
                "hist": [bool(r.get("success")) for r in res[-30:]],
                "t": last.get("timestamp"),
                "errors": last.get("errors"),
            })
        self.state.put("gatus", out)


class UniFi:
    """UniFi OS Network API (classic endpoints) with a local service account."""

    def __init__(self, state, devices, cfg):
        self.state = state
        self.devices = devices
        self.cfg = cfg or {}
        self.base = (self.cfg.get("url") or "").rstrip("/")
        self.site = self.cfg.get("site", "default")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=INSECURE),
                                                  urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None
        self.logged_in = False

    def enabled(self):
        return bool(self.cfg.get("user") and self.cfg.get("pass"))

    def _login(self):
        req = urllib.request.Request(self.base + "/api/auth/login", method="POST",
                                     data=json.dumps({"username": self.cfg["user"], "password": self.cfg["pass"],
                                                      "rememberMe": True}).encode(),
                                     headers={"Content-Type": "application/json", "Accept": "application/json"})
        with self.opener.open(req, timeout=15) as r:
            self.csrf = r.headers.get("X-CSRF-Token") or r.headers.get("X-Updated-CSRF-Token")
            r.read()
        self.logged_in = True

    def call(self, path, method="GET", data=None):
        if not self.logged_in:
            self._login()
        h = {}
        if self.csrf:
            h["X-CSRF-Token"] = self.csrf
        try:
            return http_json(self.base + "/proxy/network" + path, method=method, data=data, headers=h,
                             opener=self.opener, timeout=15)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                self.logged_in = False
                self._login()
                if self.csrf:
                    h["X-CSRF-Token"] = self.csrf
                return http_json(self.base + "/proxy/network" + path, method=method, data=data, headers=h,
                                 opener=self.opener, timeout=15)
            raise

    def system(self):
        """UniFi OS itself (not the Network app): versions of the OS and its apps, latest firmware"""
        if not self.logged_in:
            self._login()
        try:
            return http_json(self.base + "/api/system", headers={"X-CSRF-Token": self.csrf or ""}, opener=self.opener, timeout=15)
        except urllib.error.HTTPError as e:
            if e.code not in (401, 403):
                raise
            self._login()
            return http_json(self.base + "/api/system", headers={"X-CSRF-Token": self.csrf or ""}, opener=self.opener, timeout=15)

    # ---- settings
    def wlans(self, with_pass=False):
        out = []
        for w in self.call("/api/s/%s/rest/wlanconf" % self.site).get("data", []):
            out.append({"id": w["_id"], "name": w.get("name"), "enabled": w.get("enabled"), "hidden": w.get("hide_ssid"),
                        "security": w.get("security"), "wpa": w.get("wpa_mode"), "bands": w.get("wlan_bands"),
                        "guest": w.get("is_guest"), "pass": w.get("x_passphrase") if with_pass else None,
                        "has_pass": bool(w.get("x_passphrase"))})
        return out

    def set_wlan(self, wid, fields):
        if not re.fullmatch(r"[0-9a-f]{24}", wid or ""):
            raise ValueError("Ungültige WLAN-ID")
        body = {}
        if "enabled" in fields:
            body["enabled"] = bool(fields["enabled"])
        if "hidden" in fields:
            body["hide_ssid"] = bool(fields["hidden"])
        if fields.get("name"):
            n = str(fields["name"]).strip()
            if not 1 <= len(n.encode()) <= 32:
                raise ValueError("SSID: 1 bis 32 Zeichen")
            body["name"] = n
        if fields.get("pass"):
            p = str(fields["pass"])
            if not 8 <= len(p) <= 63:
                raise ValueError("WLAN-Passwort: 8 bis 63 Zeichen")
            body["x_passphrase"] = p
        if not body:
            raise ValueError("Nichts zu ändern")
        r = self.call("/api/s/%s/rest/wlanconf/%s" % (self.site, wid), method="PUT", data=body)
        if (r or {}).get("meta", {}).get("rc") != "ok":
            raise RuntimeError("UniFi: %s" % (r or {}).get("meta"))

    def sta_cmd(self, cmd, mac):
        if cmd not in ("kick-sta", "block-sta", "unblock-sta"):
            raise ValueError("Unbekannter Befehl")
        return self.call("/api/s/%s/cmd/stamgr" % self.site, method="POST", data={"cmd": cmd, "mac": mac.lower()})

    def dev_cmd(self, cmd, mac):
        if cmd not in ("restart", "set-locate", "unset-locate"):
            raise ValueError("Unbekannter Befehl")
        return self.call("/api/s/%s/cmd/devmgr" % self.site, method="POST", data={"cmd": cmd, "mac": mac.lower()})

    def blocked_clients(self):
        try:
            rows = self.call("/api/s/%s/rest/user" % self.site).get("data", [])
            return {r["mac"] for r in rows if r.get("blocked")}
        except Exception:
            return set()

    def collect(self):
        if not self.enabled():
            self.state.fail("unifi", "not configured")
            return
        sta = self.call("/api/s/%s/stat/sta" % self.site).get("data", [])
        dev = self.call("/api/s/%s/stat/device" % self.site).get("data", [])
        t = now()
        clients = {}
        extra = {}
        for c in sta:
            mac = (c.get("mac") or "").lower()
            if not mac:
                continue
            wired = bool(c.get("is_wired"))
            clients[mac] = {
                "wired": wired,
                "essid": c.get("essid"), "ap_mac": c.get("ap_mac"), "radio": c.get("radio"),
                "channel": c.get("channel"), "signal": c.get("signal"), "rssi": c.get("rssi"),
                "noise": c.get("noise"), "satisfaction": c.get("satisfaction"),
                "tx_rate": c.get("tx_rate"), "rx_rate": c.get("rx_rate"),
                "uptime": c.get("uptime"), "assoc_time": c.get("assoc_time") or c.get("latest_assoc_time"),
                "sw_mac": c.get("sw_mac"), "sw_port": c.get("sw_port"), "network": c.get("network"),
                "name": c.get("name"), "hostname": c.get("hostname"), "oui": c.get("oui"),
                "os": c.get("os_name"), "dev_cat": c.get("dev_cat"), "dev_family": c.get("dev_family"),
                "dev_vendor": c.get("dev_vendor"), "guest": c.get("is_guest"),
                "tx_bytes_r": c.get("tx_bytes-r"), "rx_bytes_r": c.get("rx_bytes-r"),
                "proto": c.get("radio_proto"), "ccq": c.get("ccq"),
            }
            extra[mac] = {"online": True, "seen": c.get("last_seen") or t, "name": c.get("name"),
                          "hostname": c.get("hostname"), "vendor": c.get("oui") or None}
        self.devices.extra = extra
        devices = []
        for d in dev:
            devices.append({
                "mac": d.get("mac"), "name": d.get("name") or d.get("model"), "model": d.get("model"),
                "type": d.get("type"), "state": d.get("state"), "ip": d.get("ip"), "version": d.get("version"),
                "uptime": d.get("uptime"), "clients": d.get("num_sta"),
                "cpu": (d.get("system-stats") or {}).get("cpu"), "mem": (d.get("system-stats") or {}).get("mem"),
                "upgradable": d.get("upgradable"), "upgrade_to": d.get("upgrade_to_firmware"), "satisfaction": d.get("satisfaction"),
                "radios": [{"radio": r.get("radio"), "channel": r.get("channel"), "cu": r.get("cu_total"),
                            "clients": r.get("num_sta"), "tx_power": r.get("tx_power")}
                           for r in d.get("radio_table_stats") or []],
                "ports": [{"idx": p.get("port_idx"), "name": p.get("name"), "up": p.get("up"), "speed": p.get("speed"),
                           "poe": p.get("poe_power")} for p in d.get("port_table") or []] if d.get("type") == "usw" else [],
            })
        now_t = time.time()
        if now_t - getattr(self, "_wl_at", 0) > 60:
            try:
                self._wl = self.wlans()
                self._blocked = self.blocked_clients()
            except Exception:
                self._wl, self._blocked = getattr(self, "_wl", []), getattr(self, "_blocked", set())
            self._wl_at = now_t
        self.state.put("unifi", {"clients": clients, "devices": devices, "wlans": self._wl,
                                 "blocked": sorted(self._blocked)})


UNRAID_Q = """{
  metrics { cpu { percentTotal } memory { total used available percentTotal swapTotal swapUsed } }
  info { os { uptime hostname } cpu { brand cores threads } }
  vars { version }
  array { state capacity { kilobytes { free used total } } disks { name size temp status fsSize fsUsed }
          caches { name size temp status fsSize fsUsed } }
  docker { containers { names state status autoStart image } }
}"""


UNRAID_ZFS_KEY = "/usr/local/netdash/unraid_ed25519"


class Unraid:
    def __init__(self, state, cfg):
        self.state = state
        self.cfg = cfg or {}
        self.zfs_cache = (0, None)

    def host(self):
        return urllib.parse.urlparse(self.cfg.get("url") or "").hostname

    def zfs(self, force=False):
        """pools + datasets via a restricted key (forced command on Unraid: zpool list; zfs list)"""
        t, d = self.zfs_cache
        if d and not force and time.time() - t < 60:
            return d
        if not os.path.exists(UNRAID_ZFS_KEY) or not self.host():
            raise RuntimeError("ZFS-Zugang zu Unraid ist nicht eingerichtet")
        p = subprocess.run(["ssh", "-i", UNRAID_ZFS_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
                            "-o", "StrictHostKeyChecking=accept-new", "root@" + self.host(), "zfs"],
                           capture_output=True, text=True, timeout=25)
        if "---" not in p.stdout:
            raise RuntimeError((p.stderr or "keine Antwort von Unraid").strip()[:200])
        head, _, body = p.stdout.partition("---")
        pools = {}
        for ln in head.strip().splitlines():
            n, size, alloc, free, frag, cap, health = ln.split("\t")
            pools[n] = {"name": n, "raw_size": int(size), "raw_alloc": int(alloc), "raw_free": int(free),
                        "frag": int(frag) if frag.isdigit() else None, "cap": int(cap), "health": health, "datasets": []}
        for ln in body.strip().splitlines():
            n, used, avail, refer, snap, child, ratio, quota, typ, mnt = ln.split("\t")
            pool = n.split("/")[0]
            if pool not in pools:
                continue
            pools[pool]["datasets"].append({
                "name": n, "used": int(used), "avail": int(avail), "refer": int(refer), "snap": int(snap),
                "child": int(child), "ratio": float(ratio), "quota": int(quota) or None, "type": typ,
                "mount": None if mnt in ("none", "-", "legacy") else mnt})
        for pl in pools.values():
            root = next((x for x in pl["datasets"] if x["name"] == pl["name"]), None)
            pl["used"] = root["used"] if root else pl["raw_alloc"]
            pl["total"] = (root["used"] + root["avail"]) if root else pl["raw_size"]
        d = {"t": int(time.time()), "pools": sorted(pools.values(), key=lambda x: -x["total"])}
        self.zfs_cache = (time.time(), d)
        return d

    def collect(self):
        if not self.cfg.get("key"):
            self.state.fail("unraid", "not configured")
            return
        r = http_json(self.cfg["url"], method="POST", data={"query": UNRAID_Q},
                      headers={"x-api-key": self.cfg["key"]}, timeout=15)
        if r.get("errors") and not r.get("data"):
            raise RuntimeError(r["errors"][0].get("message"))
        d = r["data"]
        pools = []
        for p in (d["array"].get("caches") or []) + (d["array"].get("disks") or []):
            pools.append({"name": p["name"], "size": p.get("size"), "temp": p.get("temp"), "status": p.get("status"),
                          "fs_size": p.get("fsSize"), "fs_used": p.get("fsUsed")})
        cont = []
        for c in d["docker"]["containers"] or []:
            cont.append({"name": (c.get("names") or ["?"])[0].lstrip("/"), "state": c.get("state"),
                         "status": c.get("status"), "auto": c.get("autoStart"), "image": c.get("image")})
        self.state.put("unraid", {
            "ip": self.host(), "zfs": os.path.exists(UNRAID_ZFS_KEY),
            "hostname": d["info"]["os"]["hostname"], "boot": d["info"]["os"]["uptime"],
            "version": (d.get("vars") or {}).get("version"),
            "cpu_model": d["info"]["cpu"]["brand"], "threads": d["info"]["cpu"]["threads"],
            "cpu": round(d["metrics"]["cpu"]["percentTotal"], 1),
            "mem": d["metrics"]["memory"],
            "array_state": d["array"]["state"],
            "pools": pools, "containers": sorted(cont, key=lambda c: c["name"].lower()),
        })


class NetBird:
    def __init__(self, state):
        self.state = state

    def collect(self):
        out = subprocess.run(["netbird", "status", "--json"], capture_output=True, text=True, timeout=15).stdout
        d = json.loads(out)
        peers = []
        for p in (d.get("peers") or {}).get("details") or []:
            hs = p.get("lastWireguardHandshake") or ""
            peers.append({
                "name": (p.get("fqdn") or "").split(".")[0], "fqdn": p.get("fqdn"), "ip": p.get("netbirdIp"),
                "status": p.get("status"), "type": p.get("connectionType"),
                "latency_ms": round((p.get("latency") or 0) / 1e6, 1),
                "rx": p.get("transferReceived"), "tx": p.get("transferSent"),
                "handshake": None if hs.startswith("0001") else hs,
                "since": p.get("lastStatusUpdate"),
            })
        self.state.put("netbird", {
            "ip": d.get("netbirdIp"), "fqdn": d.get("fqdn"),
            "management": (d.get("management") or {}).get("connected"),
            "signal": (d.get("signal") or {}).get("connected"),
            "version": d.get("daemonVersion"),
            "peers": sorted(peers, key=lambda p: (p["status"] != "Connected", p["name"])),
        })
