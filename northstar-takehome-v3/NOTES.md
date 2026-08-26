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

*Remaining NOTES.md sections (Bottleneck, Failures, "what day 1 got wrong," the three
written answers, and next-steps bullets) are written as Part B/C/CR1 are completed —
this file covers Part 0 and Part A only, per the brief's instructions.*
