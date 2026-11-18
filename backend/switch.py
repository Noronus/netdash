"""Managed switch with the common Realtek web firmware (cgi/get.cgi?cmd=...).

Login: password RSA-encrypted (PKCS#1 v1.5) with the modulus from home_login, posted as the odd
Backbone body {"_ds=1&username=..&password=..&_de=1": {}}. The session is tied to the client.
"""
import base64
import http.cookiejar
import json
import re
import secrets
import threading
import time
import urllib.parse
import urllib.request


def _rsa_b64(msg, mod_hex, e=0x10001):
    n = int(mod_hex, 16)
    k = (n.bit_length() + 7) // 8
    m = msg.encode()
    if len(m) > k - 11:
        raise ValueError("password too long")
    pad = bytearray()
    while len(pad) < k - 3 - len(m):
        b = secrets.token_bytes(1)
        if b != b"\x00":
            pad += b
    em = b"\x00\x02" + bytes(pad) + b"\x00" + m
    c = pow(int.from_bytes(em, "big"), e, n)
    return base64.b64encode(c.to_bytes(k, "big")).decode()


def _lang(v):
    """"lang('port','txtMediaCopper',[2500])" -> "Kupfer 2500" style best-effort text"""
    if not isinstance(v, str) or not v.startswith("lang("):
        return v
    m = re.match(r"lang\('[^']*','([^']*)'(?:,\[([^\]]*)\])?\)", v)
    if not m:
        return v
    key, args = m.group(1), (m.group(2) or "")
    table = {"txtMediaCopper": "Kupfer %sM", "txtMediaFiber": "Glasfaser %sM", "txtMediaGCopper": "Kupfer %sG",
             "txtMediaGFiber": "Glasfaser %sG", "lblAuto": "Auto",
             "txtDuplexFull": "Voll", "txtDuplexHalf": "Halb", "txtDisabled": "aus", "txtEnabled": "an",
             "lblMacAddr": "MAC", "lblLocal": "lokal", "txtSysUptimeArg": "%s T %s Std %s Min"}
    fmt = table.get(key, key)
    parts = [a.strip().strip("'\"") for a in args.split(",")] if args else []
    try:
        return fmt % tuple(parts[: fmt.count("%s")]) if "%s" in fmt else fmt
    except TypeError:
        return fmt


def _speed_key(v):
    """"lang('port','lblAuto')" -> auto, "lang('port','lblAutoCapArg',['1000M'])" -> auto_1000, "1000" -> 1000"""
    s = str(v or "")
    if "lblAutoCapArg" in s:
        m = re.search(r"\['(\d+)([MG])", s)
        return "auto_%s" % (int(m.group(1)) * (1000 if m.group(2) == "G" else 1)) if m else "auto"
    if "lblAuto" in s:
        return "auto"
    if "Full" in s:
        return "full"
    if "Half" in s:
        return "half"
    m = re.match(r"(\d+)", s)
    return m.group(1) if m else "auto"


def _norm_mac(m):
    return (m or "").strip().lower()


class Switch:
    def __init__(self, state, devices, cfg):
        self.state = state
        self.devices = devices
        self.cfg = cfg or {}
        self.base = (self.cfg.get("url") or "").rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.logged_in = 0
        self.lock = threading.Lock()
        self.sticky = {}
        self.unsaved = False

    def enabled(self):
        return bool(self.base and self.cfg.get("user") and self.cfg.get("pass"))

    def _get_raw(self, cmd):
        with self.op.open("%s/cgi/get.cgi?cmd=%s&dummy=%d" % (self.base, cmd, time.time() * 1000), timeout=12) as r:
            return json.loads(r.read().decode("utf-8", "replace"))

    def login(self):
        info = self._get_raw("home_login")["data"]
        pw = _rsa_b64(self.cfg["pass"], info["modulus"])
        form = "_ds=1&" + urllib.parse.urlencode({"username": self.cfg["user"], "password": pw}) + "&_de=1"
        req = urllib.request.Request(self.base + "/cgi/set.cgi?cmd=home_loginAuth&dummy=%d" % (time.time() * 1000),
                                     data=json.dumps({form: {}}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"})
        with self.op.open(req, timeout=12) as r:
            r.read()
        for _ in range(10):
            st = self._get_raw("home_loginStatus").get("data", {})
            if st.get("status") == "fail":
                raise PermissionError("Switch-Login abgelehnt")
            if st.get("status") == "ok":
                break
            # some firmwares stay in "authing" but already accept requests
            try:
                if "data" in self._get_raw("sys_sysinfo"):
                    break
            except Exception:
                pass
            time.sleep(1)
        self.logged_in = time.time()

    def get(self, cmd):
        with self.lock:
            if not self.logged_in or time.time() - self.logged_in > 600:
                self.login()
            try:
                d = self._get_raw(cmd)
            except (json.JSONDecodeError, urllib.error.HTTPError):
                self.login()
                d = self._get_raw(cmd)
            if not isinstance(d, dict) or "data" not in d:
                self.login()
                d = self._get_raw(cmd)
            return d.get("data", {})

    def sysinfo(self):
        return self.get("sys_sysinfo")

    def _set(self, cmd, fields):
        form = "_ds=1&" + urllib.parse.urlencode(fields) + "&_de=1"
        with self.lock:
            if not self.logged_in or time.time() - self.logged_in > 600:
                self.login()
            req = urllib.request.Request("%s/cgi/set.cgi?cmd=%s&dummy=%d" % (self.base, cmd, time.time() * 1000),
                                         data=json.dumps({form: {}}).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"})
            with self.op.open(req, timeout=15) as r:
                raw = r.read().decode("utf-8", "replace")
        try:
            res = json.loads(raw)
        except ValueError:
            raise RuntimeError("Switch-Antwort unlesbar: %s" % raw[:120])
        if res.get("status") != "ok":
            raise RuntimeError("Switch lehnt ab: %s" % (res.get("msg") or res.get("msgType")))
        self.unsaved = True
        return res

    def set_port(self, name, descr, enabled, speed="auto", duplex="auto", flow="disable"):
        if not re.fullmatch(r"(MGE|TE|GE|XE)\d{1,2}", name or ""):
            raise ValueError("Ungültiger Port")
        descr = (descr or "")[:32]
        if not re.fullmatch(r"[A-Za-z0-9 ._@()/+-]*", descr):
            raise ValueError("Beschreibung: nur Buchstaben, Ziffern, Leerzeichen und . _ - ( ) / + @")
        f = {"portList": name, "descp": descr}
        if enabled:
            f["adminStatus"] = "on"
        f.update(adminSpeed=speed or "auto", adminDuplex=duplex or "auto", adminFlowCtrl=flow or "disable")
        r = self._set("port_portEdit", f)
        self.save_config()   # persist right away, otherwise a switch reboot would undo it
        return r

    def _port_index(self, name):
        st = self.state.get("switch") or {}
        for p in st.get("ports", []):
            if p["name"] == name:
                return p["idx"]
        raise ValueError("Port unbekannt")

    def vlan_info(self, name):
        idx = self._port_index(name)
        d = self.get("vlan_membershipEdit&port=%d" % idx)
        sel = d.get("selVlans") or []
        untagged = next((int(re.match(r"\d+", v).group()) for v in sel if "U" in v), None)
        tagged = sorted(int(re.match(r"\d+", v).group()) for v in sel if v.endswith("T"))
        allv = sorted(set(int(x) for x in d.get("vlans") or []) | {int(re.match(r"\d+", v).group()) for v in sel if re.match(r"\d+", v)})
        return {"port": name, "mode": d.get("mode"), "all": allv, "untagged": untagged, "tagged": tagged, "raw": sel}

    def set_vlans(self, name, untagged, tagged):
        info = self.vlan_info(name)
        if info["mode"] not in (1, 2):
            raise ValueError("Port-Modus %s wird nicht unterstützt (nur Access/Trunk)" % info["mode"])
        allv = set(info["all"])
        untagged = int(untagged)
        tagged = sorted({int(t) for t in tagged} - {untagged})
        if untagged not in allv or any(t not in allv for t in tagged):
            raise ValueError("VLAN existiert auf dem Switch nicht")
        if info["mode"] == 1 and tagged:
            raise ValueError("Access-Port kann keine tagged VLANs haben")
        vals = ["%dUP" % untagged] + ["%dT" % t for t in tagged]
        form = [("port", str(self._port_index(name)))] + [("A", v) for v in vals]
        self._set_list("vlan_membershipEdit", form)
        self.save_config()
        return self.vlan_info(name)

    def _set_list(self, cmd, pairs):
        form = "_ds=1&" + urllib.parse.urlencode(pairs) + "&_de=1"
        with self.lock:
            if not self.logged_in or time.time() - self.logged_in > 600:
                self.login()
            req = urllib.request.Request("%s/cgi/set.cgi?cmd=%s&dummy=%d" % (self.base, cmd, time.time() * 1000),
                                         data=json.dumps({form: {}}).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest"})
            with self.op.open(req, timeout=15) as r:
                res = json.loads(r.read().decode("utf-8", "replace"))
        if res.get("status") != "ok":
            raise RuntimeError("Switch lehnt ab: %s" % (res.get("msg") or res.get("msgType")))
        self.unsaved = True

    def poll_links(self):
        """fast poll between full collects: link state and speed only (one request)"""
        if not self.enabled() or not self.state.get("switch"):
            return
        panel = self.get("panel_info").get("ports", [])
        st = self.state.get("switch")  # read after the request, so a full collect in between is not overwritten
        ports = []
        changed = False
        for p in st.get("ports", []):
            pp = panel[p["idx"]] if p["idx"] < len(panel) else None
            if pp is None:
                ports.append(p)
                continue
            up = bool(pp.get("linkup"))
            speed = int(pp["speed"]) if str(pp.get("speed", "")).isdigit() else None
            if up != p["up"] or speed != p["speed"]:
                changed = True
                p = dict(p, up=up, speed=speed)
            ports.append(p)
        if changed:
            self.state.put("switch", dict(st, ports=ports))

    def save_config(self):
        r = self._set("home_save", {"empty": "1"})
        self.unsaved = False
        return r

    def collect(self):
        if not self.enabled():
            self.state.fail("switch", "not configured")
            return
        info = self.sysinfo()
        panel = self.get("panel_info").get("ports", [])
        ports_cfg = self.get("port_port").get("ports", [])
        macs = self.get("mac_dynamic").get("entries", [])
        lldp = self.get("lldp_neighbor").get("neighbors", [])
        vl = self.get("vlan_membership").get("ports", [])
        try:
            bw = self.get("port_bwutilz").get("ports", [])
        except Exception:
            bw = []

        # port index -> name, from the MAC table keys ("<MAC>_<vlan>_<index>")
        names = {}
        for m in macs:
            k = str(m.get("key", "")).rsplit("_", 1)
            if len(k) == 2 and k[1].isdigit():
                names[int(k[1])] = m.get("port")
        n = max(len(panel), len(ports_cfg))
        # fill gaps: copper ports are MGE1.., the rest TE1..
        mge = sum(1 for p in ports_cfg if "Copper" in str(p.get("type")) and "2500" in str(p.get("type")))
        for i in range(n):
            if i not in names:
                names[i] = ("MGE%d" % (i + 1)) if i < mge else ("TE%d" % (i - mge + 1))
        by_name = {v: k for k, v in names.items()}

        per_port = {}
        now_ts = time.time()
        live = set()
        for m in macs:
            mac = _norm_mac(m.get("macAddr"))
            live.add(mac)
            per_port.setdefault(m.get("port"), []).append({"mac": mac, "vlan": m.get("vlan")})
            self.sticky[mac] = (m.get("port"), m.get("vlan"), now_ts)
        # the switch forgets idle MACs after its aging time; remember the last port for 24 h
        for mac, (port, vlan, ts) in list(self.sticky.items()):
            if mac in live:
                continue
            if now_ts - ts > 86400:
                del self.sticky[mac]
                continue
            per_port.setdefault(port, []).append({"mac": mac, "vlan": vlan, "stale": int(ts)})
        lldp_by = {}
        for l in lldp:
            lldp_by.setdefault(l.get("localPort"), []).append({
                "name": l.get("sysName") or "", "mac": _norm_mac(l.get("chassisId") if ":" in str(l.get("chassisId")) else l.get("portId")),
                "port_id": l.get("portId")})

        ports = []
        for i in range(n):
            pn = names[i]
            pp = panel[i] if i < len(panel) else {}
            pc = ports_cfg[i] if i < len(ports_cfg) else {}
            v = vl[i] if i < len(vl) else {}
            b = bw[i] if i < len(bw) else {}
            ports.append({
                "idx": i, "name": pn, "descr": pc.get("descr") or pc.get("descp") or "",
                "up": bool(pp.get("linkup")), "speed": int(pp["speed"]) if str(pp.get("speed", "")).isdigit() else None,
                "media": pp.get("media") or ("fiber" if "Fiber" in str(pc.get("type")) else "copper"),
                "type": _lang(pc.get("type")), "admin": pc.get("adminStatus", True),
                "form": "sfp" if "Fiber" in str(pc.get("type")) else "rj45",
                "admin_speed": _speed_key(pc.get("adminSpeed")), "admin_duplex": _speed_key(pc.get("adminDuplex")),
                "admin_flow": "enable" if "Enabled" in str(pc.get("adminFlowCtrl")) else ("auto" if "Auto" in str(pc.get("adminFlowCtrl")) else "disable"),
                "ten_gig": "10" in str(pc.get("type")) and "Fiber" in str(pc.get("type")) or "10000" in str(pc.get("type")),
                "vlans": v.get("operVlans") or v.get("adminVlans"), "vlan_mode": v.get("mode"),
                "lldp": lldp_by.get(pn, []), "macs": per_port.get(pn, []),
                "util": {k: b.get(k) for k in ("txRate", "rxRate", "txUtil", "rxUtil") if k in b} or None,
            })
        self.state.put("switch", {
            "name": self.cfg.get("name") or "Switch",
            "model": info.get("hostname"), "mac": _norm_mac(info.get("sysMac")), "ip": info.get("currIpv4"),
            "fw": info.get("fwVer"), "uptime": _lang(info.get("sysUpTime")), "serial": info.get("syssn"),
            "ports": ports, "unsaved": self.unsaved,
        })
