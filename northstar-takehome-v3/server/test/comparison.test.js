import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

// CR1: "yesterday vs same day last week" -- the last day of the *selected range*
// (not the server clock's real yesterday) compared to the same weekday 7 days
// earlier, in the company's own timezone bucketing.
test("comparison uses the range's end date vs 7 days earlier, in store-local dates", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, { start: "2026-08-01", end: "2026-08-14" });

  assert.equal(fina.comparison.current.date, "2026-08-14");
  assert.equal(fina.comparison.previous.date, "2026-08-07");
});

test("a real zero baseline (previous day had ad spend but zero orders) shows '—' for that metric, not a divide-by-zero", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, { start: "2026-08-01", end: "2026-08-14" });

  // Aug 7: no orders, 690 PHP ad spend. Aug 14: 1 order, 630 PHP ad spend.
  assert.equal(fina.comparison.previous.orders, 0);
  assert.equal(fina.comparison.previous.hasData, true);
  assert.equal(fina.comparison.current.hasData, true);
  assert.equal(fina.comparison.changes.orders, null); // not Infinity, not a misleading number
  assert.equal(fina.comparison.changes.netRevenue, null); // previous net revenue was also 0
  assert.ok(typeof fina.comparison.changes.adSpend === "number"); // both sides nonzero -- a real percentage
});

test("a day with no data at all on either side of the comparison is reported as 'no data', not a fabricated 0%", () => {
  const { db, companies } = freshIngestedDb();
  // Nothing is ingested before 2026-08-01 for any company -- a range ending
  // there has no real "last week" to compare against.
  const lumen = getDashboardData(db, companies.lumen, { start: "2026-08-01", end: "2026-08-01" });

  assert.equal(lumen.comparison.current.date, "2026-08-01");
  assert.equal(lumen.comparison.previous.date, "2026-07-25");
  assert.equal(lumen.comparison.previous.hasData, false);
  assert.equal(lumen.comparison.changes, null);
});
