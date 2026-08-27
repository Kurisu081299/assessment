# NOTES

## Starter review

Reviewed `starter/northstar_starter.py` against `fixtures/lumen.shopify.orders.json`,
`fixtures/lumen.meta.ads.json`, `fixtures/harbor.shopify.orders.json`, and
`fixtures/harbor.meta.ads.json` — the small fixtures, not the scale data. I ran the
script as-is (`python3 starter/northstar_starter.py`), then wrote a second script that
recomputes the same KPIs against the letter of the KPI contract (real tz conversion via
`zoneinfo`, `Decimal` money, id-based dedup, refund records excluded from gross/order
counts, inclusive range, foreign-currency ad rows excluded from spend) and diffed the
two, day by day, for both companies. Every number below is from that diff, not eyeballed.

Verdict up front: **discard it as a pipeline, keep it as a rough sketch of the shape**
(per-company ingest of orders + ads into day buckets, then a KPI report). Nine defects
below, and they touch every function in the file — `order_day`, `in_range`,
`ingest_orders`, `ingest_ads`, and `report` all have at least one bug. Patching in place
would mean rewriting the body of each function anyway, and Part A already requires a
real schema (orders, line items, refunds, ad rows) that this script doesn't have at all
— it holds everything in `defaultdict`s and prints once. There's nothing here worth
preserving as code. What *is* worth preserving: the script is honest about scope in its
docstring ("no database yet"), and its day-bucket-then-print structure is a reasonable
first sketch of the reporting shape, so I used it as a starting mental model, not as a
starting file.

### 1. Refund records are ingested as brand-new full-price orders

The data models a refund as a **separate record** — `id` suffixed `-R`,
`financial_status: "refunded"`, `refund_of` pointing at the original, and its own
`created_at` — that repeats the original's `line_items`. `ingest_orders()` (line 59-71)
never checks `financial_status` or `refund_of`; it sums `line_items` and increments the
order counter for *every* record in the file, refund or not.

- **Proof (Lumen):** `L-1003` ($192, Aug 3) is refunded in full by `L-1003-R` (Aug 4).
  The script's printed Aug 4 row shows `2 orders, $278.00 gross, $192.00 refunds` — the
  refund record contributed a second "order" and $192 of phantom gross that only nets
  to zero because its own `total_refunded` happens to equal its own line-item total.
- **Proof (Harbor, the sharper case — partial refund):** `H-201` ($90, Aug 1) is
  partially refunded for $80 by `H-201-R` (Aug 11), but `H-201-R`'s line items still sum
  to the *original* $90, not the refunded $80. The script's printed Aug 11 row shows
  `2 orders, $330.00 gross, $80.00 refunds, $250.00 net`. Correct: 1 real order
  (`H-210`, $240) plus the $80 refund against `H-201` = **$160.00 net**, not $250.00 — a
  **56% overstatement** on that single day, plus one order that isn't a distinct real
  order.
- **KPI effect:** inflates gross sales and the orders count on every day a refund
  posts; net revenue is only accidentally close to right when the refund is a full
  refund (Lumen) and wrong whenever it's partial (Harbor).

### 2. Exact-duplicate order rows have no dedup at all

`L-1007` and `H-204` each appear twice in their fixture files, byte-for-byte identical,
no refund marker. `ingest_orders()` has no id-based or hash-based dedup — only
`ingest_ads()` dedupes, and only ads (see #4).

- **Proof:** printed Harbor Aug 4 row is `2 orders, $480.00 gross` — entirely `H-204`
  counted twice. Correct: 1 order, $240.00. Same pattern for Lumen `L-1007` on Aug 7
  ($172.00 printed vs. $86.00 correct).
- **KPI effect:** overstates gross and orders by exactly one order's worth, on any day
  a duplicate row lands. The brief's own Part A requirement ("re-running ingest is
  idempotent") makes this the same bug class as a non-idempotent re-ingest — the
  starter has no defense against either.

### 3. UTC (`Z`) timestamps are sliced as if they were already store-local

The comment above `order_day()` (line 46) asserts "the date is always the first ten
characters," which is only true when `created_at` already carries the store's own
offset. Two records use a bare `Z` (UTC) timestamp instead of a local offset:
`L-1009` (`2026-08-05T06:30:00Z`) and `H-207` (`2026-08-07T14:30:00Z`).

- **Proof:** `L-1009` at 06:30 UTC is 23:30 on **Aug 4** in `America/Los_Angeles`
  (UTC-7 in August); the naive slice reports Aug 5 — a full day late. `H-207` at 14:30
  UTC is 00:30 on **Aug 8** in `Australia/Sydney` (UTC+10, no DST in southern-hemisphere
  winter); the naive slice reports Aug 7 — a full day early. I confirmed both
  conversions with `zoneinfo`, not by hand.
- **KPI effect:** moves real revenue and order counts across day boundaries in both
  directions (late for Lumen, early for Harbor), so it's not a consistent one-directional
  bias you could offset. The scale generator injects this exact class of record at a 2%
  rate (`gen_scale_fixtures.py` line 14), so at 300k rows this misattributes a meaningful
  slice of revenue across day boundaries, not just two records.

### 4. Ad-spend dedup collapses legitimate same-day spend, not just resends

The docstring claims "Meta re-sends rows; key on (campaign, date) so a re-send can't
double count," and `ingest_ads()` (line 74-84) dedupes by keeping the **last** row seen
per `(campaign_id, date)`. But `L-C1` on Aug 5 has *two* rows with different
`date_start` timestamps, impressions, and clicks ($61.00 and $67.40) — two genuinely
separate spend events on the same day, not a resend of the same row.

- **Proof:** printed Lumen Aug 5 spend is $89.90 ($67.40 kept + $22.50 from `L-C2`).
  The dropped $61.00 row is real spend, confirmed by its distinct `date_start` and
  distinct impression/click counts — a true resend would repeat all three. Correct Aug 5
  spend: $150.90.
- **KPI effect:** understates ad spend and inflates ROAS on any day with two genuine
  spend events for the same campaign. A resend needs to be identified by full-row (or
  request-id) equality, not by collapsing the `(campaign, date)` key — which is exactly
  what the scale generator does when it writes duplicate JSONL rows to be *summed*, not
  collapsed (see the mock source's `EXPECTED.json`, which sums same-day multi-row spend).

### 5. A wrong-currency ad row is added to spend as if it were the store's currency

Harbor's ad fixture contains `H-C9`, `"Harbor US retarget (wrong account)"`, $25.00
spend in `currency: "USD"`, sitting inside an AUD account's export on Aug 12.
`ingest_ads()` never inspects `currency` — it just does `float(rec["spend"])`.

- **Proof:** printed Harbor Aug 12 row shows spend $94.00 (69.00 AUD + 25.00
  USD-treated-as-AUD). Correct AUD spend for that day is $69.00; the $25.00 USD row
  should be excluded from the total and surfaced separately — 25 USD and 25 AUD are not
  the same amount of money, and the KPI contract requires unsupported rows to be
  "visible somewhere — never silently dropped, never silently fixed." This row is
  neither dropped nor fixed; it's silently miscounted, which is worse than either.
- **KPI effect:** overstates spend (~36% on that day) and understates ROAS, and there
  is currently no way for an operator to know a foreign-currency row is even in the data.

### 6. Default range is exclusive of the end date; the brief says inclusive

`in_range()` (line 50-51) is `RANGE_START <= day < RANGE_END` with
`RANGE_END = "2026-08-14"`, so Aug 14 is silently dropped even though the brief states
the range is "2026-08-01 … 2026-08-14 **inclusive**."

- **Proof:** Lumen's Aug 14 ad row ($49.15) and Harbor's Aug 14 order (`H-213`, $90.00)
  and ad row ($80.00) never appear anywhere in the starter's output — not in the day
  table, not in the total.
- **KPI effect:** drops an entire day of real revenue and spend from both companies'
  reports, every time the pipeline runs against the stated default range.

### 7. Days with ad spend but zero orders are silently dropped from the report

`report()` (line 92) builds its day list from `set(gross) | set(orders)` — a day that
has ad spend but no entry in `gross` or `orders` never gets a row at all. This is the
exact case the brief names explicitly: "a day with spend and no sales is still a day."

- **Proof:** Lumen's Aug 9 has $39.50 of real ad spend (`L-C1`) and zero orders; it
  never appears in the printed per-day table. I confirmed this arithmetically before
  trusting the diff script: summing every Lumen ad row in range by hand gives $661.00
  (using inclusive range), the script prints a spend total of $621.50, and the gap is
  exactly the missing Aug 9 row plus the missing Aug 14 row (bug #6). Harbor shows the
  identical pattern on its own Aug 9 ($90.00 spend, no orders, missing from the table).
- **KPI effect:** understates total spend, and — more importantly for grading — this is
  the one bug Part A explicitly tells the candidate to write a test for. A test that
  only checks the *total* doesn't crash, rather than checking the day actually appears
  as a row, would pass against this broken behavior.

### 8. Records that can't be dated are dropped with no visible trace

`order_day()` returns `None` when `created_at` is missing, and `ingest_orders()`
(line 61-62) does `continue` with only a code comment ("nothing we can do with it") —
no counter, no log, no row anywhere in the output.

- **Proof:** `L-1014` ($99.00, Aug 8-ish based on its neighbors, but `created_at: null`)
  disappears from the Lumen report entirely. There is no way to tell from the script's
  output that this record was ever in the source file, let alon that it was excluded.
- **KPI effect:** none on the printed numbers (it's excluded either way), but this is
  a direct violation of the KPI contract's "must be visible somewhere — never silently
  dropped" rule. The scale generator tracks this exact case as a separate
  `unattributed_total` counter in its own accounting (`gen_scale_fixtures.py` line 57,
  120) precisely because it expects a real pipeline to surface it, not just swallow it.

### 9. Money is accumulated in native `float`, not `Decimal`

`gross`, `refunds`, and `spend` are all `defaultdict(float)`, and line totals are
`float(li["price"]) * li["quantity"]`. On these small fixtures I did not find an
observable cent-level discrepancy — the numbers happen to be round enough that float
addition doesn't visibly drift in the 2-decimal-place output. But `0.1 + 0.2 == 0.30000000000000004` in float and `Decimal('0.1') + Decimal('0.2') == Decimal('0.3')`
in Python, and that's the exact failure mode `gen_scale_fixtures.py` avoids by computing
`EXPECTED.json` with `Decimal` throughout. At 300k+ rows per company, float accumulation
is a real, growing source of cent-level drift against that answer key, and it also means
the same input can produce slightly different totals depending on **summation order** —
which makes "idempotent re-ingest" (a hard Part A requirement) unverifiable by exact
equality. This is a forward-looking risk rather than a provable bug in the small
fixtures, but it's real enough that I'm treating it as defect #9, not a footnote.

### What the total-level numbers hide

Two of these bugs partially cancel in the Harbor **total** gross figure: the duplicate
`H-204` overstates gross by $240, the refund-as-order `H-201-R` overstates it by
another $90, and the exclusive-range bug (#6) *drops* a real $90 order (`H-213`), so the
printed total ($2,820.00) is only $240.00 off from the correct total ($2,580.00) — which
looks like a single small error if you only check the total. Per-day, the picture is far
worse: Aug 4 is overstated by 100% ($480 vs. $240) and Aug 11 by 37.5% ($330 vs. $240).
**A total-only sanity check would not have caught this.** This is the main reason I'm
treating "does the printed total look plausible" as worthless for reviewing this script,
and why every claim above is checked at the day-row level, not the total.

### Full corrected KPI table (small fixtures, for reference)

Recomputed with: `zoneinfo`-based store-local dates, `Decimal` money, id-based order
dedup, refund records excluded from gross/orders and applied to the refund's own local
date, inclusive `2026-08-01..2026-08-14` range, and foreign-currency ad rows excluded
from spend (would be surfaced separately in a real pipeline, per bug #5/#8's contract
requirement).

**Lumen Co (USD)** — starter TOTAL: 15 orders / $2,028.00 gross / $192.00 refunds /
$1,836.00 net / $621.50 spend / 2.95 ROAS.
Corrected TOTAL: **13 orders / $1,750.00 gross / $192.00 refunds / $1,558.00 net /
$771.15 spend / 2.02 ROAS.** Gross overstated by $278.00 (dup `L-1007` $86 + refund-as-
order `L-1003-R` $192); spend understated by $149.65 (Aug 5 dedup miss $61.00 + missing
Aug 9 $39.50 + missing Aug 14 $49.15); reported ROAS overstated by ~46% relative.

**Harbor Co (AUD)** — starter TOTAL: 15 orders / $2,820.00 gross / $80.00 refunds /
$2,740.00 net / $931.10 spend / 2.94 ROAS.
Corrected TOTAL: **14 orders / $2,580.00 gross / $80.00 refunds / $2,500.00 net /
$1,076.10 spend / 2.32 ROAS** (plus $25.00 foreign-currency spend excluded and flagged
separately, per the KPI contract). Reported ROAS overstated by ~27% relative.

### Decision

**Discard the starter script; do not build on it.** Every one of its five functions has
at least one defect that requires touching the function body, not a parameter; it holds
no schema (Part A requires one); and it has no handling for duplicates, refunds,
timezones, currency, or unusable rows — which is the entire content of Part A's test
requirement (§ "duplicates, timezone conversion, refunds, and a day with spend but no
orders"). Writing correct versions of those four behaviors *is* Part A. The only things
I'm carrying forward from it: the constant `COMPANIES` config shape (tz + currency per
company) and the general per-company, per-source ingest → day-bucket → report structure,
both because they're reasonable, not because the code implementing them is reusable.

---

## Part A — schema, dedupe rule, timezone/refund rules, idempotency proof

### Schema

Real tables, not `defaultdict`s: `companies`, `orders`, `line_items`, `refunds`,
`ad_spend`, `ingest_issues`, `ingest_runs`. Money is integer cents everywhere past
ingest (parsed from the source decimal strings by string splitting, not `float()` —
fixes defect #9 without a bignum dependency). Store-local dates are computed **once,
at ingest time**, via `Intl.DateTimeFormat` with the company's IANA timezone, and
stored on the row — not recomputed per query. See
[`server/src/migrate.js`](../northstar-takehome-v3/server/src/migrate.js),
[`server/src/money.js`](../northstar-takehome-v3/server/src/money.js),
[`server/src/timezone.js`](../northstar-takehome-v3/server/src/timezone.js).

### Dedupe rule

- **Orders**: a record with `refund_of` set is routed to the `refunds` table, never
  the `orders` table (fixes defect #1). A plain order upserts on
  `UNIQUE(company_id, source_order_id)` — a byte-identical duplicate row (`L-1007`,
  `H-204`) collapses to one order because it shares that key (fixes defect #2). Line
  items are deleted and re-inserted under the same order id on every upsert, so a
  changed source row can't leave stale line items behind.
- **Refunds**: keyed on `UNIQUE(company_id, source_refund_id)`, amount taken from
  `total_refunded` (not the line-item sum) — Harbor's `H-201-R` is a genuine partial
  refund ($80 of a $90 order), so using the line-item total would overstate the
  refund by $10.
- **Ad rows**: keyed on a SHA-256 hash of the *entire* row (campaign, date,
  `date_start`, spend, currency, impressions, clicks), not `(campaign_id, date)`. A
  byte-identical resend hashes the same and is skipped; two genuinely different spend
  events for the same campaign on the same store-local day both hash differently and
  both get summed. This is the direct fix for defect #4, and it's also what CR2 item
  #1 ("dedupe ad rows on campaign ID + date") will need to be **declined** against —
  see the reasoning below, since that's the exact rule that caused the original bug.

### Timezone and refund rules

- **Order date** = store-local calendar date of `created_at`, converted via the
  company's IANA timezone from the record's true instant (handles both a `-07:00`
  offset and a bare `Z`/UTC timestamp correctly — fixes defect #3).
- **Refund date** = the refund record's *own* `created_at`, not the original order's
  date. Per the KPI contract ("a refund lands on the refund's own store-local date"),
  this is required, not a choice — `H-201-R` (issued Aug 11) refunding `H-201`
  (placed Aug 1) must show the $80 hit on Aug 11, and it does.
- **Ad spend date**: derived from `date_start` (the same tz-conversion function used
  for orders), **not** the row's own `date` field. This was originally going to be a
  "why bother, they always agree" design note — until building the real pipeline
  found one row where they don't (below).

### A second timezone bug the Starter review didn't catch

While building `ad_dedup.test.js` I compared every ad row's `date` field against the
store-local date computed from its own `date_start`, across both fixtures (30 rows).
Every row agrees **except one**: Lumen's `L-C1` row with `date_start:
"2026-08-05T06:00:00Z"` — labeled `"date": "2026-08-05"`, but 06:00 UTC is 23:00 on
**Aug 4** in `America/Los_Angeles`. Same bug class as defect #3 (a UTC timestamp only
looks store-local if you don't check), just on the ad side, and planted on the exact
row the Starter review already flagged for a different reason (defect #4's "two
genuine same-day spend events").

That matters because it changes what "genuine same-day spend events" means: once you
bucket by the true store-local date instead of trusting `date`, `L-C1`'s two Aug-5-
labeled rows land on **different, correct days** ($61.00 → Aug 4, $67.40 → Aug 5),
and there's no longer a genuine same-campaign-same-day case anywhere in the small
fixtures. The Starter review's own "corrected" defect #4 figure — Aug 5 spend
$150.90 — was itself computed by trusting the `date` field, which is exactly the
shortcut this whole exercise argues against. The real Aug 5 spend is **$89.90**
($67.40 + $22.50 from `L-C2`); Aug 4 gains a real $61.00 it didn't have under any
`date`-trusting read. The grand total is unaffected either way (still $771.15 for
Lumen) since it's just a resplit across two days within range — see
`server/test/ad_dedup.test.js` for the pinned numbers and
[bug #4's original writeup](#4-ad-spend-dedup-collapses-legitimate-same-day-spend-not-just-resends)
above, which I'm leaving as originally written rather than editing after the fact —
this note is the correction.

### Idempotency proof

`node server/src/ingest/run.js`, run three times in a row against the same
persistent DB (no data reset between runs):

```
=== RUN 1 (fresh DB) ===
Lumen Co (lumen): orders upserted 14, refunds upserted 1, ad rows upserted 15, issues logged 1
Harbor Co (harbor): orders upserted 15, refunds upserted 1, ad rows upserted 15, issues logged 1

=== RUN 2 (same DB, re-ingest) ===
Lumen Co (lumen): orders upserted 14, refunds upserted 1, ad rows upserted 0, ad rows skipped (exact duplicate) 15, issues logged 1
Harbor Co (harbor): orders upserted 15, refunds upserted 1, ad rows upserted 0, ad rows skipped (exact duplicate) 15, issues logged 0
```

("orders/refunds upserted" counts *upsert operations* — every real order is
processed and its row is written to, both runs, which is correct upsert behavior —
not new rows; "ad rows upserted" drops to 0 on the second run because every row
already exists under its content hash. `issues logged` on run 2 is lower because
`INSERT ... ON CONFLICT DO UPDATE` doesn't re-fire the currency-mismatch check for a
row that's already a duplicate-skip — the issue itself is still in the table from run
1, just not re-counted as "newly detected" on run 2.)

Row counts, queried directly, after 2 and then a 3rd ingest run against the same DB:

```
$ sqlite3 server/data/northstar.sqlite "SELECT 'orders', COUNT(*) FROM orders UNION ALL
  SELECT 'line_items', COUNT(*) FROM line_items UNION ALL
  SELECT 'refunds', COUNT(*) FROM refunds UNION ALL
  SELECT 'ad_spend', COUNT(*) FROM ad_spend UNION ALL
  SELECT 'ingest_issues', COUNT(*) FROM ingest_issues;"

after run 2: orders|27  line_items|39  refunds|2  ad_spend|30  ingest_issues|2
after run 3: orders|27  line_items|39  refunds|2  ad_spend|30  ingest_issues|2
```

Identical after the 2nd and 3rd runs — re-ingesting the same source files is a
no-op. This is also asserted directly (row counts *and* KPI totals, not just "it ran
without error") in `server/test/idempotency.test.js`:

```
$ npm test --workspace server
✔ re-running ingest twice produces identical row counts (32.4ms)
✔ re-running ingest twice produces identical KPI totals (6.8ms)
✔ re-running ingest three times is still stable (6.9ms)
...
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

Full corrected KPI totals (Lumen 13/$1,750.00/$192.00/$1,558.00/$771.15/2.02,
Harbor 14/$2,580.00/$80.00/$2,500.00/$1,076.10/2.32 — see the table above) are
reproduced exactly by the real pipeline; see `server/test/totals.test.js`.

### A note on commit-size mechanics

One commit (`Part A: npm workspace scaffold, SQLite schema, money/timezone helpers`)
shows ~3,300 insertions in `git log --stat`, which on its own would read as well over
the 40%-of-final-line-count cap. Essentially all of that is `package-lock.json` —
generated by `npm install` resolving `better-sqlite3`, `express`, `react`, `vite`, and
their transitive dependencies for the two-workspace layout, not authored code. The
actual hand-written diff in that commit is ~90 lines across 7 files (schema DDL,
migration, money/timezone helpers, package configs). I considered removing the
lockfile from version control to dodge this, but that would make the historical
commit's percentage against a smaller final total look *worse*, not better, and
reproducible installs are worth more than a clean-looking stat here — so I'm leaving
it as-is and flagging it plainly instead.

---

## Part B — scale ingest, and Bottleneck

### Generating and ingesting the scale fixtures

`python3 tools/gen_scale_fixtures.py` (defaults: 300k orders/company, 730 days,
ending `2026-08-14`) writes `fixtures/scale/{lumen,harbor}.shopify.orders.jsonl`,
`{lumen,harbor}.meta.ads.jsonl`, and `EXPECTED.json` (last-90-day answer key).
Generation itself: **7.97s wall, 19.3MB peak RSS** (`/usr/bin/time -l python3 ...`).

Ingest needed two changes, not a rewrite: `loadFixtures.js` now reads JSONL
line-by-line instead of `JSON.parse`-ing one JSON array (`NORTHSTAR_FIXTURES=scale`
switches it on; default behavior for the small fixtures is untouched), and
`ingest/run.js` reports wall clock (`process.hrtime.bigint()`) and peak RSS
(`process.resourceUsage().maxRSS`, which is the process's true peak since start,
not a periodic sample) after the run. Everything else — schema, upsert keys,
dedup rules, transaction boundaries — is unchanged from Part A.

```
$ npm run ingest:scale
Ingest success — started 2026-08-26T12:39:38.500Z, finished 2026-08-26T12:39:51.677Z
Wall clock: 13178.3 ms   Peak RSS: 775.0 MB

Lumen Co (lumen)
  source: 311992 order records, 2307 ad records
  orders upserted:   302123
  refunds upserted:  8955
  issues logged: 920

Harbor Co (harbor)
  source: 312168 order records, 1544 ad records
  orders upserted:   302149
  refunds upserted:  9138
  issues logged: 891
```

**13.2s wall clock, 775MB peak RSS, for both companies combined** (~624k order
records, ~1M line items, ~18k refunds, ~3.9k ad rows, one Node process, single
`db.transaction` per company per source — same batching pattern as Part A, just
at 300k-order volume instead of a dozen).

Correctness at scale: `getDashboardData` for each company's last-90-day range
matches `EXPECTED.json` **exactly**, to the cent, on every field (orders, gross,
net, spend) — checked by loading both and diffing in Node, not eyeballed:

```
Lumen Co:  got orders=36993 gross=5015510.00 net=4883491.00 spend=19986.31
Lumen Co:  exp orders=36993 gross=5015510.00 net=4883491.00 spend=19986.31
Harbor Co: got orders=37345 gross=9986425.00 net=9719075.00 spend=13572.92
Harbor Co: exp orders=37345 gross=9986425.00 net=9719075.00 spend=13572.92
```

### Bottleneck

**What was slow first.** Not a missing index — `EXPLAIN QUERY PLAN` on all four
of `getDashboardData`'s queries shows index seeks (`SEARCH ... USING [COVERING]
INDEX idx_*`), never a table scan, at scale. The actual first-found cost was the
**gross-sales query** (`line_items JOIN orders ... GROUP BY store_local_date`) on
a **freshly opened SQLite connection** — a cold hit on that join costs ~5-8x a
warm one, because it's the query that touches the most distinct b-tree pages
(the join fans out from ~37k matching orders to their line items via an index
seek per order, so a cold connection has to page in and decode each one for the
first time; a warm connection just re-reads already-decoded pages from SQLite's
own cache).

**How measured, three tools, on the ingested scale DB:**

1. *In-process Node hrtime* (`server/scripts/bench-dashboard.js`), the same
   function the API route calls, one cold call then 30 warm calls, per company:
   ```
   ## Lumen Co (lumen)
     cold: 477.70ms   warm min/p50/p95/max: 79.38/80.78/94.58/144.67 ms
   ## Harbor Co (harbor)
     cold: 466.20ms   warm min/p50/p95/max: 77.06/79.36/81.23/82.60 ms
   ```
2. *Isolated repro*, the gross query alone, fresh `better-sqlite3` connection,
   same statement object run twice:
   ```
   cache_size pragma: -16000
   run 1 (cold conn): 584.85 ms
   run 2 (warm):        72.71 ms
   ```
3. *`sqlite3` CLI, `.timer on`*, all four `getDashboardData` queries run in
   sequence on one fresh connection (output suppressed so only query time is
   timed, not terminal printing) — confirms the other three queries were never
   the problem:
   ```
   gross:      Run Time: real 0.572   (incl. connection's first page-ins)
   orderCount: Run Time: real 0.003
   refunds:    Run Time: real 0.007
   spend:      Run Time: real 0.001
   ```
   Plus `EXPLAIN QUERY PLAN` on the gross query:
   `SEARCH o USING COVERING INDEX idx_orders_company_date`, then
   `SEARCH li USING INDEX idx_line_items_order (order_id=?)` — both index seeks.

**Why it matters in production, not just in a benchmark:** `server.js` opens
**one** SQLite connection for the process's whole life (`createApp(db)` is
called once at startup with one `db`), so this cold-connection cost isn't a
per-request tax — it's a one-time tax that, without a fix, lands entirely on
whichever real user's request happens to be first after a deploy or restart.
At ~470-580ms that request would blow the 500ms budget; every request after it
was already ~80ms, comfortably inside it.

**What changed:** `server.js` now runs a `warmDashboardCache(db)` pass — one
`getDashboardData` call per company over the same 90-day range — *before*
`app.listen`, so the cold-connection cost is paid once at boot, off the request
path, instead of on a user. (`kpi.js`'s queries and `migrate.js`'s indexes are
untouched — this is a startup-sequencing fix, not a query fix, because the
query plan was already correct.)

**Before/after**, real server, real HTTP, first request after a cold start
(`Server-Timing` header = the exact server-side render time; `curl` total =
full round trip including JSON serialization + network):

```
# before (no warmup): first HTTP request after boot
Server-Timing: dashboard;dur≈470-580          (over/at the 500ms budget)

# after (npm run serve:scale): server log at boot
Warmed dashboard cache for 2026-05-17..2026-08-14 in 1235.0ms

# after: first real HTTP request, immediately after that boot line
HTTP/1.1 200 OK
Server-Timing: dashboard;dur=83.55
curl total time: 0.094638s
```

The 500ms tax still happens — it just happens once, at boot, where nobody is
waiting on it, instead of on the first operator to open the link.

**What breaks next, and at what size.** The dashboard payload for the 90-day
range is 155,997 bytes; **143,865 of those bytes (92%) are the `issues` array**
(914 rows for Lumen at this scale), not the KPI daily table (90 rows). That
query —
`SELECT ... FROM ingest_issues WHERE company_id = ? ORDER BY detected_at DESC`
— is fast today (1.17ms warm, 914 rows) but has two properties nothing else in
`getDashboardData` has: **no `LIMIT`**, and **no relationship to the requested
date range at all** — it returns every issue ever logged for the company,
forever, regardless of what `start`/`end` the caller asked for. Its
`EXPLAIN QUERY PLAN` also shows `USE TEMP B-TREE FOR ORDER BY` — there's no
index on `detected_at`, so every request re-sorts the full table.

Issue rows grow linearly with order volume (the scale generator's fixed
0.3%-missing-`created_at` rate dominates the issue count) *and* accumulate
across every ingest run over time, unlike the KPI tables, which are always
windowed to the requested range. Extrapolating from today's 914 rows /
143.9KB at 300k orders/company:
- **~10x (≈3M orders/company):** ~9,100 issue rows, ~1.4MB just for this one
  array in the JSON payload — still probably survives the query-time budget,
  but the response is now mostly issues, not KPIs, and payload size starts
  dominating wall-clock over the network.
- **~100x (≈30M orders/company):** ~91,000 issue rows, ~14MB of JSON, and the
  unindexed `ORDER BY` over that many rows stops being free — this is
  roughly where I'd expect the *query* time, not just the payload, to start
  eating into the 500ms budget on its own, on a code path that today looks
  nowhere near the bottleneck.

The fix, if this were going to production at that volume, is the same shape as
everywhere else in this schema: window `ingest_issues` by date like the other
four tables (it already has `detected_at`), paginate or cap it, and add an
index that makes the `ORDER BY` free — I didn't make this change because it
isn't needed at the tested scale and the brief asks what breaks next, not to
fix problems that don't exist yet at the size actually being tested.

---

## Part C — Failures

### Design: fetch fully, then write atomically

`server/src/ingest/httpSource.js` fetches an entire (company, source) stream —
following `next_cursor` through every page, with retries — into a plain array
in memory, and only returns once that array is complete. `ingestOrders`/
`ingestAds` never see a partial page; they receive the same shape of array
whether it came from a local file (Part A) or from `tools/flaky_source.py`
(Part C). No database write happens until the fetch is done.

That split is what makes "no half-written state if killed" true without any
special kill-handling code: a kill during the fetch phase touches the
database not at all, and a kill during the write phase lands inside exactly
one `db.transaction()` call (already required for idempotency in Part A —
see `server/src/ingest/orders.js` and `ads.js`), which SQLite's WAL either
commits in full or rolls back in full on the next open. There is no code
path where a transaction is left half-applied, because `better-sqlite3`
doesn't expose one.

`server/src/ingest/loadSource.js` is the switch: `NORTHSTAR_SOURCE=http`
routes `run.js` through `httpSource.js` instead of the local fixture files
(`loadFixtures.js`, untouched — `test/helpers.js` still depends on its
synchronous, file-only behavior), same env-var-toggle pattern Part B already
used for `NORTHSTAR_FIXTURES=scale`.

### Each failure mode, and how it's handled

All in `server/src/ingest/httpSource.js`'s `fetchPage()`, one `for` loop per
page, `MAX_ATTEMPTS = 8`:

- **`500 {"error": "upstream"}`** (every 4th request) — treated as
  transient. Retry with exponential backoff (`200ms × 2^attempt`, capped at
  2s, plus jitter) — the server gave no indication of when it'll recover, so
  a capped guess is the best available signal.
- **`429` with `Retry-After: 1`** (every 7th request) — the server *did*
  tell us when it'll recover, so we honor that header exactly instead of our
  own backoff curve (`Number(res.headers.get("retry-after")) * 1000`, with a
  1s fallback if the header's ever missing or non-numeric).
- **Truncated body** (page 3 of any orders stream, first time only) — this
  didn't surface the way I first expected. `flaky_source.py` sends a
  `Content-Length` header declared as *double* the truncated byte count, then
  closes the connection after writing only half — so Node's `fetch`
  (undici) enforces the header strictly and throws
  `ResponseContentLengthMismatchError` while reading the body, before
  `JSON.parse` ever runs. My first version only wrapped `JSON.parse` in a
  try/catch and left `res.text()` unguarded; the flaky-source test
  (`server/test/flaky_ingest.test.js`) caught this immediately — the test
  failed with that exact error the first time I ran it against the real
  server, not a mock. Fixed by treating a body-read failure the same as a
  JSON parse failure: both mean "bad body, re-fetch the same page," on a
  short fixed 50ms delay rather than the 5xx backoff curve, since this isn't
  the server being overloaded.
- **Duplicate page** (page 2 of any orders stream returns the same
  `next_cursor` it was requested with, first time only) — `fetchAllPages()`
  tracks which cursors it has already appended to the result array in a
  `Set`. Naively following `next_cursor` does re-request that page a second
  time (and the server serves it again, this time with the correct
  `next_cursor`) — but since the cursor's data is already in the array, the
  second response's `data` is discarded and only its `next_cursor` is used to
  keep walking forward. This is dedup by *page identity* (has this cursor's
  data already been captured), not by record content — it works regardless
  of whether the repeated page's rows are themselves duplicates of anything
  else.
- **1-in-15 requests, 2s latency** — no special handling. `fetch` has no
  default timeout in Node, so the request just takes longer; the only
  requirement is not assuming a fast response. This is the one mode where
  "how you handle it" is "don't get in its way."

### What I deliberately don't retry

- **A 404 or other non-5xx/429 status.** That means a config error — wrong
  company slug, wrong source path — not a flaky upstream. Retrying can't fix
  a URL that will never resolve; `fetchPage` throws a distinct
  `FatalFetchError` immediately instead of burning through `MAX_ATTEMPTS`
  against a request destined to fail every time.
- **Past `MAX_ATTEMPTS` (8) on any transient failure.** An unbounded retry
  loop against a source that might be down for good is a hang, not
  resilience. Giving up loudly (`throw`) after 8 attempts fails the whole
  ingest run cleanly — no DB writes have happened yet for that
  company/source (fetch precedes write), so there's nothing to unwind, and
  the run can just be restarted once the source recovers.
- **A failed write.** Nothing in `ingestOrders`/`ingestAds` catches and
  retries a `db.transaction()` failure, on purpose — SQLite already retried
  the durable part (the WAL commit is atomic), and retrying application code
  *around* a half-run transaction is exactly the kind of state a correct
  design shouldn't need to reason about. If a transaction throws, `ingestAll`
  lets it propagate, logs the run as `"failed"` in `ingest_runs`, and leaves
  recovery to "run ingest again" — which Part A's idempotency guarantee
  already makes safe.
- **A repeated page's *content*, once identity dedup has decided it's a
  repeat.** I don't diff the two responses for the repeated page to confirm
  they're byte-identical before discarding the second one — the mock
  source's docstring guarantees the repeat is the same page, and the
  order-level `UNIQUE(company_id, source_order_id)` upsert would make a
  content mismatch harmless anyway (see Part A's dedupe rule). Verifying
  that guarantee isn't a failure-handling requirement, it's paranoia the
  schema already covers.

### Proof: same numbers as Part A

```
$ python3 tools/flaky_source.py --port 8787 &
$ curl -s http://127.0.0.1:8787/reset
{"ok": true}
$ npm run ingest:flaky
Ingest success — started 2026-08-26T13:11:11.578Z, finished 2026-08-26T13:11:18.642Z
Wall clock: 7092.1 ms   Peak RSS: 102.1 MB

Lumen Co (lumen)
  source: 16 order records, 15 ad records
  orders upserted:   14
  refunds upserted:  1
  ad rows upserted:  15
  ad rows skipped (exact duplicate): 0
  ad rows currency mismatch: 0
  issues logged: 1

Harbor Co (harbor)
  source: 16 order records, 15 ad records
  orders upserted:   15
  refunds upserted:  1
  ad rows upserted:  15
  ad rows skipped (exact duplicate): 0
  ad rows currency mismatch: 1
  issues logged: 1

$ curl -s http://127.0.0.1:8787/stats
{"requests": 27, "failed_500": 6, "failed_429": 3, "truncated": 2, "dup_pages": 2, "served": 72}
```

Every count (14/1/15 Lumen, 15/1/15 Harbor, one currency-mismatch issue on
Harbor) is exactly Part A's numbers (see the idempotency proof above) — and
the run really did hit all four injected HTTP failure modes on the way there
(6× 500, 3× 429, 2× truncated, 2× duplicate page), not zero of them by luck
of timing.

`server/test/flaky_ingest.test.js` asserts this automatically and is part of
`npm test`: it spawns the real `flaky_source.py`, runs ingest against it, and
asserts both the row counts and the full KPI totals equal a same-process
Part A ingest from the local files — plus asserts on `/stats` that
`failed_500`, `failed_429`, `truncated`, and `dup_pages` are all `> 0`, so
the test can't silently pass by never actually triggering a failure mode.

### Proof: no half-written state if killed mid-run

`server/scripts/prove-kill-safety.js` (`npm run prove:kill-safety`) launches
`node src/ingest/run.js` against the flaky source, `SIGKILL`s it partway
through, inspects the database, then re-runs to completion and diffs the
final totals against Part A. Two runs, two different kill points
(`NORTHSTAR_KILL_DELAY_MS` controls where the kill lands):

**Killed almost immediately (350ms in, before any company has finished
fetching):**

```
DB state immediately after SIGKILL:
{
  "integrityCheck": "ok",
  "orders": 0, "lineItems": 0, "refunds": 0, "adSpend": 0,
  "ingestRuns": []
}
```

**Killed later (3.5s in, after Lumen's orders+ads have committed but before
Harbor starts):**

```
DB state immediately after SIGKILL:
{
  "integrityCheck": "ok",
  "orders": 13, "lineItems": 24, "refunds": 1, "adSpend": 15,
  "ingestRuns": []
}
```

Both times, `PRAGMA integrity_check` returns `"ok"` — SQLite's own proof the
WAL never left a torn write behind — and both times the row counts land
exactly on a *company/source transaction boundary* (0 companies done, or one
company's orders-transaction and ads-transaction both fully committed): never
a number that implies a transaction was interrupted mid-write, because none
was observed to be. In both cases, re-running ingest to completion against
that same (possibly partial) database converges to the identical, correct
final state:

```
lumen: got {"orders":13,"grossSales":1750,"netRevenue":1558,"refunds":192,"adSpend":771.15,"roas":2.0203592037865525}
lumen: exp {"orders":13,"grossSales":1750,"netRevenue":1558,"refunds":192,"adSpend":771.15,"roas":2.0203592037865525}
lumen: MATCH

harbor: got {"orders":14,"grossSales":2580,"netRevenue":2500,"refunds":80,"adSpend":1076.1,"roas":2.3232041631818605}
harbor: exp {"orders":14,"grossSales":2580,"netRevenue":2500,"refunds":80,"adSpend":1076.1,"roas":2.3232041631818605}
harbor: MATCH

PASS -- post-kill re-ingest reproduces Part A totals exactly.
```

This isn't a different code path from a normal re-ingest — it's the same
idempotent upsert behavior Part A already proved, just started from a
partially-populated DB instead of an empty one. "No half-written state" and
"idempotent re-ingest" turn out to be the same guarantee looked at from two
angles: the first says a kill can't corrupt the DB, the second says
resuming after one doesn't need special-case code.

---

## Day 2 — CR1: Fina Co (third company)

`changes/CR1.md` asked for a third company (Fina Co, PHP, Asia/Manila) plus a
"yesterday vs same day last week" comparison on every dashboard. Adding the
company itself really was config + fixtures, no rewrite — see
["What day 1 got wrong"](#what-day-1-got-wrong) for the one place that
assumption didn't hold. Fina's fixtures are messier than Lumen/Harbor's on
purpose (per the brief, "messy in ways the first two companies were not"), and
finding out *how* was most of CR1's actual work.

### New defects Fina's data surfaced

**10. An order in the wrong currency was summed into revenue at face value.**
Fina's `F-308` is a `"total_price": "50.00"`, `"currency": "USD"` order sitting
in an otherwise all-PHP file. `ads.js` already excluded a foreign-currency ad
row from spend (Starter review defect #5) — nothing on the orders side did the
same thing. Before this fix, `kpi.js`'s gross-sales query summed
`line_items.price_cents` with no currency check at all, so this order would
have landed as **₱50.00** of PHP revenue instead of the $50.00 USD it actually
is: an 8500%+ misstatement of that one row (₱50 ≈ $0.90 at typical PHP/USD
rates), silently baked into the total with no error, no crash, no visible
sign anything was wrong. Fixed the same way as the ad-side case: excluded from
`gross`/`orders`/`net` ([kpi.js:130](server/src/kpi.js#L130),
[:140](server/src/kpi.js#L140), refund join at [:156](server/src/kpi.js#L156)),
flagged as an `ingest_issues` row
([orders.js:130](server/src/ingest/orders.js#L130)), and surfaced in its own
currency via `excludedForeignRevenue`
([kpi.js:247](server/src/kpi.js#L247), rendered in
[IssuesStrip.jsx](web/src/components/IssuesStrip.jsx)) — not converted, not
dropped. Proven in
[fina_third_company.test.js](server/test/fina_third_company.test.js) ("F-308…
excluded from revenue and surfaced, not converted").

**11. A voided order was never excluded from sales at all.** `F-305` has
`"financial_status": "voided"` — a Shopify order whose payment authorization
was voided, meaning nothing was ever captured. The schema has stored
`financial_status` since Part A ([db.js schema, `orders.financial_status`
column]) but nothing ever read it: every KPI query summed every order
regardless of status. Lumen/Harbor only ever had `paid`/`refunded` orders, so
this gap was invisible until Fina's data hit it. Fixed by excluding
`financial_status = 'voided'` from gross/order-count/refund-eligibility
everywhere ([kpi.js:44](server/src/kpi.js#L44),
[:51](server/src/kpi.js#L51), [:130](server/src/kpi.js#L130),
[:140](server/src/kpi.js#L140)) and flagging it for visibility
([orders.js:119](server/src/ingest/orders.js#L119)) — a voided order is real,
valid source data, just not a sale, so it stays visible rather than vanishing.

**12. A timestamp with no UTC offset has no fixed instant.** `F-303`'s
`created_at` is `"2026-08-03T23:30:00"` — no `Z`, no `+HH:MM`. Every other
order in every fixture (including Lumen's and Harbor's) carries an explicit
offset or `Z`. Per ECMA-262, `new Date()` on an offset-less date-time string
resolves it against the *host machine's local timezone* — which for a server
process is whatever `TZ` happens to be set to, non-deterministic across dev
machines, CI, and production, and silently different depending on where
ingest runs. We refuse to guess: `hasExplicitOffset()`
([timezone.js:28](server/src/timezone.js#L28)) checks for a trailing `Z` or
numeric offset, and both `orders.js` (order and refund `created_at`,
[:65](server/src/ingest/orders.js#L65) and
[:155](server/src/ingest/orders.js#L155)) and `ads.js` (`date_start`,
[:52](server/src/ingest/ads.js#L52)) treat a failure the same as a missing
timestamp: not ingested, flagged `ambiguous_timestamp`, visible in
`ingest_issues`.

**13. The same order id can appear twice in one batch with genuinely different
content.** `F-306` appears twice in `fina.shopify.orders.json`: the first
payload has 2 line items totalling ₱3,900, the second has 1 line item
totalling ₱1,500. This isn't a byte-identical resend (Starter review defect
#2's dedup, which already collapses those correctly) — it's the same id with
different content inside one file, and there's no `updated_at` to say which
is authoritative. The existing upsert
(`ON CONFLICT(company_id, source_order_id) DO UPDATE`,
[orders.js:15](server/src/ingest/orders.js#L15)) already resolves this via
last-write-wins in file order — that behavior didn't change. What we added is
visibility: a per-batch content hash comparison
([orders.js:79](server/src/ingest/orders.js#L79)) flags
`conflicting_duplicate_in_batch` when a second occurrence's content differs
from the first, so this doesn't resolve invisibly the way it did before.

**14. Deduping ad spend by `(campaign_id, date)` instead of full-row content
would have been wrong before Fina, and Fina makes the cost concrete.** Not a
new defect in our code — this is CR2 request #1, addressed below — but Fina's
`F-C1` has a real same-day resend (`2026-08-11`, byte-identical, correctly
collapsed) sitting right next to a real credit row (`2026-08-09`, `-250.00`,
correctly kept) for the *same campaign*. A `(campaign_id, date)` key can't
tell those apart; ours already can (defect #4, unchanged since Part A).

### Comparison feature: "yesterday vs same day last week"

Added `comparison` to `getDashboardData`'s response
([kpi.js:95](server/src/kpi.js#L95)), rendered as
[ComparisonStrip.jsx](web/src/components/ComparisonStrip.jsx) on every
dashboard. Three decisions worth writing down:

- **"Yesterday" = the last day of the *selected range*, not the real calendar
  day relative to the server clock.** The brief's example range doesn't end on
  today, and an operator paging through history should get a comparison for
  the range they're actually looking at, not one anchored to whenever the
  server happens to be running. "Same day last week" is a flat 7-day
  subtraction on the already-store-local date string
  ([kpi.js:39](server/src/kpi.js#L39) `daysBefore`) — no second timezone
  conversion, since `store_local_date` is already a calendar date, not an
  instant.
- **Whole-day "no data" vs. per-metric zero baseline are different things, and
  the brief only asked us to guard the first.** `hasData` on each side
  ([kpi.js:70](server/src/kpi.js#L70)) means "any order or ad-spend row exists
  for the company on this date at all" — a day before the company had any
  activity. If either whole day has no data, the strip says so instead of
  comparing (`comparison.test.js`, "a day with no data at all… is reported as
  'no data'"). But a day that *has* data with a metric that happens to be zero
  (Fina's Aug 7: real ad spend, zero orders) is a real, informative zero, not
  "no data" — for that we render "—" on just that metric
  (`percentChange` returns `null` when the baseline is 0,
  [kpi.js:90](server/src/kpi.js#L90)) rather than either an `Infinity%`/`NaN`
  spike or blacking out the whole comparison over one metric. Both cases are
  proven in [comparison.test.js](server/test/comparison.test.js).
- Net revenue, orders, and ad spend are computed with the exact same
  currency/voided filters as the range KPIs
  ([kpi.js:39](server/src/kpi.js#L39) `getSingleDayMetrics`) — otherwise the
  comparison strip and the daily table below it could disagree about what
  counts as a sale.

### What day 1 got wrong

Only one real assumption broke, and only in one place: **`ingestAll`
([run.js:33](server/src/ingest/run.js#L33)) always iterated every configured
company against whatever data source was active**, on the implicit assumption
that every company has data for every source. That held by accident for two
companies and two sources (real fixtures + the flaky HTTP mirror), and broke
the instant a third company arrived without a matching entry in Part B's scale
generator (`tools/gen_scale_fixtures.py` predates Fina and only ever wrote
`lumen`/`harbor` — regenerating 300k+ rows for a third company was out of
CR1's ~90-minute scope). Running `npm run ingest:scale` crashed the whole
batch on Fina's missing file instead of just not having scale data for Fina.
Fixed by catching a missing-fixture `ENOENT` per company and skipping just
that company with a visible warning ([run.js:35](server/src/ingest/run.js#L35))
— the two companies that do have scale data still ingest normally, and the gap
is reported instead of silently absent or fatally crashing.

Everything else — schema, dedup keys, timezone conversion, the KPI queries,
the dashboard UI, the currency-mismatch pattern already built for ads — took
Fina without a rewrite, which is what CR1's "this should not require a
rewrite" was really testing: whether Part A's `(company_id, natural key)`
uniqueness and per-currency filtering generalized past 2 examples, or were
quietly hard-coded to them. They generalized. What *wasn't* generalized yet
was the orders side of the currency check (defect #10 above) and the voided-
order filter (#11) — those gaps existed in Part A's code the whole time, just
invisible because Lumen and Harbor never had a mismatched-currency or voided
order in their fixtures to exercise them. A third company didn't strain the
design; it strained the two-company *fixtures'* coverage of the design.

---
## Day 2 — CR2: operator requests

See [CR2-RESPONSE.md](CR2-RESPONSE.md) for the four operator requests and a
DONE/DECLINED/CHANGED verdict on each. Two are declined against the evidence
already in this repo (the existing ad-dedup tests, and the brief's own 404
requirement); the other two are done with a twist worth a one-line summary
here too: the "delete the bad fixture row" request became "keep the row,
include its effect on the total, flag it" (NOTES defect analogy to #10/#11
above — visible and correct beats invisible and "clean"), and the "401 instead
of 404" request became "keep the 404, fix the copy" for the same
information-leak reason the brief specifies 404 in the first place.

---

## Written answers

**1. Which single query or function in your repo is most likely to be wrong in
production, and what would tell you?**
[`getSingleDayMetrics`/`getComparison` in kpi.js](server/src/kpi.js#L39) — the
"same day last week" comparison added for CR1. Every other KPI query has
1-2 years of scale-fixture data and a Part B benchmark behind it; this one has
exactly the 14 days of hand-authored fixtures it was built and tested against.
It assumes `daysBefore(end, 7)` always lands on a real prior week that's
worth comparing to — for a company whose data starts mid-range (a new
customer's first two weeks live), or across a DST transition in a timezone
that observes it (Manila and Sydney don't; Los Angeles does — a Lumen range
straddling a DST boundary is untested), the "same weekday" framing could
compare across a discontinuity we haven't checked. What would tell me: a
production dashboard for a real, older company (not a 14-day fixture) where
the percentage swings look implausible on a day I can independently verify
against Shopify's own numbers — or simply a wider fixture (60+ days, crossing
a DST boundary) I haven't built here.

**2. If the order file were 100× larger tomorrow, which line of your code fails
first? Why that one?**
[`loadFixtures.js`'s `JSON.parse(readFileSync(...))`](server/src/ingest/loadFixtures.js#L32)
for the *small*-fixture path (not the JSONL scale path, which already
streams line-by-line for exactly this reason — see "Bottleneck" above). It
reads the whole file into memory as one string and parses it as one JSON
value; at 100× Lumen/Harbor/Fina's current combined ~40 small orders that's
still trivial, but the small-fixture loader was never meant to scale — it's
JSONL (`gen_scale_fixtures.py`) that exists specifically because a single
`JSON.parse` on a multi-hundred-MB array literal blows past a comfortable
heap size and pauses the event loop for the whole parse. If someone pointed
`loadOrders()` at a 100×-larger *non-scale* `.json` file instead of migrating
it to JSONL first, that line is where it falls over — not gracefully, an OOM
or multi-second synchronous stall, with the fix already sitting one file over
in `readJsonl`.

**3. Look at your transcripts. Where did the AI cost you the most time, and
what would you do differently next time you drive it on a task like this?**
See `AI-MOMENTS.md` for the specific instances with transcript line numbers.
The pattern across them: the AI's first pass at a KPI query was almost always
*plausible* — it ran, it returned numbers that looked like real numbers — and
the actual time cost was mine, re-deriving the correct number by hand from the
fixture before trusting or rejecting what it wrote. That's slower than it
sounds the first time and fast every time after, because the fixtures are
small enough to hand-verify. Next time: write the hand-verified expected
number down *before* asking the AI to implement the query, not after, so
"does this match" is a one-line diff instead of a fresh derivation under time
pressure.

## What we'd do differently in production

- Give every ad/order/refund row a real ingestion **batch id** and keep raw
  source payloads (not just the parsed fields we chose to store) — CR2's
  "just delete the bad row" ask would have been a non-issue with an
  immutable raw-payload table underneath the parsed one; we could show the
  credit *and* the exact wire payload Meta sent, instead of reconstructing
  intent from the parsed fields alone.
- Replace the flat `ingest_issues` table with a typed severity (`info` /
  `excluded` / `error`) — right now "a voided order" and "an unparseable
  timestamp" render with equal visual weight on the dashboard, and an
  operator scanning quickly can't tell "fine, just FYI" from "you're missing
  real revenue" at a glance.
- The comparison feature (CR1) needs a wider fixture than 14 hand-authored
  days to trust in production — specifically a DST-crossing range for a
  timezone that observes it, and a company whose data has a real start date
  before the "no data" branch gets exercised by anything other than a
  synthetic out-of-range test.
- `ingestAll`'s per-company `ENOENT` skip (see "What day 1 got wrong") is the
  right behavior for a demo/take-home; in production I'd rather a company
  onboarding to a new source show up as a first-class "not yet backfilled"
  state on its own dashboard than a warning that only appears in server logs.
- Currency mismatch and voided-order exclusion are currently duplicated
  across three query sites in `kpi.js` (range totals, single-day metrics, and
  soon-you'll-need-it-again if a new KPI is added) as a repeated `WHERE`
  clause fragment rather than a shared view/CTE. Fine at this scale; the
  third or fourth caller is where I'd factor it out.

---

## Stretch — `POST` re-ingest without a restart

Picked this over incremental `sync_state` or a source-health strip because it
directly serves the brief's own required deliverable: the walkthrough video
needs "one re-ingest run," and a button that re-ingests the live server
without a restart is a better demo of "this actually works end to end" than
a terminal screen recording of `npm run ingest`.

[`server/src/server.js`](server/src/server.js#L21) adds
`POST /api/ingest`, which calls the exact same `ingestAll(db)` the CLI
(`ingest/run.js`) uses -- same idempotent upserts, same transaction
boundaries per company/source, same kill-safety guarantees from Part C --
just against the server process's own already-open, long-lived DB
connection instead of a fresh one. No caching layer needed invalidating:
`getDashboardData` already recomputes straight from SQLite on every request
([kpi.js:118](server/src/kpi.js#L118)), so a re-ingest's effects are visible
on the very next dashboard fetch. Every dashboard also has a **"Re-ingest
now"** button ([DashboardPage.jsx](web/src/pages/DashboardPage.jsx)) that
calls the endpoint and refetches itself.

Two things worth calling out:

- **Concurrency.** This is a single-process app with one shared DB
  connection -- two `ingestAll()` calls running at once would interleave
  transactions against the same connection, which `better-sqlite3`'s
  synchronous API doesn't protect against on its own. A plain in-memory
  `ingesting` boolean set for the duration of the call
  ([server.js:22](server/src/server.js#L22)) is enough for a single-process
  app; a second `POST` while one is in flight gets `409` instead of racing
  it. This would need a real lock (e.g. `BEGIN IMMEDIATE` or an external
  mutex) the moment this ran as more than one process.
- **What I didn't test.** The 409 path is exercised in
  [reingest_endpoint.test.js](server/test/reingest_endpoint.test.js), but
  against the tiny hand-authored fixtures ingest finishes in ~20-40ms, so two
  concurrent `POST`s racing to actually collide on the lock (vs. both
  finishing before either checks the other) is inherently timing-dependent
  -- the test asserts the response pair is always `(200,200)` or `(200,409)`
  and never anything else, rather than forcing the race to land a specific
  way. Proving the lock actually *fires* deterministically would need an
  injectable delay inside `ingestAll` (e.g. a hook only enabled under test),
  which felt like more surface area than a stretch item warranted.
