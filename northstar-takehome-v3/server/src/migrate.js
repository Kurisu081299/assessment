import { pathToFileURL } from "node:url";
import { openDb } from "./db.js";
import { COMPANIES } from "./companies.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  currency TEXT NOT NULL,
  dashboard_token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source_order_id TEXT NOT NULL,
  name TEXT,
  created_at_raw TEXT NOT NULL,
  store_local_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  financial_status TEXT,
  total_price_cents INTEGER NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(company_id, source_order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_company_date ON orders(company_id, store_local_date);

CREATE TABLE IF NOT EXISTS line_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT,
  title TEXT,
  quantity INTEGER NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_line_items_order ON line_items(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source_refund_id TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  store_local_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at_raw TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(company_id, source_refund_id)
);
CREATE INDEX IF NOT EXISTS idx_refunds_company_date ON refunds(company_id, store_local_date);

CREATE TABLE IF NOT EXISTS ad_spend (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  store_local_date TEXT NOT NULL,
  date_start_utc TEXT NOT NULL,
  spend_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  impressions INTEGER,
  clicks INTEGER,
  row_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  UNIQUE(company_id, row_hash)
);
CREATE INDEX IF NOT EXISTS idx_ad_spend_company_date ON ad_spend(company_id, store_local_date);

CREATE TABLE IF NOT EXISTS ingest_issues (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source TEXT NOT NULL,
  source_record_id TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  detected_at TEXT NOT NULL,
  UNIQUE(company_id, source, source_record_id, reason)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  stats_json TEXT
);
`;

export function migrate(db) {
  db.exec(SCHEMA);

  const upsertCompany = db.prepare(`
    INSERT INTO companies (slug, name, timezone, currency, dashboard_token)
    VALUES (@slug, @name, @timezone, @currency, @dashboardToken)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      timezone = excluded.timezone,
      currency = excluded.currency,
      dashboard_token = excluded.dashboard_token
  `);
  const seedCompanies = db.transaction(() => {
    for (const company of Object.values(COMPANIES)) {
      upsertCompany.run(company);
    }
  });
  seedCompanies();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  migrate(db);
  console.log("Migration complete.");
  db.close();
}
