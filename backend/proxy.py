"""Reverse proxy entries (OPNsense nginx plugin) + AdGuard DNS rewrites in one step.

One dashboard entry = nginx http_server + location + upstream + upstream_server
(the four objects the plugin UI spreads over four tabs), optionally plus an AdGuard
rewrite <domain> -> <firewall IP>.
"""
import base64
import concurrent.futures
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading

from remote import http_json

DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def _d(e):
    return {c.tag: (c.text or "") for c in e if len(c) == 0}


class Proxy:
    def __init__(self, opn, cfg, adguard_cfg, answer_ip=None):
        self.opn = opn
        self.cfg = cfg
        self.ag = adguard_cfg or {}
        self.answer_ip = answer_ip
        self.lock = threading.Lock()

    # ------------------------------------------------------------ AdGuard rewrites
    def _ag(self, path, data=None):
        auth = "Basic " + base64.b64encode(("%s:%s" % (self.ag["user"], self.ag["pass"])).encode()).decode()
        return http_json(self.ag["url"].rstrip("/") + path, method="POST" if data is not None else "GET",
                         data=data, headers={"Authorization": auth}, timeout=15)

    def rewrites(self):
        try:
            return {r["domain"]: r["answer"] for r in (self._ag("/control/rewrite/list") or [])}
        except Exception:
            return {}

    def add_rewrite(self, domain, answer=None):
        rw = self.rewrites()
        if domain in rw:
            return False
        self._ag("/control/rewrite/add", {"domain": domain, "answer": answer or self.answer_ip, "enabled": True})
        return True

    def del_rewrite(self, domain):
        rw = self.rewrites()
        if domain in rw:
            self._ag("/control/rewrite/delete", {"domain": domain, "answer": rw[domain]})

    # ------------------------------------------------------------ model
    def _model(self):
        root = self.cfg.get()
        n = root.find(".//OPNsense/Nginx")
        if n is None:
            raise RuntimeError("nginx-Plugin nicht konfiguriert")
        by = lambda tag: {e.get("uuid"): e for e in n.findall(tag)}
        return n, by("location"), by("upstream"), by("upstream_server")

    def list(self):
        n, L, U, S = self._model()
        rw = self.rewrites()
        out = []
        for hs in n.findall("http_server"):
            dom = (hs.findtext("servername") or "").strip()
            locs = []
            for lid in [x for x in (hs.findtext("locations") or "").split(",") if x]:
                l = L.get(lid)
                if l is None:
                    continue
                up = U.get(l.findtext("upstream") or "")
                servers = []
                if up is not None:
                    for sid in [x for x in (up.findtext("serverentries") or "").split(",") if x]:
                        s = S.get(sid)
                        if s is not None:
                            servers.append({"uuid": sid, "host": s.findtext("server"), "port": s.findtext("port"),
                                            "descr": s.findtext("description")})
                locs.append({
                    "uuid": lid, "path": l.findtext("urlpattern") or "/", "websocket": l.findtext("websocket") == "1",
                    "upstream": up.get("uuid") if up is not None else None,
                    "tls": up is not None and up.findtext("tls_enable") == "1",
                    "tls_verify": up is not None and up.findtext("tls_verify") == "1",
                    "servers": servers,
                })
            main = locs[0] if locs else {}
            srv = (main.get("servers") or [{}])[0]
            out.append({
                "uuid": hs.get("uuid"), "domain": dom, "certificate": hs.findtext("certificate"),
                "https_only": hs.findtext("https_only") == "1",
                "host": srv.get("host"), "port": srv.get("port"),
                "https": main.get("tls", False), "websocket": main.get("websocket", False),
                "locations": locs, "rewrite": rw.get(dom),
            })
        return sorted(out, key=lambda e: e["domain"])

    @staticmethod
    def suffix(entries):
        """most common parent domain of the existing entries (e.g. ".home.example.com")"""
        import collections
        c = collections.Counter("." + e["domain"].split(".", 1)[1] for e in entries if e["domain"].count(".") >= 2)
        return c.most_common(1)[0][0] if c else ""

    def health(self, domains):
        """status code of https://<domain>/ via the local nginx (SNI), no redirects followed"""
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        class SNIConn(http.client.HTTPSConnection):
            def __init__(self, sni):
                super().__init__("127.0.0.1", 443, timeout=6, context=ctx)
                self.sni = sni

            def connect(self):
                sock = socket.create_connection((self.host, self.port), self.timeout)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.sni)

        def one(dom):
            try:
                c = SNIConn(dom)
                c.request("GET", "/", headers={"Host": dom, "User-Agent": "netdash-check"})
                r = c.getresponse()
                r.read(2048)
                c.close()
                return dom, r.status
            except Exception as e:
                return dom, "Fehler: %s" % type(e).__name__

        with concurrent.futures.ThreadPoolExecutor(8) as ex:
            return dict(ex.map(one, domains))

    # ------------------------------------------------------------ helpers
    def _api(self, action, payload=None):
        r = self.opn.post("/api/nginx/settings/" + action, payload)
        if isinstance(r, dict) and r.get("result") not in (None, "saved", "deleted") and "uuid" not in r:
            raise RuntimeError("%s: %s" % (action, json.dumps(r.get("validations") or r)[:300]))
        if isinstance(r, dict) and r.get("validations"):
            raise RuntimeError("%s: %s" % (action, "; ".join("%s: %s" % kv for kv in r["validations"].items())))
        return r

    def _reconfigure(self):
        r = self.opn.post("/api/nginx/service/reconfigure", {}, timeout=90)
        if (r or {}).get("status") != "ok":
            raise RuntimeError("nginx reconfigure: %s" % r)

    def _templates(self):
        n, L, U, S = self._model()
        # new entries are cloned from an existing plain one (one location, one upstream server)
        hs = next((h for h in n.findall("http_server")
                   if len([x for x in (h.findtext("locations") or "").split(",") if x]) == 1), None)
        if hs is None:
            raise RuntimeError("Lege zuerst einen Eintrag im nginx-Plugin der OPNsense an, er dient als Vorlage")
        loc = L[(hs.findtext("locations") or "").split(",")[0]]
        up = U[loc.findtext("upstream")]
        us = S[(up.findtext("serverentries") or "").split(",")[0]]
        return _d(hs), _d(loc), _d(up), _d(us)

    @staticmethod
    def _check(domain, host, port):
        domain = (domain or "").strip().lower().rstrip(".")
        if not DOMAIN_RE.match(domain):
            raise ValueError("Ungültige Domain")
        host = (host or "").strip()
        if not HOST_RE.match(host):
            raise ValueError("Ungültiges Ziel")
        try:
            port = int(port)
            assert 1 <= port <= 65535
        except Exception:
            raise ValueError("Ungültiger Port")
        return domain, host, port

    # ------------------------------------------------------------ actions
    def create(self, domain, host, port, https=False, websocket=False, rewrite=True):
        domain, host, port = self._check(domain, host, port)
        with self.lock:
            if any(e["domain"] == domain for e in self.list()):
                raise ValueError("Für %s gibt es schon einen Eintrag" % domain)
            t_hs, t_loc, t_up, t_us = self._templates()
            created = []
            try:
                desc = "netdash " + domain
                us = dict(t_us, description=desc, server=host, port=str(port))
                us_id = self._api("addupstreamserver", {"upstream_server": us})["uuid"]
                created.append(("delupstreamserver", us_id))
                up = dict(t_up, description=desc, serverentries=us_id, tls_enable="1" if https else "0",
                          tls_verify="0" if https else t_up.get("tls_verify", "1"))
                up_id = self._api("addupstream", {"upstream": up})["uuid"]
                created.append(("delupstream", up_id))
                loc = dict(t_loc, description=domain, upstream=up_id, websocket="1" if websocket else "0")
                loc_id = self._api("addlocation", {"location": loc})["uuid"]
                created.append(("dellocation", loc_id))
                hs = dict(t_hs, servername=domain, locations=loc_id)
                hs_id = self._api("addhttpserver", {"httpserver": hs})["uuid"]
                created.append(("delhttpserver", hs_id))
                self._reconfigure()
            except Exception:
                for action, uid in reversed(created):
                    try:
                        self._api("%s/%s" % (action, uid))
                    except Exception:
                        pass
                try:
                    self._reconfigure()
                except Exception:
                    pass
                raise
        dns = False
        if rewrite:
            dns = self.add_rewrite(domain)
        return {"uuid": hs_id, "domain": domain, "dns": dns}

    def update(self, uuid, host, port, https=False, websocket=False):
        with self.lock:
            e = next((x for x in self.list() if x["uuid"] == uuid), None)
            if not e or not e["locations"]:
                raise ValueError("Eintrag nicht gefunden")
            _, host, port = self._check(e["domain"], host, port)
            loc = e["locations"][0]
            if loc["servers"]:
                self._api("setupstreamserver/" + loc["servers"][0]["uuid"],
                          {"upstream_server": {"server": host, "port": str(port)}})
            if loc["upstream"]:
                patch = {"tls_enable": "1" if https else "0"}
                if https:
                    patch["tls_verify"] = "0"
                self._api("setupstream/" + loc["upstream"], {"upstream": patch})
            self._api("setlocation/" + loc["uuid"], {"location": {"websocket": "1" if websocket else "0"}})
            self._reconfigure()
        return {"ok": True}

    def delete(self, uuid, rewrite=True):
        with self.lock:
            entries = self.list()
            e = next((x for x in entries if x["uuid"] == uuid), None)
            if not e:
                raise ValueError("Eintrag nicht gefunden")
            others = [x for x in entries if x["uuid"] != uuid]
            used_loc = {l["uuid"] for x in others for l in x["locations"]}
            used_up = {l["upstream"] for x in others for l in x["locations"]}
            used_srv = {s["uuid"] for x in others for l in x["locations"] for s in l["servers"]}
            self._api("delhttpserver/" + uuid)
            for l in e["locations"]:
                if l["uuid"] not in used_loc:
                    self._api("dellocation/" + l["uuid"])
                if l["upstream"] and l["upstream"] not in used_up:
                    self._api("delupstream/" + l["upstream"])
                for s in l["servers"]:
                    if s["uuid"] not in used_srv:
                        self._api("delupstreamserver/" + s["uuid"])
            self._reconfigure()
        if rewrite:
            self.del_rewrite(e["domain"])
        return {"ok": True}
