import test from "node:test";
import assert from "node:assert/strict";
import { freshIngestedDb, reingest } from "./helpers.js";
import { getDashboardData } from "../src/kpi.js";

const range = { start: "2026-08-01", end: "2026-08-14" };

function rowCounts(db) {
  return {
    orders: db.prepare(`SELECT COUNT(*) AS n FROM orders`).get().n,
    lineItems: db.prepare(`SELECT COUNT(*) AS n FROM line_items`).get().n,
    refunds: db.prepare(`SELECT COUNT(*) AS n FROM refunds`).get().n,
    adSpend: db.prepare(`SELECT COUNT(*) AS n FROM ad_spend`).get().n,
    issues: db.prepare(`SELECT COUNT(*) AS n FROM ingest_issues`).get().n,
  };
}

// Re-running ingest against the same source files must be a no-op on both row
// counts and KPI totals -- every table's natural key (source order/refund id, or
// ad-row content hash) makes a second pass an upsert onto the same rows, not new
// inserts. This is the numeric proof pasted into NOTES.md.
test("re-running ingest twice produces identical row counts", () => {
  const { db, companies } = freshIngestedDb();
  const first = rowCounts(db);

  reingest(db, companies);
  const second = rowCounts(db);

  assert.deepEqual(second, first);
});

test("re-running ingest twice produces identical KPI totals", () => {
  const { db, companies } = freshIngestedDb();
  const firstLumen = getDashboardData(db, companies.lumen, range).totals;
  const firstHarbor = getDashboardData(db, companies.harbor, range).totals;

  reingest(db, companies);

  const secondLumen = getDashboardData(db, companies.lumen, range).totals;
  const secondHarbor = getDashboardData(db, companies.harbor, range).totals;

  assert.deepEqual(secondLumen, firstLumen);
  assert.deepEqual(secondHarbor, firstHarbor);
});

test("re-running ingest three times is still stable", () => {
  const { db, companies } = freshIngestedDb();
  reingest(db, companies);
  const after2 = rowCounts(db);
  reingest(db, companies);
  const after3 = rowCounts(db);
  assert.deepEqual(after3, after2);
});
