#!/usr/bin/env python3
"""One-time migration for an existing Gatus setup: split the hand-written config into
   base (everything except `endpoints:`) and an endpoint list (JSON, anchors expanded)
   that netdash manages from then on.
   usage: gatus_split.py config.yaml out_base.yaml out_endpoints.json"""
import json
import sys

import yaml

src, out_base, out_json = sys.argv[1:4]
text = open(src, encoding="utf-8").read()
cfg = yaml.safe_load(text)
eps = cfg["endpoints"]
for e in eps:
    for k in list(e):
        if k.startswith("x-"):
            del e[k]
lines = text.splitlines(keepends=True)
start = next(i for i, l in enumerate(lines) if l.startswith("endpoints:"))
end = next(i for i, l in enumerate(lines) if i > start and l[:1].isalpha())
note = ("# The checks (endpoints) now live in 50-netdash.yaml and are edited in netdash (Dienste).\n"
        "# This file only keeps the base settings, alerting and templates.\n\n")
base = "".join(lines[:start]) + note + "".join(lines[end:])
open(out_base, "w", encoding="utf-8").write(base)
json.dump(eps, open(out_json, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(len(eps), "endpoints;", "base keys:", [k for k in yaml.safe_load(base)])
