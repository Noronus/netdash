"""Diagnostics on the firewall: ping, traceroute, DNS lookup, TCP port test, route lookup, packet capture.

Each run streams its output line by line (SSE) and is killed on client disconnect or after a time limit.
Inputs are validated strictly and passed as argv (no shell).
"""
import ipaddress
import json
import os
import re
import secrets
import shlex
import socket
import subprocess
import threading
import time

HOST_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,62}\.)*[A-Za-z0-9-]{0,62}$")
FILTER_RE = re.compile(r"^[A-Za-z0-9 .:/()!=<>&|\[\]-]{0,200}$")
DNS_TYPES = {"A", "AAAA", "CNAME", "MX", "NS", "TXT", "PTR", "SRV", "SOA", "CAA", "ANY"}
SPEEDTEST = "/usr/local/netdash/bin/speedtest"
# Ookla does not allow redistribution: the CLI is downloaded on request, after the user accepted their license
SPEEDTEST_URL = "https://install.speedtest.net/app/cli/ookla-speedtest-1.2.0-freebsd13-x86_64.pkg"
SPEEDTEST_SHA256 = "23b20119066df5b08c4f3a8920334ccaab0783780f9b2494629394d1ef33e6f8"
CAP_DIR = "/var/tmp/netdash-cap"
CAP_MAX_BYTES = 200 * 1024 * 1024
CAP_KEEP_S = 2 * 3600


def _target(t):
    t = (t or "").strip()
    try:
        return str(ipaddress.ip_address(t))
    except ValueError:
        pass
    if not HOST_RE.match(t):
        raise ValueError("Ziel: IP-Adresse oder Hostname")
    return t


def _is_v6(target, family):
    if family in ("4", "6"):
        return family == "6"
    try:
        return ipaddress.ip_address(target).version == 6
    except ValueError:
        return False


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


class Diag:
    def __init__(self, app):
        self.app = app
        self.st_lock = threading.Lock()
        self.st_servers = (0, [])
        self.pcaps = {}  # token -> {path, name, t}
        self.procs = {}  # run id from the browser -> Popen, for a clean stop

    def stop(self, rid):
        p = self.procs.get(rid)
        if p and p.poll() is None:
            p.terminate()
            return True
        return False

    def _track(self, q, p):
        rid = q.get("rid") or ""
        if re.fullmatch(r"[a-z0-9]{8,32}", rid):
            self.procs[rid] = p
        return rid

    def sources(self):
        """interfaces with their own addresses, for the source selector"""
        out = []
        for d, i in sorted(self.app.ifaces.by_dev.items(), key=lambda x: x[1]["descr"].lower()):
            addrs = i.get("addrs") or []
            if addrs or not d.startswith("lo"):
                out.append({"device": d, "descr": i["descr"], "v4": [a for a in addrs if ":" not in a],
                            "v6": [a for a in addrs if ":" in a and not a.startswith("fe80")]})
        return out

    def _src(self, dev, v6):
        if not dev:
            return None
        i = self.app.ifaces.by_dev.get(dev)
        if not i:
            raise ValueError("Interface unbekannt")
        addrs = [a for a in i.get("addrs") or [] if (":" in a) == v6 and not a.startswith("fe80")]
        if not addrs:
            raise ValueError("%s hat keine %s-Adresse" % (i["descr"], "IPv6" if v6 else "IPv4"))
        return addrs[0]

    def command(self, q):
        """build argv + time limit from the query parameters"""
        tool = q.get("tool", "")
        dev = q.get("iface") or ""
        if tool == "ping":
            t = _target(q.get("target"))
            v6 = _is_v6(t, q.get("family"))
            count = _int(q.get("count"), 1, 50, 4)
            size = _int(q.get("size"), 0, 9000, 56)
            argv = ["ping", "-6" if v6 else "-4", "-c", str(count), "-s", str(size)]
            src = self._src(dev, v6)
            if src:
                argv += ["-S", src]
            return argv + [t], count * 2 + 10
        if tool == "traceroute":
            t = _target(q.get("target"))
            v6 = _is_v6(t, q.get("family"))
            hops = _int(q.get("hops"), 1, 40, 20)
            argv = ["traceroute6" if v6 else "traceroute", "-w", "2", "-q", "1", "-m", str(hops)]
            if q.get("icmp") == "1" and not v6:
                argv.append("-I")
            if q.get("numeric") == "1":
                argv.append("-n")
            src = self._src(dev, v6)
            if src:
                argv += ["-s", src]
            return argv + [t], hops * 3 + 15
        if tool == "dns":
            name = _target(q.get("target"))
            rtype = (q.get("type") or "A").upper()
            if rtype not in DNS_TYPES:
                raise ValueError("Ungültiger Record-Typ")
            server = (q.get("server") or "127.0.0.1").strip()
            port = None
            if re.fullmatch(r"[0-9.]+:\d+", server):
                server, port = server.split(":")
            server = str(ipaddress.ip_address(server))
            argv = ["drill"]
            if port:
                argv += ["-p", str(_int(port, 1, 65535, 53))]
            if q.get("trace") == "1":
                argv.append("-T")
            if re.match(r"^[0-9.]+$|:", name) and rtype in ("A", "PTR") and q.get("reverse") == "1":
                argv.append("-x")
            return argv + ["@" + server, name, rtype], 20
        if tool == "route":
            t = _target(q.get("target"))
            return ["route", "-n", "get", ("-inet6" if _is_v6(t, q.get("family")) else "-inet"), t], 10
        if tool == "capture":
            if dev not in self.app.ifaces.by_dev:
                raise ValueError("Für den Mitschnitt ein Interface wählen")
            flt = (q.get("filter") or "").strip()
            if not FILTER_RE.match(flt):
                raise ValueError("Filter enthält ungültige Zeichen")
            count = _int(q.get("count"), 1, 5000, 50)
            secs = _int(q.get("seconds"), 1, 300, 15)
            argv = ["tcpdump", "-n", "-l", "-i", dev, "-c", str(count)]
            if q.get("verbose") == "1":
                argv.append("-v")
            return argv + (shlex.split(flt) if flt else []), secs
        if tool == "port":
            return None, 10
        if tool == "speedtest":
            argv = [SPEEDTEST, "--accept-license", "--accept-gdpr", "-f", "jsonl", "-p", "yes",
                    "--progress-update-interval=400"]
            sid = (q.get("server") or "").strip()
            if sid:
                if not sid.isdigit():
                    raise ValueError("Server-ID ist eine Zahl")
                argv += ["-s", sid]
            fam = q.get("family") or ""
            if dev or fam:
                v6 = fam == "6"
                if not dev:
                    dev = next((d for d in sorted(self.app.ifaces.wan_devs) if any(
                        (":" in a) == v6 and not a.startswith("fe80") for a in self.app.ifaces.by_dev.get(d, {}).get("addrs") or [])), "")
                    if not dev:
                        raise ValueError("Kein WAN mit %s-Adresse" % ("IPv6" if v6 else "IPv4"))
                argv += ["-i", self._src(dev, v6)]
            return argv, 120
        raise ValueError("Unbekanntes Werkzeug")

    # ---- speedtest -------------------------------------------------------------

    def speedtest_install(self):
        import hashlib
        import io
        import tarfile
        import urllib.request
        with urllib.request.urlopen(SPEEDTEST_URL, timeout=60) as r:
            data = r.read()
        if hashlib.sha256(data).hexdigest() != SPEEDTEST_SHA256:
            raise RuntimeError("Prüfsumme der heruntergeladenen Datei stimmt nicht")
        with tarfile.open(fileobj=io.BytesIO(data)) as tf:
            m = next((m for m in tf.getmembers() if m.name.lstrip("/").endswith("usr/local/bin/speedtest")), None)
            if m is None:
                raise RuntimeError("speedtest nicht im Paket gefunden")
            binary = tf.extractfile(m).read()
        os.makedirs(os.path.dirname(SPEEDTEST), exist_ok=True)
        with open(SPEEDTEST + ".tmp", "wb") as f:
            f.write(binary)
        os.chmod(SPEEDTEST + ".tmp", 0o755)
        os.replace(SPEEDTEST + ".tmp", SPEEDTEST)
        self.st_servers = (0, [])
        return {"ok": True}

    def speedtest_info(self):
        if not os.path.exists(SPEEDTEST):
            return {"installed": False, "servers": [], "history": self.app.db.kv_get("speedtests", []), "running": False}
        t, servers = self.st_servers
        if time.time() - t > 3600 or not servers:
            try:
                out = subprocess.run([SPEEDTEST, "--accept-license", "--accept-gdpr", "-L", "-f", "json"],
                                     capture_output=True, text=True, timeout=20).stdout
                servers = [{"id": x["id"], "name": x["name"], "location": x["location"]}
                           for x in json.loads(out).get("servers", [])]
                self.st_servers = (time.time(), servers)
            except Exception:
                pass
        return {"installed": True, "servers": servers, "history": self.app.db.kv_get("speedtests", []),
                "running": self.st_lock.locked()}

    def _speedtest(self, q, argv, write, emit):
        if not self.st_lock.acquire(blocking=False):
            raise ValueError("Es läuft schon ein Speedtest")
        try:
            write("Speedtest by Ookla (speedtest.net), läuft auf der OPNsense …")
            p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
            rid = self._track(q, p)
            t_end = time.time() + 120
            step = {"download": -1, "upload": -1}
            res = None
            try:
                for line in p.stdout:
                    if time.time() > t_end:
                        write("… Zeitlimit erreicht, abgebrochen")
                        break
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    ty = d.get("type")
                    if ty == "testStart":
                        sv, itf = d.get("server", {}), d.get("interface", {})
                        write("Server: %s, %s (ID %s) · Anbieter: %s" % (sv.get("name"), sv.get("location"), sv.get("id"), d.get("isp")))
                        write("Interface: %s · externe IP: %s" % (itf.get("name"), itf.get("externalIp")))
                        emit("progress", {"phase": "start", "server": "%s, %s" % (sv.get("name"), sv.get("location"))})
                    elif ty == "ping":
                        emit("progress", {"phase": "ping", "ms": d["ping"].get("latency"), "p": d["ping"].get("progress", 0)})
                    elif ty in ("download", "upload"):
                        x = d[ty]
                        mbps = x.get("bandwidth", 0) * 8 / 1e6
                        prog = x.get("progress", 0)
                        emit("progress", {"phase": ty, "mbps": round(mbps, 1), "p": prog})
                        q = int(prog * 4)
                        if q > step[ty] and q in (1, 2, 3):
                            step[ty] = q
                            write("%s %3d %%  %8.1f Mbit/s" % ("Download" if ty == "download" else "Upload  ", q * 25, mbps))
                    elif ty == "result":
                        res = d
            finally:
                self.procs.pop(rid, None)
                if p.poll() is None:
                    p.kill()
                p.wait(timeout=5)
            if not res:
                if p.returncode and p.returncode < 0:
                    write("(abgebrochen)")
                    return 1
                err = [ln for ln in (p.stderr.read() or "").splitlines() if ln.strip() and not ln.startswith("=")]
                msgs = []
                for ln in err:
                    try:
                        msgs.append(json.loads(ln).get("message", ln))
                    except ValueError:
                        msgs.append(ln)
                for m in msgs[-5:]:
                    write("Fehler: %s" % m)
                return p.returncode or 1
            down = res["download"]["bandwidth"] * 8 / 1e6
            up = res["upload"]["bandwidth"] * 8 / 1e6
            ping = res["ping"]
            entry = {"t": int(time.time()), "down": round(down, 1), "up": round(up, 1),
                     "ping": round(ping.get("latency", 0), 1), "jitter": round(ping.get("jitter", 0), 1),
                     "loaded_down": round(res["download"].get("latency", {}).get("iqm", 0), 1),
                     "loaded_up": round(res["upload"].get("latency", {}).get("iqm", 0), 1),
                     "loss": res.get("packetLoss"), "isp": res.get("isp"),
                     "server": "%s, %s" % (res["server"].get("name"), res["server"].get("location")),
                     "iface": res["interface"].get("name"), "ip": res["interface"].get("externalIp"),
                     "url": (res.get("result") or {}).get("url")}
            hist = self.app.db.kv_get("speedtests", [])
            self.app.db.kv_set("speedtests", ([entry] + hist)[:50])
            write("")
            write("Download  %8.1f Mbit/s   (Ping unter Last %s ms)" % (down, entry["loaded_down"]))
            write("Upload    %8.1f Mbit/s   (Ping unter Last %s ms)" % (up, entry["loaded_up"]))
            write("Ping      %8.1f ms       Jitter %s ms%s" % (entry["ping"], entry["jitter"],
                  "" if entry["loss"] is None else ", Paketverlust %s %%" % entry["loss"]))
            if entry["url"]:
                write("Ergebnis: %s" % entry["url"])
            emit("result", entry)
            return 0
        finally:
            self.st_lock.release()

    # ---- capture files ---------------------------------------------------------

    def _cap_cleanup(self):
        now = time.time()
        for tok, c in list(self.pcaps.items()):
            if now - c["t"] > CAP_KEEP_S or not os.path.exists(c["path"]):
                self.pcaps.pop(tok, None)
        try:
            for fn in os.listdir(CAP_DIR):
                fp = os.path.join(CAP_DIR, fn)
                if now - os.path.getmtime(fp) > CAP_KEEP_S:
                    os.unlink(fp)
        except OSError:
            pass

    def pcap(self, token):
        self._cap_cleanup()
        c = self.pcaps.get(token)
        return c if c and os.path.exists(c["path"]) else None

    def port_test(self, q):
        t = _target(q.get("target"))
        port = _int(q.get("port"), 1, 65535, 0)
        if not port:
            raise ValueError("Port 1-65535")
        v6 = _is_v6(t, q.get("family"))
        src = self._src(q.get("iface") or "", v6)
        fam = socket.AF_INET6 if v6 else socket.AF_INET
        lines = []
        try:
            infos = socket.getaddrinfo(t, port, fam, socket.SOCK_STREAM)
        except socket.gaierror as e:
            return ["Name nicht auflösbar: %s" % e]
        for info in infos[:3]:
            addr = info[4]
            s = socket.socket(fam, socket.SOCK_STREAM)
            s.settimeout(5)
            try:
                if src:
                    s.bind((src, 0))
                t0 = time.time()
                s.connect(addr)
                lines.append("%s:%d offen (%d ms)%s" % (addr[0], port, (time.time() - t0) * 1000,
                                                        " · Quelle %s" % src if src else ""))
            except OSError as e:
                lines.append("%s:%d nicht erreichbar: %s" % (addr[0], port, e.strerror or e))
            finally:
                s.close()
        return lines

    def stream(self, q, write, emit=lambda ev, data: None):
        """run and call write(line) per output line; returns (exit code, extra info for the done event)"""
        argv, limit = self.command(q)
        if argv is None:
            for line in self.port_test(q):
                write(line)
            return 0, {}
        if q.get("tool") == "speedtest":
            return self._speedtest(q, argv, write, emit), {}
        write("$ " + " ".join(argv))
        cap = None
        if q.get("tool") == "capture":
            self._cap_cleanup()
            os.makedirs(CAP_DIR, mode=0o700, exist_ok=True)
            tok = secrets.token_hex(16)
            cap = {"path": os.path.join(CAP_DIR, tok + ".pcap"), "t": time.time(),
                   "name": "mitschnitt-%s-%s.pcap" % (q.get("iface"), time.strftime("%Y%m%d-%H%M%S"))}
            # write the pcap and still print the packets (-U: flush the file per packet)
            argv = argv[:1] + ["-U", "-w", cap["path"], "--print"] + argv[1:]
        p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        rid = self._track(q, p)
        t_end = time.time() + limit
        try:
            import selectors
            sel = selectors.DefaultSelector()
            sel.register(p.stdout, selectors.EVENT_READ)
            while True:
                if time.time() > t_end:
                    write("… Zeitlimit (%d s) erreicht, abgebrochen" % limit)
                    break
                if cap and os.path.exists(cap["path"]) and os.path.getsize(cap["path"]) > CAP_MAX_BYTES:
                    write("… Datei größer als %d MB, Mitschnitt beendet" % (CAP_MAX_BYTES >> 20))
                    break
                if sel.select(timeout=1):
                    line = p.stdout.readline()
                    if not line:
                        break
                    write(line.rstrip("\n"))
                elif p.poll() is not None:
                    rest = p.stdout.read()
                    for line in (rest or "").splitlines():
                        write(line)
                    break
        finally:
            self.procs.pop(rid, None)
            if p.poll() is None:
                p.terminate()  # SIGTERM lets tcpdump finish the pcap file
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
            p.wait(timeout=5)
        extra = {}
        if cap and os.path.exists(cap["path"]):
            size = os.path.getsize(cap["path"])
            if size > 24:  # more than the pcap file header
                tok = os.path.basename(cap["path"])[:-5]
                self.pcaps[tok] = cap
                extra = {"pcap": tok, "pcap_name": cap["name"], "pcap_size": size}
            else:
                os.unlink(cap["path"])
        return p.returncode, extra
