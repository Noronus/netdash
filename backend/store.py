"""Shared in-memory state and the SQLite store (device metadata, hourly totals, sessions)."""
import json
import os
import sqlite3
import threading
import time

DATA_DIR = os.environ.get("NETDASH_DATA", "/usr/local/netdash/data")


def now():
    return time.time()


def hour_of(ts):
    return int(ts // 3600 * 3600)


class State:
    """Thread-safe bag of the latest collector results.

    Each collector writes its own section; `sources` tracks freshness and errors so the
    UI can show which integration is down without the rest breaking.
    """

    def __init__(self):
        self.lock = threading.RLock()
        self.sections = {}
        self.sources = {}

    def put(self, name, value):
        with self.lock:
            self.sections[name] = value
            src = self.sources.setdefault(name, {})
            src["ok"] = True
            src["updated"] = now()
            src.pop("error", None)

    def fail(self, name, err):
        with self.lock:
            src = self.sources.setdefault(name, {})
            src["ok"] = False
            src["error"] = str(err)[:300]
            src["failed"] = now()

    def get(self, name, default=None):
        with self.lock:
            return self.sections.get(name, default)

    def snapshot(self):
        with self.lock:
            return {"sections": dict(self.sections), "sources": json.loads(json.dumps(self.sources))}


class DB:
    def __init__(self, path=None):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.path = path or os.path.join(DATA_DIR, "netdash.db")
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, timeout=30)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS device (
                mac TEXT PRIMARY KEY,
                name TEXT, icon TEXT, note TEXT,
                first_seen INTEGER, last_seen INTEGER,
                online_since INTEGER, last_ip TEXT, last_if TEXT
            );
            CREATE TABLE IF NOT EXISTS traffic (
                mac TEXT, hour INTEGER, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0,
                PRIMARY KEY (mac, hour)
            );
            CREATE TABLE IF NOT EXISTS dns (
                mac TEXT, hour INTEGER, queries INTEGER DEFAULT 0, blocked INTEGER DEFAULT 0,
                PRIMARY KEY (mac, hour)
            );
            CREATE TABLE IF NOT EXISTS iftraffic (
                ifname TEXT, hour INTEGER, rx INTEGER DEFAULT 0, tx INTEGER DEFAULT 0,
                PRIMARY KEY (ifname, hour)
            );
            CREATE TABLE IF NOT EXISTS session (
                token TEXT PRIMARY KEY, user TEXT, created INTEGER, expires INTEGER, ip TEXT
            );
            CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
            """
        )
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(device)")]
        if "place" not in cols:
            self.conn.execute("ALTER TABLE device ADD COLUMN place TEXT")
        if "last_name" not in cols:  # last name from UniFi / DHCP / DNS, kept while the device is off
            self.conn.execute("ALTER TABLE device ADD COLUMN last_name TEXT")
        self.conn.commit()

    def q(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def x(self, sql, args=()):
        with self.lock:
            self.conn.execute(sql, args)
            self.conn.commit()

    def many(self, sql, rows):
        if not rows:
            return
        with self.lock:
            self.conn.executemany(sql, rows)
            self.conn.commit()

    def kv_get(self, k, default=None):
        r = self.q("SELECT v FROM kv WHERE k=?", (k,))
        return json.loads(r[0][0]) if r else default

    def kv_set(self, k, v):
        self.x("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v)))

    def prune(self, keep_days=400):
        cut = hour_of(now()) - keep_days * 86400
        with self.lock:
            for t in ("traffic", "dns", "iftraffic"):
                self.conn.execute("DELETE FROM %s WHERE hour < ?" % t, (cut,))
            self.conn.execute("DELETE FROM session WHERE expires < ?", (int(now()),))
            self.conn.commit()


class Accumulator:
    """Buffers per-hour counter increments and flushes them in one transaction."""

    def __init__(self, db, table, cols, keycol):
        self.db = db
        self.table = table
        self.cols = cols
        self.keycol = keycol
        self.lock = threading.Lock()
        self.buf = {}

    def add(self, key, ts, *vals):
        h = hour_of(ts)
        with self.lock:
            cur = self.buf.get((key, h))
            if cur is None:
                self.buf[(key, h)] = list(vals)
            else:
                for i, v in enumerate(vals):
                    cur[i] += v

    def flush(self):
        with self.lock:
            items, self.buf = self.buf, {}
        if not items:
            return
        cols = ", ".join(self.cols)
        ph = ", ".join("?" for _ in self.cols)
        upd = ", ".join("%s=%s+excluded.%s" % (c, c, c) for c in self.cols)
        sql = "INSERT INTO %s(%s, hour, %s) VALUES(?, ?, %s) ON CONFLICT(%s, hour) DO UPDATE SET %s" % (
            self.table, self.keycol, cols, ph, self.keycol, upd)
        self.db.many(sql, [(k, h, *v) for (k, h), v in items.items()])

    def pending(self, key, since_hour):
        """Unflushed increments for `key` from `since_hour` on (to merge with DB rows)."""
        out = {}
        with self.lock:
            for (k, h), v in self.buf.items():
                if k == key and h >= since_hour:
                    out[h] = list(v)
        return out
