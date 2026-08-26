import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { ingestOrders } from "../src/ingest/orders.js";
import { ingestAds } from "../src/ingest/ads.js";
import { loadOrders, loadAds } from "../src/ingest/loadFixtures.js";
import { COMPANIES } from "../src/companies.js";

// Fresh in-memory DB per test, seeded from the real fixtures -- tests assert
// against numbers already hand-verified in NOTES.md's "Full corrected KPI table",
// not synthetic data, so a broken pipeline can't hide behind a convenient fixture.
export function freshIngestedDb() {
  const db = openDb(":memory:");
  migrate(db);

  const companies = {};
  for (const cfg of Object.values(COMPANIES)) {
    const company = db.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
    companies[cfg.slug] = company;
    ingestOrders(db, company, loadOrders(cfg.slug));
    ingestAds(db, company, loadAds(cfg.slug));
  }

  return { db, companies };
}

export function reingest(db, companies) {
  for (const slug of Object.keys(companies)) {
    ingestOrders(db, companies[slug], loadOrders(slug));
    ingestAds(db, companies[slug], loadAds(slug));
  }
}
