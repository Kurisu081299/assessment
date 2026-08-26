# Change Request 1 — Day 2

**From:** Northstar product
**Effort budget:** ~90 minutes

Do not start this until you have finished Part A. Commit before you begin so the diff is clean.

## A third company

We signed **Fina Co**. Same product, same rules, one more private link.

| Company | Timezone     | Currency | Dashboard    |
|---------|--------------|----------|--------------|
| Fina Co | Asia/Manila  | PHP      | `/d/{token}` |

Fixtures are in this bundle: `fixtures/fina.shopify.orders.json`, `fixtures/fina.meta.ads.json`. Same shapes as the others. Same warning: the data is messy, and it is messy in ways the first two companies were not. Every problem goes in `NOTES.md` with what you did and why, same as before.

This should not require a rewrite. If it does, say so in `NOTES.md` under **"What day 1 got wrong"** — what in your original design forced the change, and what you would have done differently knowing a third company was coming. That paragraph is worth more to us than a clean diff, so write it honestly.

## One more thing on every dashboard

Operators want context, not just numbers. Add to each dashboard a **"yesterday vs same day last week"** comparison: for the last day of the selected range and the same weekday one week earlier, show net revenue, orders, and ad spend side by side with the percentage change. Define "yesterday" in the company's timezone. If either day has no data, say so on the dashboard rather than showing a misleading percentage.

Commit when done. Then open `CR2.md`.
