import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { ingestAds } from "../src/ingest/ads.js";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

function testCompany(db) {
  return db.prepare(`SELECT * FROM companies WHERE slug = 'lumen'`).get();
}

// The starter's ad dedup keyed on (campaign_id, date) and kept "last wins" --
// which is correct for a byte-identical resend, but silently drops a second
// genuine spend event for the same campaign on the same day (NOTES.md defect #4).
// We key on a hash of the full row instead: identical content collapses,
// different content sums.
test("a byte-identical resend does not double-count spend", () => {
  const db = openDb(":memory:");
  migrate(db);
  const company = testCompany(db);
  const row = {
    campaign_id: "X-1",
    campaign_name: "Test",
    date: "2026-08-01",
    date_start: "2026-08-01T16:00:00Z",
    spend: "10.00",
    currency: "USD",
    impressions: 100,
    clicks: 5,
  };

  ingestAds(db, company, [row]);
  ingestAds(db, company, [{ ...row }]); // exact resend

  const total = db
    .prepare(`SELECT SUM(spend_cents) AS cents FROM ad_spend WHERE company_id = ? AND campaign_id = 'X-1'`)
    .get(company.id).cents;
  assert.equal(total, 1000); // $10.00, not $20.00
});

test("two genuinely different spend events for the same campaign/day both count", () => {
  const db = openDb(":memory:");
  migrate(db);
  const company = testCompany(db);
  ingestAds(db, company, [
    {
      campaign_id: "X-2",
      campaign_name: "Test",
      date: "2026-08-01",
      date_start: "2026-08-01T15:00:00Z",
      spend: "10.00",
      currency: "USD",
      impressions: 100,
      clicks: 5,
    },
    {
      campaign_id: "X-2",
      campaign_name: "Test",
      date: "2026-08-01",
      date_start: "2026-08-01T20:00:00Z",
      spend: "12.50",
      currency: "USD",
      impressions: 150,
      clicks: 9,
    },
  ]);

  const total = db
    .prepare(`SELECT SUM(spend_cents) AS cents FROM ad_spend WHERE company_id = ? AND campaign_id = 'X-2'`)
    .get(company.id).cents;
  assert.equal(total, 2250); // $22.50, both rows kept
});

// Real-data finding made while building this pipeline (documented in NOTES.md):
// Lumen's L-C1 has two rows both labeled `"date": "2026-08-05"`, which is why the
// Starter review treated them as "two genuine same-day events" worth $150.90. But
// the earlier row's `date_start` (06:00 UTC) is actually 23:00 Aug 4 in
// America/Los_Angeles -- the `date` field itself is mislabeled across a timezone
// boundary, the same class of bug as defect #3, just on the ad side. Deriving the
// bucket from `date_start` (not trusting `date`) puts $61.00 on Aug 4 and leaves
// $89.90 ($67.40 + $22.50) on Aug 5.
test("ad row's own `date` field is not trusted -- store-local date is derived from date_start", () => {
  const { db, companies } = freshIngestedDb();
  const lumen = getDashboardData(db, companies.lumen, { start: "2026-08-01", end: "2026-08-14" });

  const aug4 = lumen.daily.find((d) => d.date === "2026-08-04");
  const aug5 = lumen.daily.find((d) => d.date === "2026-08-05");
  assert.equal(aug4.adSpend, 61);
  assert.equal(aug5.adSpend, 89.9);
});
