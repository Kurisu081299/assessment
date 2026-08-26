import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// A refund record (`id` suffixed -R, `refund_of` set) is a refund event, not a new
// order (NOTES.md defect #1). It must never inflate the order count or gross sales,
// and its amount must be `total_refunded` (the actual refunded amount), not the
// line-item total -- Harbor's H-201-R is a *partial* refund ($80 of a $90 order).
test("refund record is not counted as an order", () => {
  const { db, companies } = freshIngestedDb();
  const orderCount = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND source_order_id = 'L-1003-R'`)
    .get(companies.lumen.id).n;
  assert.equal(orderCount, 0);
});

test("partial refund nets correctly, not the original order's full line-item total", () => {
  const { db, companies } = freshIngestedDb();
  const harbor = getDashboardData(db, companies.harbor, range);
  const aug11 = harbor.daily.find((d) => d.date === "2026-08-11");

  // H-210 ($240) is the only real order on Aug 11; H-201-R refunds $80 (not $90)
  // against H-201 (placed Aug 1). Correct net: 240 - 80 = 160, not the starter's
  // buggy $250 (which came from double-counting H-201-R as a second $90 "order").
  assert.equal(aug11.orders, 1);
  assert.equal(aug11.grossSales, 240);
  assert.equal(aug11.refunds, 80);
  assert.equal(aug11.netRevenue, 160);
});

test("refund lands on the refund's own store-local date, not the original order's date", () => {
  const { db, companies } = freshIngestedDb();
  const harbor = getDashboardData(db, companies.harbor, range);

  const aug1 = harbor.daily.find((d) => d.date === "2026-08-01"); // H-201 placed here
  assert.equal(aug1.refunds, 0);

  const aug11 = harbor.daily.find((d) => d.date === "2026-08-11"); // H-201-R issued here
  assert.equal(aug11.refunds, 80);
});
