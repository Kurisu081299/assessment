# Screenshot walkthrough

Static walkthrough of all three dashboards plus one live `POST /api/ingest`
re-ingest run, taken against `npm start` on `http://localhost:4000`.

| # | File | What it shows |
|---|------|----------------|
| 1 | [01-lumen-dashboard.png](01-lumen-dashboard.png) | Lumen Co — company name, timezone/currency, date range, all five KPIs, the week-over-week comparison strip, the daily chart, the full daily table, the data-quality flag for the missing-date order, and the last-ingest footer. |
| 2 | [02-harbor-dashboard.png](02-harbor-dashboard.png) | Harbor Co — same layout in AUD / Australia/Sydney, including the wrong-currency ad-spend flag. |
| 3 | [03-fina-dashboard.png](03-fina-dashboard.png) | Fina Co — same layout in PHP / Asia/Manila, with all five day-2 data-quality flags (wrong-currency revenue, no-timezone timestamp, voided order, duplicate order id, negative-spend credit). |
| 4 | [04-unknown-token-404.png](04-unknown-token-404.png) | `/d/anything-else` — an unknown/mistyped token returns a real HTTP 404 (confirmed via `curl -o /dev/null -w '%{http_code}'` → `404`), not a redirect and not the app shell. |
| 5 | [05-reingest-before.png](05-reingest-before.png) | Lumen Co immediately before re-ingest: footer reads "Last successful ingest: Aug 26, 2026, 7:34 PM PDT". |
| 6 | [06-reingest-after.png](06-reingest-after.png) | Same dashboard right after clicking **Re-ingest now**: footer now reads "Last successful ingest: Aug 26, 2026, 7:35 PM PDT · Re-ingest success in 44ms." — no page reload, no server restart, numbers refetched in place (per the Stretch feature, `POST /api/ingest` on the live server). |

All screenshots were captured headlessly (Playwright driving the system Chrome
install against the real running server, `prefers-color-scheme: dark`) so the
sequence is reproducible: `npm start`, then load each dashboard URL from the
[root README](../README.md#dashboards) and click **Re-ingest now** in the footer.
