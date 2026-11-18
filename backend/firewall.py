"""Firewall rules (OPNsense MVC filter API) with a safe apply, plus a live view of the filter log.

Safety: every change is journaled with its inverse operation. "Apply" reloads the filter and arms a
60 s deadman timer. Unless the browser confirms in time, netdash (running on the firewall itself)
replays the inverse operations and reloads again, so a lockout fixes itself.
"""
import collections
import datetime
import json
import os
import re
import threading
import time

LOG = "/var/log/filter/latest.log"
DEADMAN = 60
FLAT_SKIP = {"sort_order", "prio_group", "audit"}


def flatten(rule):
    """get_rule output (option dicts) -> plain values as set_rule expects them"""
    out = {}
    for k, v in rule.items():
        if k in FLAT_SKIP:
            continue
        if isinstance(v, dict):
            out[k] = ",".join(kk for kk, vv in v.items() if isinstance(vv, dict) and vv.get("selected"))
        else:
            out[k] = v
    return out


class Firewall:
    def __init__(self, app):
        self.app = app
        self.lock = threading.RLock()
        self.journal = []          # inverse ops of not yet confirmed changes, oldest first
        self.last = []             # journal of the last confirmed change set (for undo)
        self.status = "clean"      # clean | dirty | applied
        self.deadline = None
        self.timer = None
        self.history = collections.deque(maxlen=30)
        # live log
        self.buf = collections.deque(maxlen=6000)
        self.seq = 0
        self.rids = {}
        self.rids_at = 0
        self.log_path = None
        self.log_pos = 0

    @property
    def opn(self):
        return self.app.opn

    # ------------------------------------------------------------ read
    def rules(self):
        r = self.opn.get("/api/firewall/filter/search_rule?rowCount=-1&show_all=1", timeout=30)
        try:
            stats = self.opn.get("/api/firewall/filter_util/rule_stats").get("stats", {})
        except Exception:
            stats = {}
        rows = []
        for x in r.get("rows", []):
            st = stats.get(x["uuid"], {})
            rows.append({
                "uuid": x["uuid"], "enabled": x.get("enabled") == "1", "auto": bool(x.get("is_automatic") or x.get("legacy")),
                "sequence": int(x.get("sequence") or 0), "sort": x.get("sort_order"),
                "action": x.get("action"), "quick": x.get("quick", "1") == "1",
                "interface": x.get("interface", ""), "interface_label": x.get("%interface", ""),
                "direction": x.get("direction"), "ipprotocol": x.get("ipprotocol"), "protocol": x.get("protocol"),
                "source": x.get("source_net"), "source_not": x.get("source_not") == "1", "source_port": x.get("source_port"),
                "destination": x.get("destination_net"), "destination_not": x.get("destination_not") == "1",
                "destination_port": x.get("destination_port"), "log": x.get("log") in ("1", True),
                "description": x.get("description") or "", "categories": x.get("%categories") or x.get("categories") or "",
                "gateway": x.get("gateway") or "",
                "packets": st.get("packets"), "bytes": st.get("bytes"), "states": st.get("states"),
                "evaluations": st.get("evaluations"),
            })
        return rows

    def options(self):
        il = self.opn.get("/api/firewall/filter/get_interface_list")
        ifs = []
        for grp in il.values():
            for it in grp.get("items", []):
                ifs.append({"value": it["value"], "label": it["label"], "type": it.get("type")})
        no = self.opn.get("/api/firewall/filter/list_network_select_options")
        nets = []
        for key in ("networks", "aliases"):
            for v, l in ((no.get(key) or {}).get("items") or {}).items():
                nets.append({"value": v, "label": l, "type": key})
        blank = self.opn.get("/api/firewall/filter/get_rule").get("rule", {})
        choices = {}
        for k in ("action", "direction", "ipprotocol", "protocol"):
            v = blank.get(k)
            if isinstance(v, dict):
                choices[k] = [{"value": kk, "label": vv.get("value", kk)} for kk, vv in v.items() if isinstance(vv, dict)]
        return {"interfaces": ifs, "networks": nets, "choices": choices}

    def get(self, uuid):
        return flatten(self.opn.get("/api/firewall/filter/get_rule/" + uuid)["rule"])

    # ------------------------------------------------------------ write (journaled)
    def _check(self, r):
        if isinstance(r, dict) and r.get("result") == "failed":
            v = r.get("validations") or {}
            raise ValueError("; ".join("%s: %s" % (k.split(".")[-1], m) for k, m in v.items()) or "abgelehnt")
        return r

    def _begin(self):
        if self.status == "applied":
            raise ValueError("Es läuft noch eine Übernahme, bitte erst bestätigen oder zurücknehmen")
        self.status = "dirty"

    @staticmethod
    def _clean_rule(rule):
        allowed = {"enabled", "action", "quick", "interface", "interfacenot", "direction", "ipprotocol", "protocol",
                   "source_net", "source_not", "source_port", "destination_net", "destination_not", "destination_port",
                   "log", "description", "categories", "gateway", "statetype", "icmptype", "icmp6type", "sequence"}
        out = {k: ("1" if v is True else "0" if v is False else str(v)) for k, v in rule.items() if k in allowed and v is not None}
        return out

    def add(self, rule):
        with self.lock:
            self._begin()
            r = self._check(self.opn.post("/api/firewall/filter/add_rule", {"rule": self._clean_rule(rule)}))
            self.journal.append(("del", r["uuid"], None))
            return r["uuid"]

    def update(self, uuid, rule):
        with self.lock:
            old = self.get(uuid)
            self._begin()
            self._check(self.opn.post("/api/firewall/filter/set_rule/" + uuid, {"rule": self._clean_rule(rule)}))
            self.journal.append(("set", uuid, old))

    def delete(self, uuid):
        with self.lock:
            old = self.get(uuid)
            self._begin()
            self._check(self.opn.post("/api/firewall/filter/del_rule/" + uuid, {}))
            self.journal.append(("add", None, old))

    def toggle(self, uuid, enabled):
        with self.lock:
            old = self.get(uuid)
            self._begin()
            self._check(self.opn.post("/api/firewall/filter/toggle_rule/%s/%d" % (uuid, 1 if enabled else 0), {}))
            self.journal.append(("set", uuid, {"enabled": old.get("enabled", "1")}))

    def move(self, uuid, before):
        with self.lock:
            seqs = {r["uuid"]: str(r["sequence"]) for r in self.rules() if not r["auto"]}
            self._begin()
            self._check(self.opn.post("/api/firewall/filter/move_rule_before/%s/%s" % (uuid, before), {}))
            self.journal.append(("seq", None, seqs))

    def _inverse(self, ops):
        errors = []
        for kind, uuid, data in reversed(ops):
            try:
                if kind == "del":
                    self.opn.post("/api/firewall/filter/del_rule/" + uuid, {})
                elif kind == "set":
                    self.opn.post("/api/firewall/filter/set_rule/" + uuid, {"rule": data})
                elif kind == "add":
                    self.opn.post("/api/firewall/filter/add_rule", {"rule": data})
                elif kind == "seq":
                    for u, s in data.items():
                        self.opn.post("/api/firewall/filter/set_rule/" + u, {"rule": {"sequence": s}})
            except Exception as e:
                errors.append("%s %s: %s" % (kind, uuid or "", e))
        return errors

    def _reload(self):
        r = self.opn.post("/api/firewall/filter/apply", {}, timeout=120)
        if "OK" not in str((r or {}).get("status", "")).upper() and (r or {}).get("status") not in ("ok",):
            raise RuntimeError("filter reload: %s" % r)

    def apply(self):
        with self.lock:
            if self.status != "dirty" or not self.journal:
                raise ValueError("Keine offenen Änderungen")
            self._reload()
            self.status = "applied"
            self.deadline = time.time() + DEADMAN
            self.timer = threading.Timer(DEADMAN, self._deadman)
            self.timer.daemon = True
            self.timer.start()
            self.history.appendleft({"t": int(time.time()), "what": "übernommen", "n": len(self.journal)})

    def _deadman(self):
        with self.lock:
            if self.status != "applied":
                return
            errs = self._inverse(self.journal)
            try:
                self._reload()
            except Exception as e:
                errs.append(str(e))
            self.history.appendleft({"t": int(time.time()), "what": "automatisch zurückgenommen (keine Bestätigung)",
                                     "n": len(self.journal), "errors": errs})
            self.journal = []
            self.status = "clean"
            self.deadline = None

    def confirm(self):
        with self.lock:
            if self.status != "applied":
                return
            if self.timer:
                self.timer.cancel()
            self.last = self.journal
            self.journal = []
            self.status = "clean"
            self.deadline = None
            self.history.appendleft({"t": int(time.time()), "what": "bestätigt", "n": len(self.last)})

    def revert(self):
        """not applied yet: drop the changes; applied: roll back now; clean: undo the last confirmed set"""
        with self.lock:
            if self.status == "dirty":
                errs = self._inverse(self.journal)
                what = "verworfen"
                n = len(self.journal)
                self.journal = []
            elif self.status == "applied":
                if self.timer:
                    self.timer.cancel()
                errs = self._inverse(self.journal)
                errs += self._safe_reload()
                what, n = "zurückgenommen", len(self.journal)
                self.journal = []
            else:
                if not self.last:
                    raise ValueError("Nichts zum Rückgängigmachen")
                errs = self._inverse(self.last)
                errs += self._safe_reload()
                what, n = "letzte Änderung rückgängig gemacht", len(self.last)
                self.last = []
            self.status = "clean"
            self.deadline = None
            self.history.appendleft({"t": int(time.time()), "what": what, "n": n, "errors": errs})
            return errs

    def _safe_reload(self):
        try:
            self._reload()
            return []
        except Exception as e:
            return [str(e)]

    def txn(self):
        return {"status": self.status, "pending": len(self.journal), "can_undo": bool(self.last),
                "remaining": max(0, int(self.deadline - time.time())) if self.deadline else None,
                "history": list(self.history)[:10]}

    # ------------------------------------------------------------ live log
    def _rid_names(self):
        if time.time() - self.rids_at > 60:
            try:
                items = self.opn.get("/api/diagnostics/firewall/list_rule_ids").get("items", [])
                self.rids = {i["id"]: i["descr"] for i in items}
            except Exception:
                pass
            self.rids_at = time.time()
        return self.rids

    def _parse(self, line):
        i = line.find(" filterlog ")
        if i < 0:
            return None
        j = line.find("] ", i)
        if j < 0:
            return None
        ts = line[line.find(" ") + 1: line.find(" ", line.find(" ") + 1)]
        f = line[j + 2:].strip().split(",")
        if len(f) < 9:
            return None
        try:
            t = datetime.datetime.fromisoformat(ts).timestamp()
        except ValueError:
            t = time.time()
        e = {"rid": f[3], "if": f[4], "action": f[6], "dir": f[7], "ver": f[8], "t": t}
        try:
            if f[8] == "4":
                e.update(proto=f[16], len=f[17], src=f[18], dst=f[19])
                rest = f[20:]
            elif f[8] == "6":
                e.update(proto=f[12], len=f[14], src=f[15], dst=f[16])
                rest = f[17:]
            else:
                return None
            if e["proto"] in ("tcp", "udp") and len(rest) >= 2:
                e["sport"], e["dport"] = rest[0], rest[1]
                if e["proto"] == "tcp" and len(rest) >= 4:
                    e["flags"] = rest[3]
        except IndexError:
            return None
        return e

    def collect_log(self):
        path = os.path.realpath(LOG)
        skip_partial = False
        if path != self.log_path:
            first = self.log_path is None
            self.log_path = path
            self.log_pos = max(0, os.path.getsize(path) - 1_500_000) if first else 0
            skip_partial = self.log_pos > 0
        elif os.path.getsize(path) < self.log_pos:
            self.log_pos = 0
        with open(path, "rb") as fh:
            fh.seek(self.log_pos)
            data = fh.read(8 << 20)
        if skip_partial:
            nl = data.find(b"\n")
            data = data[nl + 1:]
            self.log_pos += nl + 1
        end = data.rfind(b"\n")
        if end < 0:
            return
        self.log_pos += end + 1
        names = self._rid_names()
        for raw in data[:end].split(b"\n"):
            e = self._parse(raw.decode("utf-8", "replace"))
            if e:
                self.seq += 1
                e["seq"] = self.seq
                e["rule"] = names.get(e["rid"], "")
                self.buf.append(e)

    def log_since(self, since, limit=400):
        out = [e for e in list(self.buf) if e["seq"] > since]
        return out[-limit:]

    def log_stats(self, minutes=5):
        cut = time.time() - minutes * 60
        c = collections.Counter()
        src = collections.Counter()
        port = collections.Counter()
        for e in list(self.buf):
            if e["t"] < cut:
                continue
            c[e["action"]] += 1
            if e["action"] == "block":
                src[e["src"]] += 1
                if e.get("dport"):
                    port[e["proto"] + "/" + e["dport"]] += 1
        return {"pass": c["pass"], "block": c["block"], "top_src": src.most_common(8), "top_port": port.most_common(8),
                "entries": len(self.buf)}
