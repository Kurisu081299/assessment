import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// Full-range totals, matching NOTES.md's hand-verified "Full corrected KPI table"
// exactly. This is the top-level oracle: if any per-bug fix regresses, one of
// these two totals moves.
test("Lumen Co full-range totals match the hand-verified corrected numbers", () => {
  const { db, companies } = freshIngestedDb();
  const totals = getDashboardData(db, companies.lumen, range).totals;
  assert.equal(totals.orders, 13);
  assert.equal(totals.grossSales, 1750);
  assert.equal(totals.refunds, 192);
  assert.equal(totals.netRevenue, 1558);
  assert.equal(totals.adSpend, 771.15);
  assert.ok(Math.abs(totals.roas - 2.02) < 0.005);
});

test("Harbor Co full-range totals match the hand-verified corrected numbers", () => {
  const { db, companies } = freshIngestedDb();
  const totals = getDashboardData(db, companies.harbor, range).totals;
  assert.equal(totals.orders, 14);
  assert.equal(totals.grossSales, 2580);
  assert.equal(totals.refunds, 80);
  assert.equal(totals.netRevenue, 2500);
  assert.equal(totals.adSpend, 1076.1);
  assert.ok(Math.abs(totals.roas - 2.32) < 0.005);
});
