"""Available updates for the infrastructure: OPNsense, UniFi OS Server and its apps, UniFi devices, Unraid, switch.

Each item: {"id", "name", "kind", "current", "latest", "update": True | False | None (unknown), "note", "mac", "ip",
"checked", "error"}. Devices are matched in the frontend by mac or ip.
"""
import json
import os
import subprocess
import time
import traceback
import urllib.parse

from remote import http_json

OPN_CHECK = "/tmp/pkg_upgrade.json"   # written by the OPNsense firmware check (GUI, cron or configctl firmware check)
OPN_MAX_AGE = 12 * 3600
UNRAID_FEED = "https://releases.unraid.net/os?branch=stable&current_version=%s"


def _v(s):
    return (s or "").strip().lstrip("vV") or None


class Updates:
    def __init__(self, app, log=print):
        self.app = app
        self.log = log
        self.items = {}
        self._opn_triggered = 0

    def _put(self, item):
        item.setdefault("checked", int(time.time()))
        self.items[item["id"]] = item

    def _fail(self, iid, name, kind, e):
        old = self.items.get(iid) or {}
        self.items[iid] = {**old, "id": iid, "name": old.get("name") or name, "kind": kind, "error": str(e)[:200],
                           "update": old.get("update")}

    def collect(self, force=False):
        for fn in (self._opnsense, self._unifi, self._unraid, self._switch):
            try:
                fn(force)
            except Exception:
                self.log("update check failed", fn.__name__, traceback.format_exc(limit=2))
        self.app.state.put("updates", sorted(self.items.values(), key=lambda i: (not i.get("update"), i["name"].lower())))

    # ------------------------------------------------------------ OPNsense (this box)
    def _opnsense(self, force):
        try:
            age = time.time() - os.path.getmtime(OPN_CHECK)
        except OSError:
            age = None
        # the check asks every repository, so only now and then (or when asked); it runs in the background
        if (force or age is None or age > OPN_MAX_AGE) and time.time() - self._opn_triggered > (60 if force else 3600):
            self._opn_triggered = time.time()
            subprocess.run(["/usr/local/sbin/configctl", "firmware", "check"], capture_output=True, timeout=30)
        try:
            with open(OPN_CHECK) as f:
                d = json.load(f)
        except (OSError, ValueError):
            old = self.items.get("opnsense")
            if old and old.get("current"):   # the check is rewriting the file: keep the last result meanwhile
                old["note"] = "wird gerade geprüft …"
                return
            fw = (self.app.state.get("firmware") or {}).get("product") or {}
            self._put({"id": "opnsense", "name": "OPNsense", "kind": "firewall", "current": fw.get("product_version"),
                       "latest": None, "update": None, "note": "Update-Prüfung läuft …" if self._opn_triggered else None})
            return
        ups = d.get("upgrade_packages") or []
        core = next((p for p in ups if p.get("name") in ("opnsense", "opnsense-devel", "opnsense-business")), None)
        n = len(ups) + len(d.get("new_packages") or []) + len(d.get("reinstall_packages") or []) + len(d.get("upgrade_sets") or [])
        major = d.get("upgrade_major_version") or ""
        ok = d.get("connection") == "ok" and d.get("repository") == "ok"
        note = []
        if major:
            note.append("Major-Upgrade auf %s" % major)
        if n:
            note.append("%d Paket%s" % (n, "" if n == 1 else "e"))
        if d.get("download_size") and n:
            note.append(d["download_size"])
        self._put({"id": "opnsense", "name": "OPNsense", "kind": "firewall", "current": d.get("product_version"),
                   "latest": (core or {}).get("new_version") or major or d.get("product_version"),
                   "update": bool(n or major) if ok else None,
                   "note": " · ".join(note) or (None if ok else "Repository nicht erreichbar"),
                   "checked": int(os.path.getmtime(OPN_CHECK)), "ip": None, "mac": None, "own": True})

    # ------------------------------------------------------------ UniFi OS Server, its apps, the UniFi devices
    def _unifi(self, force):
        u = getattr(self.app, "unifi", None)
        if not u or not u.enabled():
            for k in [k for k in self.items if k.startswith("unifi")]:
                del self.items[k]
            return
        host = urllib.parse.urlparse(u.base).hostname
        try:
            s = u.system()
        except Exception as e:
            self._fail("unifi-os", "UniFi OS", "unifi-os", e)
        else:
            fw = s.get("firmware") or {}
            cur = _v((s.get("hardware") or {}).get("firmwareVersion"))
            latest = _v((fw.get("latest") or {}).get("version"))
            st = next((x.get("firmwareStatus") for x in (s.get("devices") or {}).get("unifiOS") or []), None)
            upd = (st != "upToDate") if st else (bool(cur and latest and cur != latest) if latest else None)
            prog = (fw.get("progress") or {}).get("state")
            self._put({"id": "unifi-os", "name": s.get("name") and "UniFi OS Server (%s)" % s["name"] or "UniFi OS Server",
                       "kind": "unifi-os", "current": cur, "latest": latest or cur, "update": upd, "ip": host, "mac": None,
                       "note": "Update wird installiert" if prog not in (None, "none") else None})
            for c in (s.get("apps") or {}).get("controllers") or []:
                if not c.get("version") or not c.get("name"):
                    continue
                nice = {"network": "UniFi Network", "protect": "UniFi Protect", "access": "UniFi Access",
                        "talk": "UniFi Talk", "connect": "UniFi Connect", "innerspace": "InnerSpace"}.get(c["name"], c.get("displayName") or c["name"])
                self._put({"id": "unifi-app-" + c["name"], "name": nice, "kind": "unifi-app", "current": c["version"],
                           "latest": c.get("updateAvailable") or c["version"], "update": bool(c.get("updateAvailable")),
                           "ip": host, "mac": None, "note": "App auf %s" % ("UniFi OS Server")})
        for d in (self.app.state.get("unifi") or {}).get("devices") or []:
            if not d.get("mac"):
                continue
            self._put({"id": "unifi-dev-" + d["mac"], "name": d.get("name") or d.get("model") or d["mac"], "kind": "unifi-device",
                       "current": d.get("version"), "latest": d.get("upgrade_to") or d.get("version"),
                       "update": bool(d.get("upgradable")), "mac": (d["mac"] or "").lower(), "ip": d.get("ip"),
                       "note": d.get("model")})

    # ------------------------------------------------------------ Unraid
    def _unraid(self, force):
        un = self.app.state.get("unraid") or {}
        if not un.get("version"):
            self.items.pop("unraid", None)
            return
        cur = un["version"]
        old = self.items.get("unraid") or {}
        if not force and old.get("current") == cur and time.time() - (old.get("checked") or 0) < 6 * 3600 and not old.get("error"):
            return
        try:
            r = http_json(UNRAID_FEED % urllib.parse.quote(cur), headers={"User-Agent": "netdash", "Accept": "application/json"}, timeout=15)
        except Exception as e:
            self._put({"id": "unraid", "name": "Unraid (%s)" % un.get("hostname") if un.get("hostname") else "Unraid",
                       "kind": "unraid", "current": cur, "latest": None, "update": None, "ip": un.get("ip"), "mac": None,
                       "error": "Release-Server nicht erreichbar: %s" % str(e)[:120]})
            return
        newer = bool(r.get("isNewer"))
        self._put({"id": "unraid", "name": "Unraid (%s)" % un["hostname"] if un.get("hostname") else "Unraid", "kind": "unraid",
                   "current": cur, "latest": r.get("version") if newer else cur, "update": newer,
                   "ip": un.get("ip"), "mac": None, "url": r.get("changelogPretty") if newer else None,
                   "note": ("veröffentlicht %s" % r["date"]) if newer and r.get("date") else None})

    # ------------------------------------------------------------ switch (Realtek web firmware: no update source)
    def _switch(self, force):
        sw = self.app.state.get("switch") or {}
        if not sw.get("fw"):
            self.items.pop("switch", None)
            return
        self._put({"id": "switch", "name": sw.get("name") or "Switch", "kind": "switch", "current": sw["fw"], "latest": None,
                   "update": None, "mac": sw.get("mac"), "ip": sw.get("ip"),
                   "note": "keine automatische Prüfung: neue Firmware gibt es nur beim Hersteller"})
