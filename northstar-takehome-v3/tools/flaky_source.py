#!/usr/bin/env python3
"""
Northstar mock source server — behaves like a third-party API on a bad day.

Serves the fixture files as paginated JSON with deterministic failures so a
candidate's ingest has to handle them. Stdlib only.

    python3 tools/flaky_source.py            # http://127.0.0.1:8787
    python3 tools/flaky_source.py --port 9000 --seed 7 --calm   # no failures

Endpoints
    GET /{company}/orders?cursor=<c>&limit=<n>
    GET /{company}/ads?cursor=<c>&limit=<n>
    GET /reset          -> clears failure counters (for a fresh run)
    GET /stats          -> what has been served / failed so far

Response shape
    {"data": [...], "next_cursor": "<c>" | null, "page": n}

Failure schedule (per process, deterministic from --seed):
    * every 4th request  -> 500 {"error": "upstream"}          (retry it)
    * every 7th request  -> 429 with Retry-After: 1            (back off, retry)
    * page 3 of any orders stream, first time only -> body truncated mid-JSON (re-fetch)
    * page 2 of any orders stream is served with the SAME next_cursor twice (duplicate page)
    * 1 in 15 responses  -> 2s latency
Everything is idempotent from the client's point of view; a correct ingest ends
with exactly the file totals.
"""
import argparse
import json
import os
import random
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "fixtures")
COMPANIES = ("lumen", "harbor", "fina")
SOURCES = {"orders": "shopify.orders.json", "ads": "meta.ads.json"}

STATE = {"requests": 0, "failed_500": 0, "failed_429": 0, "truncated": 0,
         "dup_pages": 0, "served": 0, "truncated_done": set(), "dup_done": set()}
CALM = False
RNG = random.Random(0)


def load(company, source):
    with open(os.path.join(FIXTURES, f"{company}.{SOURCES[source]}")) as f:
        return json.load(f)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter default log
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def _send(self, code, body, extra=None, truncate=False):
        raw = json.dumps(body).encode()
        if truncate:
            raw = raw[: max(10, len(raw) // 2)]
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)) if not truncate else str(len(raw) * 2))
        self.send_header("X-Request-Id", f"req-{STATE['requests']:05d}")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(raw)
            if truncate:
                self.wfile.flush()
                self.connection.close()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        if parts == ["reset"]:
            for k in ("requests", "failed_500", "failed_429", "truncated", "dup_pages", "served"):
                STATE[k] = 0
            STATE["truncated_done"].clear(); STATE["dup_done"].clear()
            return self._send(200, {"ok": True})
        if parts == ["stats"]:
            return self._send(200, {k: v for k, v in STATE.items() if not isinstance(v, set)})
        if len(parts) != 2 or parts[0] not in COMPANIES or parts[1] not in SOURCES:
            return self._send(404, {"error": "not found"})

        company, source = parts
        q = parse_qs(u.query)
        limit = max(1, min(int(q.get("limit", ["5"])[0]), 50))
        cursor = int(q.get("cursor", ["0"])[0])
        STATE["requests"] += 1
        n = STATE["requests"]

        if not CALM:
            if n % 4 == 0:
                STATE["failed_500"] += 1
                return self._send(500, {"error": "upstream"})
            if n % 7 == 0:
                STATE["failed_429"] += 1
                return self._send(429, {"error": "rate limited"}, {"Retry-After": "1"})
            if n % 15 == 0:
                time.sleep(2)

        rows = load(company, source)
        page_no = cursor // limit + 1
        chunk = rows[cursor: cursor + limit]
        nxt = cursor + limit if cursor + limit < len(rows) else None
        key = (company, source)

        if not CALM and source == "orders":
            if page_no == 3 and key not in STATE["truncated_done"]:
                STATE["truncated_done"].add(key); STATE["truncated"] += 1
                return self._send(200, {"data": chunk, "next_cursor": nxt, "page": page_no}, truncate=True)
            if page_no == 2 and key not in STATE["dup_done"]:
                STATE["dup_done"].add(key); STATE["dup_pages"] += 1
                nxt = cursor  # hand back the same cursor once -> client sees this page twice

        STATE["served"] += len(chunk)
        self._send(200, {"data": chunk,
                         "next_cursor": None if nxt is None else str(nxt),
                         "page": page_no})


def main():
    global CALM, RNG
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--calm", action="store_true", help="disable all failure injection")
    a = ap.parse_args()
    CALM = a.calm
    RNG = random.Random(a.seed)
    print(f"flaky source on http://127.0.0.1:{a.port}  (calm={CALM})")
    print("  e.g. curl 'http://127.0.0.1:%d/lumen/orders?cursor=0&limit=5'" % a.port)
    HTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
