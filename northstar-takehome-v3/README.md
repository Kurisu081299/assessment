# Northstar

Slim commerce intelligence dashboards for two companies, built from their Shopify
order exports and Meta ad exports. See [`NOTES.md`](NOTES.md) for the full data-quality
review and design rationale, and [`CANDIDATE-BRIEF.md`](CANDIDATE-BRIEF.md) for the spec.

This covers **Part A** (real schema, ingest, dashboards, tests) and **Part B**
(scale ingest + latency). Part C and the day-2 change requests are not yet
implemented.

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

## Tests

```bash
npm test
```

21 tests, asserting numbers (not "a function was called") for duplicate order rows,
UTC-timestamp timezone conversion in both directions, refund netting and refund-date
attribution, a spend-with-zero-orders day, inclusive date-range boundaries,
wrong-currency ad exclusion, and idempotent re-ingest.

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
  order, not a new sale), and a byte-identical duplicate row from the export is not
  a second order either.
- **Ad spend** — sum of ad spend attributed to that store-local day, in the
  company's own currency. A resend of the exact same spend row doesn't double-count
  it; two genuinely different spend events for the same campaign on the same day
  both count. A row reported in a different currency than the company's is excluded
  from the total and flagged, not silently converted or dropped.
- **ROAS** — net revenue ÷ ad spend for the day (or the range). Shown as an em dash
  when spend is 0 for that period, rather than a divide-by-zero or a blank.

## Architecture

- `server/` — Node/Express API + ingest pipeline, SQLite (`better-sqlite3`) storage.
- `web/` — React (Vite) single-page app, one route: `/d/:token`.
- Root `package.json` uses npm workspaces so a single `npm install` covers both.

## What's not built yet

Part B (scale/latency), Part C (flaky-source failure handling), and the day-2 change
requests (`changes.zip`) are out of scope for this pass and not implemented.

The brief's commit-rule spacing requirement — at least two sessions 8+ hours apart —
is a real-world constraint on when these commits land, not something a single
implementation pass can satisfy; that's on the actual submission timeline, not the code.
