"""VPS integration (port forwards, WireGuard, interfaces) via a restricted SSH key.

The VPS runs the helper from extras/vps (forced command /usr/local/sbin/netdash-vps).
"""
import json
import re
import subprocess
import threading
import time

KEY = "/usr/local/netdash/vps_ed25519"
CM_PATH = "/tmp/netdash-vps.sock"  # one shared SSH connection (the interface poll runs every 10 s)


class VPS:
    def __init__(self, state, cfg):
        self.state = state
        self.cfg = cfg or {}
        self.lock = threading.Lock()
        self.history = []
        self.sink = None  # sink(name, t, drx, dtx, (rx_rate, tx_rate)) for totals + history
        self.prev_if = None

    def enabled(self):
        return bool(self.cfg.get("host"))

    def _base(self):
        return ["ssh", "-i", KEY, "-p", str(self.cfg.get("port") or 22), "-o", "BatchMode=yes",
                "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "-o", "ControlPath=" + CM_PATH]

    def _target(self):
        return "%s@%s" % (self.cfg.get("user") or "root", self.cfg["host"])

    def _master(self):
        """keep a background master connection; started with all stdio on /dev/null so nobody waits on it"""
        if subprocess.run(self._base() + ["-O", "check", self._target()], capture_output=True, timeout=5).returncode == 0:
            return
        try:
            subprocess.run(self._base() + ["-M", "-N", "-f", "-o", "ControlPersist=600", "-o", "ServerAliveInterval=30",
                                           self._target()], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=15)
        except subprocess.TimeoutExpired:
            pass

    def _ssh(self, cmd, inp=None, timeout=25):
        try:
            self._master()
        except Exception:
            pass  # falls back to a direct connection
        args = self._base() + ["-o", "ControlMaster=no", self._target(), cmd]
        p = subprocess.run(args, input=inp, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout or "").strip().splitlines()
        if not out:
            raise RuntimeError((p.stderr or "keine Antwort").strip()[:200])
        d = json.loads(out[-1])
        if isinstance(d, dict) and d.get("error"):
            raise ValueError(d["error"])
        return d

    def status(self):
        return self._ssh("status")

    def collect(self):
        if not self.enabled():
            self.state.fail("vps", "not configured")
            return
        d = self.status()
        d["name"] = self.cfg.get("name") or "VPS"
        d["history"] = self.history[:10]
        try:
            d["fw"] = self._ssh("fw-status")
        except Exception as e:
            d["fw_error"] = str(e)[:200]
        try:
            w = self._ssh("wg")
            d["wg"] = w.get("tunnels", [])
            d["wg_defaults"] = w.get("defaults")
        except Exception as e:
            d["wg_error"] = str(e)[:200]
        self.state.put("vps", d)

    def collect_ifaces(self):
        if not self.enabled():
            return
        d = self._ssh("ifaces", timeout=15)
        t_vps, t = d.get("t") or time.time(), time.time()
        cur = {i["name"]: (i["rx"], i["tx"]) for i in d["ifaces"]}
        rates = {}
        if self.prev_if:
            pt, prev = self.prev_if
            dt = max(t_vps - pt, 1)
            for n, (rx, tx) in cur.items():
                if n not in prev or rx < prev[n][0] or tx < prev[n][1]:
                    continue  # new interface or counter reset (tunnel restarted)
                drx, dtx = rx - prev[n][0], tx - prev[n][1]
                rates[n] = (int(drx / dt), int(dtx / dt))
                if self.sink:
                    self.sink(n, t, drx, dtx, rates[n])
        self.prev_if = (t_vps, cur)
        out = []
        for i in d["ifaces"]:
            r = rates.get(i["name"], (0, 0))
            out.append({**i, "rx_total": i["rx"], "tx_total": i["tx"], "rx": r[0], "tx": r[1], "t": int(t)})
        self.state.put("vps_ifaces", out)

    def wg_action(self, name, action):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,14}", name or ""):
            raise ValueError("Ungültiger Tunnelname")
        cmd = {"up": "wg-up %s", "down": "wg-down %s", "autostart_on": "wg-autostart %s on",
               "autostart_off": "wg-autostart %s off", "config": "wg-config %s", "delete": "wg-delete %s"}.get(action)
        if not cmd:
            raise ValueError("Unbekannte Aktion")
        r = self._ssh(cmd % name, timeout=40)
        self.history.insert(0, {"t": int(time.time()), "what": "WireGuard %s: %s" % (name, action)})
        self.collect()
        return r

    def wg_create(self, name, route, dns):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,11}", name or ""):
            raise ValueError("Name: a-z, 0-9 und -, höchstens 12 Zeichen")
        if route not in ("home", "all") or dns not in ("adguard", "none"):
            raise ValueError("Ungültige Option")
        r = self._ssh("wg-create %s %s %s" % (name, route, dns), timeout=40)
        self.history.insert(0, {"t": int(time.time()), "what": "WireGuard-Tunnel wg-%s angelegt" % name})
        self.collect()
        return r

    def wg_edit(self, name, ch):
        """address/port of the tunnel, comment/AllowedIPs/keepalive of its peers; the helper checks the details"""
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,14}", name or ""):
            raise ValueError("Ungültiger Tunnelname")
        out = {k: str(ch[k])[:200] for k in ("address", "port") if k in ch}
        peers = []
        for p in ch.get("peers") or []:
            if isinstance(p, dict) and p.get("pub"):
                peers.append({"pub": str(p["pub"])[:60], **{k: str(p[k] if p[k] is not None else "")[:400]
                                                            for k in ("comment", "allowed", "keepalive") if k in p}})
        out["peers"] = peers
        r = self._ssh("wg-edit %s" % name, inp=json.dumps(out), timeout=60)
        if r.get("changed"):
            self.history.insert(0, {"t": int(time.time()), "what": "WireGuard %s bearbeitet%s" % (name, ", neu gestartet" if r.get("restarted") else "")})
        self.collect()
        return r

    def apply(self, forwards):
        """apply, check the VPS still answers, then confirm; otherwise it rolls back by itself after 60 s"""
        with self.lock:
            self._ssh("apply", inp=json.dumps(forwards))
            time.sleep(2)
            try:
                st = self.status()
            except Exception as e:
                self.history.insert(0, {"t": int(time.time()), "what": "übernommen, VPS antwortet nicht, Rücknahme in 60 s",
                                        "error": str(e)})
                raise RuntimeError("VPS antwortet nach dem Übernehmen nicht mehr, er nimmt die Änderung in 60 s selbst zurück")
            self._ssh("confirm")
            self.history.insert(0, {"t": int(time.time()), "what": "übernommen und bestätigt", "n": len(forwards)})
            self.collect()
            return st

    def fw_apply(self, cfg):
        """firewall settings + own rules: apply, check the VPS still answers over SSH, then confirm (else it rolls back in 60 s)"""
        if not isinstance(cfg, dict):
            raise ValueError("Einstellungen erwartet")
        with self.lock:
            self._ssh("fw-apply", inp=json.dumps(cfg), timeout=40)
            time.sleep(2)
            try:
                # a fresh connection, not the shared one: proves new SSH connections still get through
                base = self._base()
                base = base[:-2] if base[-1].startswith("ControlPath=") else base   # ssh takes the first value of an option
                p = subprocess.run(base + ["-o", "ControlPath=none", self._target(), "fw-status"],
                                   capture_output=True, text=True, timeout=20)
                json.loads((p.stdout or "").strip().splitlines()[-1])
            except Exception as e:
                self.history.insert(0, {"t": int(time.time()), "what": "Firewall übernommen, VPS antwortet nicht, Rücknahme in 60 s",
                                        "error": str(e)[:200]})
                raise RuntimeError("VPS antwortet nach dem Übernehmen nicht mehr über eine neue SSH-Verbindung, "
                                   "er nimmt die Firewall-Änderung in 60 s selbst zurück")
            self._ssh("fw-confirm")
            self.history.insert(0, {"t": int(time.time()), "what": "Firewall übernommen und bestätigt"})
        self.collect()
        return {"ok": True}

    def test(self, ip, port):
        return self._ssh("test %s %d" % (ip, int(port)))
