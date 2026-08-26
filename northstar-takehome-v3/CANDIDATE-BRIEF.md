# Northstar — Take-home

**Time:** 6–8 hours of work, spread over **at least two days**. Day 2 unlocks a sealed change bundle (`changes.zip`); we send you its password the morning of your second day. Stop at 8 hours; ship what you have and say what's missing.

**You may — and should — use AI tools.** We assume Claude Code or similar wrote much of the code. We are evaluating **how you drive it**: what you verify, what you reject, when you redirect it, and what you do when the instructions are wrong. The transcript is a required deliverable (see below).

---

## What you submit

1. **A GitHub repo** (public, or private with us invited). See *Commit rules*.
2. **`transcripts/`** — every AI session, exported in full. In Claude Code run `/export` at the end of each session and save the file as `transcripts/session-01.txt`, `session-02.txt`, … Other tools: include their full session log. A tool with no exportable log is not acceptable for this exam — use Claude Code. **A submission without transcripts is not reviewed.**
3. **`README.md`, `NOTES.md`, `AI-MOMENTS.md`, `CR2-RESPONSE.md`** in the repo root (sections below).
4. A 3–8 minute Loom or screenshot walkthrough of all dashboards, including one re-ingest run.

**Commit rules** — we check these mechanically:
- At least **10 commits**, spread across **at least two sessions 8+ hours apart**.
- No single commit may contain more than **40% of the final line count**.
- Commit before opening `changes.zip`, and once after each change request, so the day-2 diffs are readable on their own.
- If you genuinely cannot spread the work over two days, record your screen for the last hour of work and include the link in `README.md`. Tell us before you start.

**Stack:** your choice. One-command local run. SQLite or Postgres. No container orchestration, no cloud deploy.

---

## Product

Slim commerce intelligence. Two brands (for now), two data sources, one private link each.

Not a SaaS: no signup, no login, no org switcher, no billing. An operator at each company opens a secret URL and sees their numbers.

| Company   | Timezone            | Currency | Dashboard    |
|-----------|---------------------|----------|--------------|
| Lumen Co  | America/Los_Angeles | USD      | `/d/{token}` |
| Harbor Co | Australia/Sydney    | AUD      | `/d/{token}` |

No users table, no orgs table. Tokens are long unguessable secrets — not the company name, slug, or anything derivable. Wrong or unknown token → **404** (not 401, not a redirect).

---

## Data

**Files** — `fixtures/`: `lumen.shopify.orders.json`, `lumen.meta.ads.json`, `harbor.shopify.orders.json`, `harbor.meta.ads.json`.

**Mock source API** — `tools/flaky_source.py` (stdlib Python) serves the same data as a paginated HTTP API that behaves like a real third-party API on a bad day. `python3 tools/flaky_source.py --help`.

**Scale generator** — `tools/gen_scale_fixtures.py` writes ~300k orders and two years of ad rows per company to `fixtures/scale/` as JSONL, plus `EXPECTED.json` with last-90-day totals so you can check yourself.

The data is **messy on purpose**. We are not telling you what's wrong with it. `NOTES.md` must list every problem you found, what you did, and **why that is the right call**.

No live calls to any third-party API.

---

## KPI contract

All KPIs in the **company currency**. Dates are **store-local** (company timezone) — not UTC, not your laptop's clock. Default range **2026-08-01 … 2026-08-14 inclusive**, company timezone.

| KPI | Definition |
|-----|------------|
| **Gross sales** | Sum of line totals before refunds, bucketed by the order's store-local date. |
| **Net revenue** | Gross minus refunds. A refund lands on the **refund's** store-local date, unless you document and justify a different rule. |
| **Orders** | Distinct real orders. |
| **Ad spend** | Spend on the store-local date. |
| **ROAS** | Net revenue ÷ ad spend. Render an em dash (—) when spend is 0. |

A day with spend and no sales is still a day. Rows the data can't support (wrong currency, no date, and so on) must be **visible somewhere** — never silently dropped, never silently "fixed".

---

## Part 0 — review the first pass (required, do this first, ~45 min)

`starter/northstar_starter.py` is a first pass at the pipeline that an AI assistant produced for us. It runs and prints confident-looking numbers. **We do not trust it.**

Before you write any code of your own, review it and write **`NOTES.md` → "Starter review"**: every defect you found, the record or amount that proves it, and the effect on the KPIs. Then decide — build on it, salvage parts, or discard it — and say which and why.

You are free to use AI to help you review it. Notice what it finds and what it misses; the transcript will show us both.

## Part A — core (required)

1. **Ingest** both sources for both companies from the files into a real schema (orders, line items, refunds, ad rows — your tables). Re-running ingest is **idempotent**: prove it with a test or a command whose output you paste into `NOTES.md`.
2. **Private dashboards**, one per company, each showing: company name, date range, the five KPIs, a daily table and/or chart, and the last-successful-ingest timestamp.
3. **Tests** that pin down your handling of at least: duplicates, timezone conversion, refunds, and a day with spend but no orders. Test the *numbers*, not that a function was called.

## Part B — latency (required)

Generate the scale fixtures and ingest them. Report wall-clock ingest time and peak memory. The dashboard for a 90-day range must render in **under 500 ms server-side** with the scale data loaded. `NOTES.md` → **"Bottleneck"**: what was slow *first*, how you measured it (paste the timing or query plan), what you changed, before/after numbers. If you were already under budget, say what breaks next and at what size.

## Part C — failure handling (required)

Point your ingest at `tools/flaky_source.py`. It returns 5xx, 429 with `Retry-After`, truncated bodies, and repeated pages. Your ingest must finish with the **same numbers as Part A** and leave no half-written state if killed mid-run. `NOTES.md` → **"Failures"**: each mode you hit, how you handle it, and what you deliberately *don't* retry.

## Day 2 — `changes.zip` (required)

Two change requests from "product". Open them only after Part A is committed. One of them is a normal pivot; treat the other with the judgement you would use with a real stakeholder. Each has its own deliverable, described inside.

## Stretch — only after everything above

Pick one: incremental `sync_state` (cursor per source) · a source health strip (last success, row counts, rows rejected and why) · `POST` re-ingest without a restart.

---

## Required documents

**`README.md`** — how to run (one command, under 15 minutes from clone), every dashboard URL with its token, KPI definitions in your words.

**`NOTES.md`** — "Starter review" · problems found + handling + why · dedupe rule · timezone and refund rules · "Bottleneck" · "Failures" · "What day 1 got wrong" (from CR1) · the three written answers below · 2–5 bullets on what you'd do next in production.

**`AI-MOMENTS.md`** — not a diary. **Five to eight moments in your transcripts, each with the session file and an approximate line or timestamp**, where you: rejected something the AI proposed, caught something it got wrong, redirected it when it went the wrong way, or made it justify a choice. One or two sentences each. We will open the transcript at each one. If you can't find five, say so and tell us why.

**`CR2-RESPONSE.md`** — as specified in the change bundle.

---

## Written (20 minutes, in NOTES.md, about *your* submission)

1. Which single query or function in your repo is most likely to be wrong in production, and what would tell you? Name the file.
2. If the order file were 100× larger tomorrow, which line of your code fails first? Why that one?
3. Look at your transcripts. Where did the AI cost you the most time, and what would you do differently next time you drive it on a task like this?

---

If the cap hits, stop. A working Part A plus honest notes and complete transcripts beats a half-built everything.
