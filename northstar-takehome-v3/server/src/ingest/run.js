import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { COMPANIES } from "../companies.js";
import { ingestOrders } from "./orders.js";
import { ingestAds } from "./ads.js";
import { loadOrders, loadAds } from "./loadFixtures.js";

// Re-running this end to end is idempotent: every table's natural key (source
// order/refund id, or ad-row content hash) means a second pass upserts the same
// rows to the same values rather than creating new ones. See NOTES.md for the
// paired "run twice" output that proves it.
export function ingestAll(db) {
  migrate(db);

  const startedAt = new Date().toISOString();
  const insertRun = db.prepare(
    `INSERT INTO ingest_runs (started_at, finished_at, status, stats_json) VALUES (?, ?, ?, ?)`
  );

  const getCompany = db.prepare(`SELECT * FROM companies WHERE slug = ?`);
  const perCompany = {};

  try {
    for (const cfg of Object.values(COMPANIES)) {
      const company = getCompany.get(cfg.slug);
      const orderRecords = loadOrders(cfg.slug);
      const adRecords = loadAds(cfg.slug);

      const orderStats = ingestOrders(db, company, orderRecords);
      const adStats = ingestAds(db, company, adRecords);

      perCompany[cfg.slug] = {
        company: company.name,
        sourceOrderRecords: orderRecords.length,
        sourceAdRecords: adRecords.length,
        ordersUpserted: orderStats.ordersUpserted,
        refundsUpserted: orderStats.refundsUpserted,
        orderIssues: orderStats.issues,
        rowsUpserted: adStats.rowsUpserted,
        rowsSkippedDuplicate: adStats.rowsSkippedDuplicate,
        currencyMismatches: adStats.currencyMismatches,
        adIssues: adStats.issues,
      };
    }

    const finishedAt = new Date().toISOString();
    insertRun.run(startedAt, finishedAt, "success", JSON.stringify(perCompany));
    return { status: "success", startedAt, finishedAt, perCompany };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    insertRun.run(startedAt, finishedAt, "failed", JSON.stringify({ error: String(err) }));
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const result = ingestAll(db);
  console.log(`Ingest ${result.status} — started ${result.startedAt}, finished ${result.finishedAt}`);
  for (const [slug, stats] of Object.entries(result.perCompany)) {
    console.log(`\n${stats.company} (${slug})`);
    console.log(`  source: ${stats.sourceOrderRecords} order records, ${stats.sourceAdRecords} ad records`);
    console.log(`  orders upserted:   ${stats.ordersUpserted}`);
    console.log(`  refunds upserted:  ${stats.refundsUpserted}`);
    console.log(`  ad rows upserted:  ${stats.rowsUpserted}`);
    console.log(`  ad rows skipped (exact duplicate): ${stats.rowsSkippedDuplicate}`);
    console.log(`  ad rows currency mismatch: ${stats.currencyMismatches}`);
    console.log(`  issues logged: ${stats.orderIssues + stats.adIssues + stats.currencyMismatches}`);
  }
  console.log("\nDashboard URLs:");
  for (const cfg of Object.values(COMPANIES)) {
    console.log(`  ${cfg.name}: http://localhost:${process.env.PORT || 4000}/d/${cfg.dashboardToken}`);
  }
  db.close();
}
