import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

// H-C9 is a $25.00 USD ad row sitting inside Harbor's AUD account export (NOTES.md
// defect #5). It must not be summed into AUD spend, and it must still be visible
// somewhere -- not silently dropped, not silently "fixed" into AUD.
test("a wrong-currency ad row is excluded from spend and surfaced as an issue", () => {
  const { db, companies } = freshIngestedDb();
  const range = { start: "2026-08-01", end: "2026-08-14" };
  const harbor = getDashboardData(db, companies.harbor, range);

  const aug12 = harbor.daily.find((d) => d.date === "2026-08-12");
  assert.equal(aug12.adSpend, 69); // H-C1's AUD row only, not +25 USD-as-AUD

  assert.equal(harbor.excludedForeignSpend.length, 1);
  assert.equal(harbor.excludedForeignSpend[0].date, "2026-08-12");
  assert.equal(harbor.excludedForeignSpend[0].currency, "USD");
  assert.equal(harbor.excludedForeignSpend[0].amount, 25);

  const issue = harbor.issues.find((i) => i.reason === "currency_mismatch");
  assert.ok(issue, "currency mismatch must be recorded in ingest_issues");
});
