import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { COMPANIES } from "../companies.js";
import { ingestOrders } from "./orders.js";
import { ingestAds } from "./ads.js";
import { loadOrders, loadAds, resetSourceIfHttp } from "./loadSource.js";

// Re-running this end to end is idempotent: every table's natural key (source
// order/refund id, or ad-row content hash) means a second pass upserts the same
// rows to the same values rather than creating new ones. See NOTES.md for the
// paired "run twice" output that proves it.
//
// Async because the source may be tools/flaky_source.py (Part C): each
// company/source pair is fully fetched -- with retries -- into a plain array
// *before* any database write happens, so a kill mid-fetch touches no DB
// state, and a kill mid-write lands inside one sqlite transaction (see
// orders.js/ads.js) that rolls back cleanly on next open. See NOTES.md ->
// "Failures".
export async function ingestAll(db) {
  migrate(db);
  await resetSourceIfHttp();

  const startedAt = new Date().toISOString();
  const insertRun = db.prepare(
    `INSERT INTO ingest_runs (started_at, finished_at, status, stats_json) VALUES (?, ?, ?, ?)`
  );

  const getCompany = db.prepare(`SELECT * FROM companies WHERE slug = ?`);
  const perCompany = {};

  try {
    for (const cfg of Object.values(COMPANIES)) {
      const company = getCompany.get(cfg.slug);

      // Part B's scale generator (tools/gen_scale_fixtures.py) only ever wrote
      // lumen/harbor -- it predates Fina Co (CR1) and regenerating 300k+ rows
      // for a third company is out of CR1's scope. A company missing a fixture
      // for the active source (NORTHSTAR_FIXTURES=scale) is skipped with a
      // visible warning rather than crashing the whole batch; every other
      // source (the real fixtures, and the flaky HTTP source) has Fina data.
      let orderRecords, adRecords;
      try {
        orderRecords = await loadOrders(cfg.slug);
        adRecords = await loadAds(cfg.slug);
      } catch (err) {
        if (err.code === "ENOENT") {
          console.warn(`Skipping ${cfg.name}: no fixture for this source (${err.path})`);
          perCompany[cfg.slug] = { company: company.name, skipped: true, reason: err.path };
          continue;
        }
        throw err;
      }

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
  const wallStart = process.hrtime.bigint();
  const result = await ingestAll(db);
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  // maxRSS is the process's peak resident set size *since process start*, in KB
  // on both darwin and linux (Node normalizes getrusage's platform-dependent
  // unit) -- since ingest is this process's only real work, it's a direct peak-
  // memory reading, not an estimate from periodic sampling.
  const peakRssMb = process.resourceUsage().maxRSS / 1024;
  console.log(`Ingest ${result.status} — started ${result.startedAt}, finished ${result.finishedAt}`);
  console.log(`Wall clock: ${wallMs.toFixed(1)} ms   Peak RSS: ${peakRssMb.toFixed(1)} MB`);
  for (const [slug, stats] of Object.entries(result.perCompany)) {
    console.log(`\n${stats.company} (${slug})`);
    if (stats.skipped) {
      console.log(`  SKIPPED — no fixture for this source (${stats.reason})`);
      continue;
    }
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
