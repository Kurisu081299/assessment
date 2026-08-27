import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshIngestedDb } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

// CR2 request #4 asked us to hand-delete Fina's negative-spend row from the
// fixture. Declined (see CR2-RESPONSE.md #4): it's a real platform credit, not
// corrupt data, so it stays in the fixture and in the total, flagged for
// visibility instead of silently erased.
test("Fina's negative ad-spend row is a platform credit: kept in the total, flagged, not deleted from the fixture", () => {
  const { db, companies } = freshIngestedDb();
  const fina = getDashboardData(db, companies.fina, range);

  const aug9 = fina.daily.find((d) => d.date === "2026-08-09");
  // 640.00 normal spend + (-250.00) credit = 390.00
  assert.equal(aug9.adSpend, 390);

  const issue = fina.issues.find((i) => i.reason === "negative_spend_credit");
  assert.ok(issue, "the credit row must be recorded as an issue for visibility");

  // The row must still be physically present in the fixture -- CR2 declined
  // hand-deleting it (see CR2-RESPONSE.md #4).
  const raw = JSON.parse(readFileSync(new URL("../../fixtures/fina.meta.ads.json", import.meta.url)));
  assert.ok(
    raw.some((r) => r.campaign_id === "F-C1" && r.date === "2026-08-09" && Number(r.spend) < 0),
    "the negative-spend row must remain in the source fixture"
  );
});
