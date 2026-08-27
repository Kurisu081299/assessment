import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// Fina Co (CR1) is messy in ways Lumen/Harbor never were: a wrong-currency
// order, a voided order, an offset-less timestamp, and the same order id sent
// twice in one batch with different content. Each must be visible and excluded
// from KPIs the same way an ad-side currency mismatch already is -- not summed
// as if it were a normal PHP sale.
test("Fina's hand-verified totals: wrong-currency and voided orders excluded, credit included", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  // F-301, F-304, F-306 (last occurrence: 1500, not 3900), F-307, F-309 = 1500*4 + 900
  // F-302 is fully refunded, still counts as a sale until its refund is applied.
  assert.equal(fina.totals.orders, 6); // F-301, F-302, F-304, F-306, F-307, F-309
  assert.equal(fina.totals.grossSales, 9300);
  assert.equal(fina.totals.refunds, 2400); // F-302-R, full refund of F-302
  assert.equal(fina.totals.netRevenue, 6900);
});

test("F-308 (a $50 USD order in a PHP company) is excluded from revenue and surfaced, not converted", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  const aug12 = fina.daily.find((d) => d.date === "2026-08-12");
  assert.equal(aug12.orders, 0); // F-308 does not count as a PHP order
  assert.equal(aug12.grossSales, 0);

  assert.equal(fina.excludedForeignRevenue.length, 1);
  assert.equal(fina.excludedForeignRevenue[0].currency, "USD");
  assert.equal(fina.excludedForeignRevenue[0].amount, 50);

  const issue = fina.issues.find((i) => i.reason === "currency_mismatch" && i.source_record_id === "F-308");
  assert.ok(issue, "currency mismatch on an order must be recorded in ingest_issues");
});

test("F-305 (voided) is not a sale and does not inflate orders or gross sales", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  // F-304 (16:00 UTC = 2026-08-05 00:00 Asia/Manila) is the only real sale that
  // buckets to Aug 5; F-305 (voided, 2400.00) must not add to it.
  const aug5 = fina.daily.find((d) => d.date === "2026-08-05");
  assert.equal(aug5.orders, 1);
  assert.equal(aug5.grossSales, 1500);

  const issue = fina.issues.find((i) => i.reason === "voided_order" && i.source_record_id === "F-305");
  assert.ok(issue, "voided order must be recorded in ingest_issues");
});

test("F-303's offset-less timestamp is not guessed at -- the order is excluded and flagged", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  const orderRow = db
    .prepare(`SELECT id FROM orders WHERE company_id = ? AND source_order_id = 'F-303'`)
    .get(companies.fina.id);
  assert.equal(orderRow, undefined, "F-303 must not be ingested without a determinable instant");

  const issue = fina.issues.find((i) => i.reason === "ambiguous_timestamp" && i.source_record_id === "F-303");
  assert.ok(issue, "ambiguous timestamp must be recorded in ingest_issues");
});

test("F-306 sent twice in one batch with different content: last occurrence wins, and it's flagged", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  const order = db
    .prepare(`SELECT total_price_cents FROM orders WHERE company_id = ? AND source_order_id = 'F-306'`)
    .get(companies.fina.id);
  assert.equal(order.total_price_cents, 150000); // 1500.00, the second (last) payload -- not 3900.00

  const issue = fina.issues.find((i) => i.reason === "conflicting_duplicate_in_batch" && i.source_record_id === "F-306");
  assert.ok(issue, "a same-batch id conflict must be recorded, not resolved silently");
});
