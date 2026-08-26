import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// "A day with spend and no sales is still a day" (KPI contract) -- the starter
// built its day list from days that had a gross/order entry, so a spend-only day
// vanished entirely (NOTES.md defect #7). Both companies have real Aug 9 ad spend
// and zero orders.
test("a day with ad spend and zero orders still appears with the correct spend", () => {
  const { db, companies } = freshIngestedDb();

  const lumen = getDashboardData(db, companies.lumen, range);
  const lumenAug9 = lumen.daily.find((d) => d.date === "2026-08-09");
  assert.ok(lumenAug9, "Aug 9 row must be present for Lumen");
  assert.equal(lumenAug9.orders, 0);
  assert.equal(lumenAug9.grossSales, 0);
  assert.equal(lumenAug9.adSpend, 39.5);
  // net=0, spend>0 -> ROAS is a real 0, distinct from the spend=0 "no data" case.
  assert.equal(lumenAug9.roas, 0);

  const harbor = getDashboardData(db, companies.harbor, range);
  const harborAug9 = harbor.daily.find((d) => d.date === "2026-08-09");
  assert.ok(harborAug9, "Aug 9 row must be present for Harbor");
  assert.equal(harborAug9.orders, 0);
  assert.equal(harborAug9.adSpend, 90);
  assert.equal(harborAug9.roas, 0);
});

test("a day with no orders and no spend renders ROAS as null (UI em dash)", () => {
  const { db, companies } = freshIngestedDb();
  // Nothing in the fixtures falls entirely silent, so assert the contract directly
  // against a day with genuinely zero spend by construction: zero out spend and
  // confirm the KPI layer's null branch, not a UI-string special case.
  const zeroSpendCompany = companies.lumen;
  const dashboard = getDashboardData(db, zeroSpendCompany, { start: "2026-09-01", end: "2026-09-01" });
  const day = dashboard.daily[0];
  assert.equal(day.adSpend, 0);
  assert.equal(day.roas, null);
});
