# CR2 Response

`changes/CR2.md` — four requests from an operator call. Verdicts below; full
reasoning and the code changes are in [NOTES.md](NOTES.md#day-2--cr2-operator-requests).
I'm the engineer on this, so where I think an operator's literal ask would make
the product worse or contradict something the brief itself already specifies,
I say so with evidence rather than just doing what was asked.

---

## 1. Duplicate ad rows — "dedupe on campaign ID plus date"

**DECLINED.**

We already dedupe ad spend, but on a hash of the full row content
([ads.js:9](server/src/ingest/ads.js#L9)), not `(campaign_id, date)`. That's
not an oversight — it's a deliberate fix from Part A (NOTES.md Starter review
defect #4): the starter's original `(campaign_id, date)` key treated "same
campaign, same day" as one event and kept whichever copy arrived last,
which is correct for a byte-identical resend but silently **drops a second,
genuinely different spend event** for that campaign on that day.

Evidence this isn't hypothetical:
- [server/test/ad_dedup.test.js:42](server/test/ad_dedup.test.js#L42) — "two
  genuinely different spend events for the same campaign/day both count":
  two rows, same `campaign_id` (`X-2`), same `date` (`2026-08-01`), spends
  `$10.00` and `$12.50`. A `(campaign_id, date)` key collapses these to one
  row and drops $10 or $12.50 depending on which arrives last; ours keeps
  both because the row content (including `date_start`, `spend`, timestamps)
  differs.
- Fina Co's real fixture data (CR1) has both cases sitting next to each other
  in the same campaign: `F-C1` on `2026-08-11` is a genuine byte-identical
  resend (both rows identical — content-hash dedup correctly keeps one), and
  `F-C1` on `2026-08-09` has a real spend row *and* a real `-250.00` credit
  row on the same date (content-hash dedup correctly keeps both, since their
  content differs). A `(campaign_id, date)` key can't tell these two
  situations apart — it would either drop the real second Aug-9 row or double
  Aug-11's total, depending on tie-break order.

Doing what was literally asked would reintroduce a bug we already found and
fixed, and lose real spend data the moment Meta ever sends two distinct spend
events for one campaign on one day. What we have already achieves the
operator's actual goal (a resend can't double-count spend) without that cost.

---

## 2. Wrong links — "return 401 instead of a blank 404"

**CHANGED.**

Kept the HTTP status at 404. `CANDIDATE-BRIEF.md` (line 37) is explicit:
*"Wrong or unknown token → 404 (not 401, not a redirect)."* This isn't
arbitrary — a private, unguessable link is the *only* access control this
product has (no login, no accounts). A 401 tells anyone probing URLs "this
resource exists and requires authorization," which leaks exactly the
information an unguessable link is supposed to withhold, and it invites the
question "authorization via what?" in a product that has no auth flow to
answer it. Switching to 401 would be a real regression against the brief's
own stated security model, not just a style preference.

What actually changed, because the operator's underlying complaint (a blank
page reads as "the site is down") is legitimate:
- [server/src/server.js](server/src/server.js#L41) — the plain-text 404 body
  is now `"This link is invalid or has expired. Ask us for a new one."`
  instead of `"Not found."`
- [web/src/pages/NotFoundPage.jsx](web/src/pages/NotFoundPage.jsx) — same
  message on the client-rendered 404 page, so it doesn't read as breakage on
  either code path that can produce it.

Status code unchanged; the actual UX problem (confusing, alarming copy) is
fixed.

---

## 3. Timestamps — "show 'last ingest' in our local time"

**DONE.**

- [web/src/format.js](web/src/format.js#L20) — new `localDateTime()` formats
  an ISO timestamp in a given IANA timezone via `Intl.DateTimeFormat`.
- [web/src/pages/DashboardPage.jsx](web/src/pages/DashboardPage.jsx) — the
  footer now renders `lastIngestAt` in the company's own timezone (e.g. *"Aug
  27, 2026, 8:50 AM GMT+8"* for Fina/Manila, *"Aug 26, 2026, 5:50 PM PDT"* for
  Lumen/LA), with the raw UTC ISO timestamp kept as a hover `title` for anyone
  who wants it. An operator can now tell at a glance whether this morning's
  local sync ran, which was the actual ask.

---

## 4. The negative spend row — "delete it from the fixture before ingesting"

**CHANGED.**

Did not hand-edit the fixture file, and did not drop the row. The row stays
in `fixtures/fina.meta.ads.json` and stays in the ingested total.

Why deleting it is the wrong fix, not just a style choice:
- **It's not corrupt data — the operator's own explanation confirms it's a
  real, billed event.** "Meta issued a credit" means the company's Meta bill
  for that day genuinely went down by ₱250. Deleting the row makes the
  dashboard show ₱250 *more* spend than the company was actually charged —
  the exact "silently 'fixed' in a way that hides what really happened"
  failure mode `CANDIDATE-BRIEF.md`'s KPI contract explicitly rules out
  ("Rows the data can't support… must be visible somewhere — never silently
  dropped, never silently 'fixed'").
- **Hand-editing a source fixture is not durable.** The fixture is meant to
  stand in for a real upstream API response. The moment this file is
  regenerated, re-synced, or replaced by a real Meta API integration, a
  manual edit made once in this repo is gone and the "credit shows up as a
  weird row" question resurfaces for whoever's on call then — with no record
  that anyone ever investigated it the first time.
- **There's no audit trail once it's deleted.** Today we know exactly which
  campaign, which day, and how large the credit was. Silently deleting the
  row (or silently zeroing it, which is the same failure by another name)
  throws that information away.

What we did instead
([ads.js:86](server/src/ingest/ads.js#L86)): detect `spend < 0`, keep the row
and let it reduce the day's total spend (that's economically correct — a
credit lowers what was actually spent), and flag it as an `ingest_issues` row
with reason `negative_spend_credit` so it's visible on the dashboard
(`IssuesStrip.jsx`) instead of showing up as an unexplained dip nobody can
explain later. Proven in
[server/test/fina_third_company.test.js](server/test/fina_third_company.test.js)
("Fina's negative ad-spend row is a platform credit…").
