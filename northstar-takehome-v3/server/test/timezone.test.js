import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { toStoreLocalDate } from "../src/timezone.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// L-1009 and H-207 carry a bare `Z` (UTC) `created_at` instead of the store's own
// offset (NOTES.md defect #3). Slicing the first 10 characters gets the date wrong
// in *both* directions; only converting the true instant into the company's
// timezone is correct.
test("UTC order timestamp converts to the correct store-local date, not a naive slice", () => {
  assert.equal(toStoreLocalDate("2026-08-05T06:30:00Z", "America/Los_Angeles"), "2026-08-04");
  assert.equal(toStoreLocalDate("2026-08-07T14:30:00Z", "Australia/Sydney"), "2026-08-08");
});

test("L-1009 (Lumen) buckets to Aug 4 in LA time, not the naive Aug 5 slice", () => {
  const { db, companies } = freshIngestedDb();
  const order = db
    .prepare(`SELECT store_local_date FROM orders WHERE company_id = ? AND source_order_id = 'L-1009'`)
    .get(companies.lumen.id);
  assert.equal(order.store_local_date, "2026-08-04");

  const lumen = getDashboardData(db, companies.lumen, range);
  const aug4 = lumen.daily.find((d) => d.date === "2026-08-04");
  // L-1004 ($86) + L-1009 ($220) = 2 orders, $306 gross, minus the $192 refund
  // (L-1003-R, also dated Aug 4) landing the same day = $114 net.
  assert.equal(aug4.orders, 2);
  assert.equal(aug4.grossSales, 306);
  assert.equal(aug4.netRevenue, 114);
});

test("H-207 (Harbor) buckets to Aug 8 in Sydney time, not the naive Aug 7 slice", () => {
  const { db, companies } = freshIngestedDb();
  const order = db
    .prepare(`SELECT store_local_date FROM orders WHERE company_id = ? AND source_order_id = 'H-207'`)
    .get(companies.harbor.id);
  assert.equal(order.store_local_date, "2026-08-08");

  const harbor = getDashboardData(db, companies.harbor, range);
  const aug7 = harbor.daily.find((d) => d.date === "2026-08-07");
  const aug8 = harbor.daily.find((d) => d.date === "2026-08-08");
  assert.equal(aug7.orders, 1); // H-214 only
  assert.equal(aug8.orders, 2); // H-208 + H-207
  assert.equal(aug8.grossSales, 330);
});
