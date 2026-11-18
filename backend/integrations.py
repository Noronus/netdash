"""Integration settings (stored in secrets.json) editable from the web UI."""
import json
import os

import remote
from store import State

BASE = os.environ.get("NETDASH_BASE", "/usr/local/netdash")
SECRETS = os.path.join(BASE, "secrets.json")

# field: (label, kind, default)   kind: text | secret
SCHEMA = {
    "opnsense": {"label": "OPNsense-API", "desc": "Dienste, Gateways, WireGuard, Schnittstellen, Reverse Proxy",
                 "fields": {"url": ("URL (leer = automatisch)", "text", ""), "key": ("API-Key", "secret", ""),
                            "secret": ("API-Secret", "secret", "")}, "core": True},
    "adguard": {"label": "AdGuard Home", "desc": "DNS-Statistik, Rewrites (Query-Log wird direkt gelesen)",
                "fields": {"url": ("URL", "text", "http://127.0.0.1:3000"), "user": ("Benutzer", "text", ""),
                           "pass": ("Passwort", "secret", "")}},
    "unifi": {"label": "UniFi", "desc": "WLAN-Clients, Access Points, UniFi-Switches",
              "fields": {"url": ("URL", "text", ""), "user": ("Benutzer", "text", ""),
                         "pass": ("Passwort", "secret", ""), "site": ("Site", "text", "default")}},
    "unraid": {"label": "Unraid", "desc": "CPU, RAM, Pools, Docker (GraphQL-API, Schlüssel mit Rolle VIEWER)",
               "fields": {"url": ("GraphQL-URL", "text", ""), "key": ("API-Key", "secret", "")}},
    "gatus": {"label": "Gatus", "desc": "Monitoring-Status (die Checks selbst bearbeitest du unter Dienste)",
              "fields": {"url": ("URL", "text", ""), "dir": ("Konfig-Ordner (zum Bearbeiten)", "text", "/usr/local/gatus")}},
    "switch": {"label": "Switch", "desc": "Ports, MAC-Tabelle, LLDP, VLANs (Realtek-Web-API)",
               "fields": {"url": ("URL", "text", ""), "user": ("Benutzer", "text", "admin"),
                          "pass": ("Passwort", "secret", ""), "name": ("Anzeigename", "text", "Switch")}},
    "vps": {"label": "VPS", "desc": "Linux-Server mit öffentlicher IP: Portweiterleitungen, WireGuard, Interfaces (Helfer extras/vps)",
            "fields": {"host": ("Host", "text", ""), "port": ("SSH-Port", "text", "22"),
                       "user": ("Benutzer", "text", "root"), "name": ("Anzeigename", "text", "VPS")}},
    "netbird": {"label": "NetBird", "desc": "Peers über die lokale NetBird-CLI der OPNsense", "fields": {}},
}


def load():
    try:
        with open(SECRETS) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save(d):
    tmp = SECRETS + ".tmp"
    old = os.umask(0o077)
    try:
        with open(tmp, "w") as f:
            json.dump(d, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, SECRETS)
    finally:
        os.umask(old)


def public(sources):
    d = load()
    out = []
    for name, sc in SCHEMA.items():
        cur = d.get(name, {})
        fields = []
        for k, (label, kind, default) in sc["fields"].items():
            v = cur.get(k, default if kind == "text" else "")
            fields.append({"key": k, "label": label, "kind": kind,
                           "value": v if kind == "text" else "", "set": bool(cur.get(k)) if kind == "secret" else None})
        src = sources.get(name if name != "opnsense" else "services") or {}
        out.append({"name": name, "label": sc["label"], "desc": sc["desc"], "core": sc.get("core", False),
                    "enabled": cur.get("enabled", True), "configured": bool(cur) or not sc["fields"],
                    "fields": fields, "status": src})
    return out


def merged(name, incoming):
    """incoming form values merged onto the stored ones (empty secret = keep)"""
    cur = dict(load().get(name, {}))
    for k, (label, kind, default) in SCHEMA[name]["fields"].items():
        if k not in incoming:
            continue
        v = str(incoming[k]).strip()
        if kind == "secret" and v == "":
            continue
        cur[k] = v
    if "enabled" in incoming:
        cur["enabled"] = bool(incoming["enabled"])
    return cur


def test(name, cfg, devices=None):
    """returns (ok, message)"""
    st = State()
    try:
        if name == "opnsense":
            rows = remote.OPNsense(st, cfg).get("/api/core/service/search?rowCount=1")
            return True, "verbunden, %s Dienste" % rows.get("total", "?")
        if name == "adguard":
            ag = remote.AdGuard.__new__(remote.AdGuard)
            ag.cfg = cfg
            ag.auth = remote.AdGuard.make_auth(cfg)
            s = ag.api("/control/status")
            return True, "verbunden, AdGuard %s" % s.get("version")
        if name == "unifi":
            u = remote.UniFi(st, devices, cfg)
            sites = u.call("/api/self/sites").get("data", [])
            return True, "verbunden, Sites: %s" % ", ".join(s.get("name") for s in sites)
        if name == "unraid":
            remote.Unraid(st, cfg).collect()
            u = st.get("unraid")
            return True, "verbunden, %s · %d Container" % (u["hostname"], len(u["containers"]))
        if name == "gatus":
            g = remote.Gatus(st, cfg.get("url") or SCHEMA["gatus"]["fields"]["url"][2])
            g.collect()
            return True, "verbunden, %d Checks" % len(st.get("gatus"))
        if name == "switch":
            import switch
            sw = switch.Switch(st, None, cfg)
            info = sw.sysinfo()
            return True, "verbunden, %s · Firmware %s" % (info.get("hostname"), info.get("fwVer"))
        if name == "vps":
            import vps
            d = vps.VPS(st, cfg).status()
            return True, "verbunden, %d Weiterleitungen" % len(d.get("forwards", []))
        if name == "netbird":
            remote.NetBird(st).collect()
            return True, "%d Peers" % len(st.get("netbird")["peers"])
    except Exception as e:
        msg = str(e)
        if "401" in msg or "403" in msg:
            msg = "Zugangsdaten abgelehnt (%s)" % msg
        return False, "%s: %s" % (type(e).__name__, msg[:200])
    return False, "unbekannte Integration"
