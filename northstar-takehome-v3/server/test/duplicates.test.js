import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

// L-1007 and H-204 each appear twice in their fixture files, byte-for-byte
// identical (NOTES.md defect #2). A correct pipeline collapses each to exactly
// one order, not two.
test("byte-duplicate order rows collapse to a single order", () => {
  const { db, companies } = freshIngestedDb();
  const range = { start: "2026-08-01", end: "2026-08-14" };

  const lumenOrderCount = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND source_order_id = 'L-1007'`)
    .get(companies.lumen.id).n;
  assert.equal(lumenOrderCount, 1);

  const harborOrderCount = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE company_id = ? AND source_order_id = 'H-204'`)
    .get(companies.harbor.id).n;
  assert.equal(harborOrderCount, 1);

  const lumen = getDashboardData(db, companies.lumen, range);
  const lumenAug7 = lumen.daily.find((d) => d.date === "2026-08-07");
  assert.equal(lumenAug7.orders, 1);
  assert.equal(lumenAug7.grossSales, 86);

  const harbor = getDashboardData(db, companies.harbor, range);
  const harborAug4 = harbor.daily.find((d) => d.date === "2026-08-04");
  assert.equal(harborAug4.orders, 1);
  assert.equal(harborAug4.grossSales, 240);
});
