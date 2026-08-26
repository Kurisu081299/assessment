import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

// The brief's default range, "2026-08-01 .. 2026-08-14", is explicitly inclusive.
// The starter used `day < RANGE_END`, which silently dropped Aug 14 (NOTES.md
// defect #6): Lumen's Aug 14 ad spend and Harbor's Aug 14 order both vanished.
test("Aug 14 is included in the default range, not dropped", () => {
  const { db, companies } = freshIngestedDb();
  const range = { start: "2026-08-01", end: "2026-08-14" };

  const lumen = getDashboardData(db, companies.lumen, range);
  const lumenAug14 = lumen.daily.find((d) => d.date === "2026-08-14");
  assert.ok(lumenAug14, "Aug 14 row must exist");
  assert.equal(lumenAug14.adSpend, 49.15);

  const harbor = getDashboardData(db, companies.harbor, range);
  const harborAug14 = harbor.daily.find((d) => d.date === "2026-08-14");
  assert.ok(harborAug14, "Aug 14 row must exist");
  assert.equal(harborAug14.orders, 1);
  assert.equal(harborAug14.grossSales, 90);
  assert.equal(harborAug14.adSpend, 80);
});
