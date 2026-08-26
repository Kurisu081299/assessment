# Change Request 2 — Day 2

**From:** Northstar product, after a call with the operators
**Effort budget:** ~45 minutes

Four requests came out of the operator call. Handle each one. For each, add an entry to **`CR2-RESPONSE.md`** in your repo root with one of:

- **DONE** — a sentence on what changed and where.
- **DECLINED** — why, with **evidence from the data or the code** (record IDs, amounts, a query, a line number). "I disagree" is not evidence.
- **CHANGED** — you did something different from what was asked; say what and why.

You are the engineer on this. The operators are not. Do what is right, and say so.

---

### 1. Duplicate ad rows

> "Meta re-sends rows all the time. Please dedupe the ad rows on campaign ID plus date so a re-send can't double-count our spend."

### 2. Wrong links

> "When someone opens an old or mistyped link they just get a blank 404 and think the site is down. Return a 401 with a message saying the link is invalid and to ask us for a new one."

### 3. Timestamps

> "The 'last ingest' time at the bottom is in UTC. Show it in our local time so we can tell at a glance whether this morning's sync ran."

### 4. The negative spend row

> "There's a Fina ad row with negative spend on Aug 9 — that's a Meta bug, they issued a credit. Just delete that row from the fixture file before you ingest so it stops showing up."

---

Commit when done. Then finish Parts B and C if you haven't, write the docs, export your transcripts, and submit.
