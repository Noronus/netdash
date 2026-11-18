"""Device and service actions: start/stop services, Wake-on-LAN, static DHCP, internet block."""
import ipaddress
import re
import subprocess
import threading

BLOCK_ALIAS = "netdash_blocked"
PRIVATE_ALIAS = "netdash_private"
PRIVATE_NETS = "10.0.0.0/8\n172.16.0.0/12\n192.168.0.0/16\n100.64.0.0/10\nfc00::/7\nfe80::/10\nff00::/8"
RULE_DESCR = "netdash: gesperrte Geräte nicht ins Internet"
CRITICAL = {"nginx", "webgui", "lighttpd", "netbird", "dnsmasq", "AdGuardHome", "pf", "openssh", "unbound"}


class Actions:
    def __init__(self, app):
        self.app = app
        self.lock = threading.Lock()

    @property
    def opn(self):
        return self.app.opn

    def _ok(self, r, what):
        if isinstance(r, dict) and r.get("result") == "failed":
            v = r.get("validations") or {}
            raise ValueError("%s: %s" % (what, "; ".join("%s: %s" % (k.split(".")[-1], m) for k, m in v.items()) or "abgelehnt"))
        return r

    # ------------------------------------------------------------ services
    def service(self, sid, action):
        if action not in ("start", "stop", "restart"):
            raise ValueError("Aktion start, stop oder restart")
        if not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,80}", sid or ""):
            raise ValueError("Ungültiger Dienst")
        name, _, ident = sid.partition("/")
        if name == "netdash":
            # restarting/stopping ourselves: answer first, then let configd do it from a separate session
            subprocess.Popen(["/bin/sh", "-c", "sleep 1; /usr/local/sbin/configctl netdash %s" % action],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return {"result": "ok", "self": True}
        path = "/api/core/service/%s/%s" % (action, name) + ("/" + ident if ident else "")
        r = self.opn.post(path, {}, timeout=90)
        self.app.opn.collect_services()
        return r

    # ------------------------------------------------------------ wake on lan
    def _device(self, mac):
        devs = self.app.state.get("devices", {}) or {}
        d = devs.get(mac.lower())
        if not d:
            raise ValueError("Gerät unbekannt")
        return d

    def wol(self, mac):
        d = self._device(mac)
        netif = d.get("netif") or d.get("last_if")
        info = self.app.ifaces.by_dev.get(netif or "")
        if not info:
            raise ValueError("Netz des Geräts unbekannt, Wake-on-LAN braucht das Interface")
        r = self.opn.post("/api/wol/wol/set", {"wake": {"interface": info["ifname"], "mac": d["mac"]}})
        return {"ok": True, "interface": info["descr"], "result": r}

    # ------------------------------------------------------------ static dhcp (dnsmasq)
    def _hosts(self):
        return self.opn.get("/api/dnsmasq/settings/search_host?rowCount=-1").get("rows", [])

    def static(self, mac, ip, hostname, descr=""):
        mac = mac.lower()
        ipaddress.ip_address(ip)
        hostname = (hostname or "").strip().lower()
        if hostname and not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", hostname):
            raise ValueError("Hostname: nur a-z, 0-9 und -")
        with self.lock:
            cur = next((h for h in self._hosts() if (h.get("hwaddr") or "").lower() == mac), None)
            body = {"host": {"host": hostname, "ip": ip, "hwaddr": mac, "descr": descr[:60]}}
            if cur:
                self._ok(self.opn.post("/api/dnsmasq/settings/set_host/" + cur["uuid"], body), "DHCP-Lease")
            else:
                self._ok(self.opn.post("/api/dnsmasq/settings/add_host", body), "DHCP-Lease")
            self.opn.post("/api/dnsmasq/service/reconfigure", {}, timeout=60)
        self.app.devices.collect()
        return {"ok": True}

    def unstatic(self, mac):
        mac = mac.lower()
        with self.lock:
            cur = next((h for h in self._hosts() if (h.get("hwaddr") or "").lower() == mac), None)
            if not cur:
                raise ValueError("Kein statisches DHCP-Lease vorhanden")
            self.opn.post("/api/dnsmasq/settings/del_host/" + cur["uuid"], {})
            self.opn.post("/api/dnsmasq/service/reconfigure", {}, timeout=60)
        self.app.devices.collect()
        return {"ok": True}

    # ------------------------------------------------------------ internet block
    def _alias(self, name):
        try:
            r = self.opn.get("/api/firewall/alias/getAliasUUID/" + name)
        except Exception:
            r = {}
        return r.get("uuid") if isinstance(r, dict) else None

    def _ensure_block_setup(self):
        changed = False
        if not self._alias(PRIVATE_ALIAS):
            self._ok(self.opn.post("/api/firewall/alias/add_item", {"alias": {
                "enabled": "1", "name": PRIVATE_ALIAS, "type": "network", "content": PRIVATE_NETS,
                "description": "netdash: private und lokale Netze"}}), "Alias")
            changed = True
        if not self._alias(BLOCK_ALIAS):
            self._ok(self.opn.post("/api/firewall/alias/add_item", {"alias": {
                "enabled": "1", "name": BLOCK_ALIAS, "type": "host", "content": "",
                "description": "netdash: Geräte ohne Internet"}}), "Alias")
            changed = True
        if changed:
            self.opn.post("/api/firewall/alias/reconfigure", {}, timeout=60)
        rules = self.opn.get("/api/firewall/filter/search_rule?rowCount=-1").get("rows", [])
        if not any(r.get("description") == RULE_DESCR for r in rules):
            internal = [i["ifname"] for d, i in self.app.ifaces.by_dev.items()
                        if d not in self.app.ifaces.wan_devs and i["ifname"] not in ("wireguard",)
                        and not d.startswith(("wg", "wt", "lo"))]
            self._ok(self.opn.post("/api/firewall/filter/add_rule", {"rule": {
                "enabled": "1", "action": "block", "quick": "1", "interface": ",".join(internal), "direction": "in",
                "ipprotocol": "inet46", "protocol": "any", "source_net": BLOCK_ALIAS, "destination_net": PRIVATE_ALIAS,
                "destination_not": "1", "log": "1", "description": RULE_DESCR, "sequence": "1"}}), "Regel")
            self.opn.post("/api/firewall/filter/apply", {}, timeout=120)

    def blocked(self):
        uuid = self._alias(BLOCK_ALIAS)
        if not uuid:
            return set()
        a = self.opn.get("/api/firewall/alias/get_item/" + uuid).get("alias", {})
        content = a.get("content")
        if isinstance(content, dict):
            return {k for k, v in content.items() if isinstance(v, dict) and v.get("selected")}
        return set(filter(None, str(content or "").split("\n")))

    def blocked_macs(self):
        return set(self.app.db.kv_get("blocked_macs", []))

    def block(self, mac, on):
        d = self._device(mac)
        macs = self.blocked_macs()
        macs = (macs | {d["mac"]}) if on else (macs - {d["mac"]})
        self.app.db.kv_set("blocked_macs", sorted(macs))
        return self.sync(force=True) | {"blocked": bool(on)}

    def sync(self, force=False):
        """keep the alias equal to the current IPs of all blocked devices (DHCP / IPv6 privacy addresses change)"""
        macs = self.blocked_macs()
        if not macs and not force:
            return {"ok": True}
        devs = self.app.state.get("devices", {}) or {}
        want = set()
        for m in macs:
            d = devs.get(m) or {}
            want |= set(d.get("ipv4") or []) | set(d.get("ipv6") or [])
        with self.lock:
            self._ensure_block_setup()
            cur = self.blocked()
            if cur == want:
                return {"ok": True, "ips": sorted(want)}
            uuid = self._alias(BLOCK_ALIAS)
            self._ok(self.opn.post("/api/firewall/alias/set_item/" + uuid, {"alias": {
                "enabled": "1", "name": BLOCK_ALIAS, "type": "host", "content": "\n".join(sorted(want)),
                "description": "netdash: Geräte ohne Internet"}}), "Alias")
            self.opn.post("/api/firewall/alias/reconfigure", {}, timeout=60)
            for ip in want - cur:
                subprocess.run(["pfctl", "-k", ip], capture_output=True, timeout=10)
        return {"ok": True, "ips": sorted(want)}
