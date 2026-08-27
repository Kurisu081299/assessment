# Northstar

Slim commerce intelligence dashboards for three companies, built from their Shopify
order exports and Meta ad exports. See [`NOTES.md`](NOTES.md) for the full data-quality
review and design rationale, [`CANDIDATE-BRIEF.md`](CANDIDATE-BRIEF.md) for the spec,
and [`CR2-RESPONSE.md`](CR2-RESPONSE.md) for the day-2 operator-request writeup.

This covers **Part A** (real schema, ingest, dashboards, tests), **Part B**
(scale ingest + latency), **Part C** (ingest against a flaky HTTP source), and
**Day 2** (`changes.zip`: a third company plus a week-over-week comparison,
and four operator requests answered DONE/DECLINED/CHANGED with evidence).

## Run it (one command)

Requires Node 18+ and npm.

```bash
npm install
npm start
```

`npm start` runs the ingest pipeline against `fixtures/`, builds the React app, and
starts the server on `http://localhost:4000`. It prints both dashboard URLs when it's
ready. From a fresh clone this is under a minute (`npm install` is the only slow step).

## Dashboards

| Company   | URL |
|-----------|-----|
| Lumen Co  | http://localhost:4000/d/551c26ff3a0ccd4f85eb6f247d4053475525c8d7244f9604 |
| Harbor Co | http://localhost:4000/d/668f37f9758664de0943d2954ea73b123991b18ef441faf2 |
| Fina Co   | http://localhost:4000/d/c2a67cb95295010773053ac849b8635f260e7774c8eabca3 |

An unknown or mistyped token returns a real HTTP 404, not a redirect and not the app
shell — try `http://localhost:4000/d/anything-else`.

## Re-running ingest

Ingest is idempotent — running it again against the same source files does not
change row counts or totals:

```bash
npm run ingest
```

See NOTES.md → "Idempotency proof" for the actual before/after output.

## Part B — scale (300k orders/company)

```bash
python3 tools/gen_scale_fixtures.py   # writes fixtures/scale/*.jsonl + EXPECTED.json
npm run ingest:scale                  # ingests into server/data/northstar.scale.sqlite
npm run bench                         # 90-day dashboard latency, 3 measurement tools
npm run serve:scale                   # serves the same two dashboard URLs off the scale DB
```

`ingest:scale` prints wall-clock time and peak RSS. `bench` prints in-process
hrtime (cold + 30 warm calls) and `EXPLAIN QUERY PLAN` for every query the
dashboard runs. The dashboard's 90-day render is **~80ms server-side once the
SQLite connection is warm** (see `NOTES.md` → "Bottleneck" for the full
before/after, including why the very first request after a restart used to be
slower and how that's handled now).

## Part C — failure handling (flaky source)

```bash
python3 tools/flaky_source.py       # http://127.0.0.1:8787, injects 5xx/429/
                                     # truncated bodies/a duplicate page
npm run ingest:flaky                # ingests from the flaky source into
                                     # server/data/northstar.flaky.sqlite
npm run prove:kill-safety           # SIGKILLs ingest mid-run, proves no
                                     # half-written state, then re-ingests
                                     # to completion and diffs vs. Part A
```

`ingest:flaky` finishes with exactly Part A's row counts and KPI totals —
see `NOTES.md` → "Part C — Failures" for the per-failure-mode handling and
the kill-safety proof.

## Stretch — re-ingest without a restart

Every dashboard has a **"Re-ingest now"** button in the footer. It calls
`POST /api/ingest` on the already-running server, which re-runs the exact
same pipeline the CLI uses against that server's own live DB connection —
no restart, no downtime. The dashboard refetches itself afterward so updated
numbers show up immediately.

```bash
curl -X POST http://localhost:4000/api/ingest
```

A second `POST` while one is already running gets `409 {"error":
"ingest_in_progress"}` instead of racing the first one's transactions.

## Tests

```bash
npm test
```

33 tests, asserting numbers (not "a function was called") for duplicate order rows,
UTC-timestamp timezone conversion in both directions, refund netting and refund-date
attribution, a spend-with-zero-orders day, inclusive date-range boundaries,
wrong-currency ad and order exclusion, voided-order exclusion, offset-less/ambiguous
timestamps, a same-batch order-id conflict, a negative-spend platform credit, the
week-over-week comparison (including its "no data" and zero-baseline cases),
the `POST /api/ingest` re-ingest endpoint (including the concurrent-request
guard), idempotent re-ingest, and — against the real `tools/flaky_source.py`,
not a mock — ingest reproducing Part A's exact totals while actually
triggering every injected failure mode.

## KPI definitions (in my own words)

All figures are in the company's own currency, bucketed by the **store-local**
calendar date (the company's IANA timezone, not UTC and not the server's clock).

- **Gross sales** — sum of `quantity × price` across every line item of every real
  order placed that day, before any refund is applied.
- **Net revenue** — gross sales minus refunds issued that day. A refund is dated by
  when the refund itself happened, not when the original order was placed — a refund
  issued today against last week's order shows up in today's net, not last week's.
- **Orders** — count of distinct real orders. A refund is not a second order (the
  source data models it as a separate record, but it's an event against an existing
  order, not a new sale), a byte-identical duplicate row from the export is not
  a second order either, and a **voided** order (payment authorization voided,
  nothing captured) is not a sale.
- **Ad spend** — sum of ad spend attributed to that store-local day, in the
  company's own currency. A resend of the exact same spend row doesn't double-count
  it; two genuinely different spend events for the same campaign on the same day
  both count; a real platform-issued credit (negative spend) reduces the total,
  since that's what the company was actually billed. A row reported in a different
  currency than the company's is excluded from the total and flagged, not silently
  converted or dropped — and the same rule applies to an **order** in the wrong
  currency, excluded from gross/net/order-count and shown separately.
- **ROAS** — net revenue ÷ ad spend for the day (or the range). Shown as an em dash
  when spend is 0 for that period, rather than a divide-by-zero or a blank.
- **Comparison strip** — the last day of the selected range vs. the same weekday
  one week earlier (both in the company's own timezone), for net revenue, orders,
  and ad spend. If either day has no data at all, the dashboard says so instead of
  a comparison; if a day has data but a metric's baseline is legitimately zero, that
  one metric shows "—" instead of a divide-by-zero or a misleading percentage.

## Architecture

- `server/` — Node/Express API + ingest pipeline, SQLite (`better-sqlite3`) storage.
- `web/` — React (Vite) single-page app, one route: `/d/:token`.
- Root `package.json` uses npm workspaces so a single `npm install` covers both.

## What's not built yet

The brief's commit-rule spacing requirement — at least two sessions 8+ hours apart —
is a real-world constraint on when these commits land, not something a single
implementation pass can satisfy; that's on the actual submission timeline, not the code.
