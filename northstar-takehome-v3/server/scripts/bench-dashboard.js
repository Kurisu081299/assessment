// Part B latency measurement. Three independent tools, on purpose -- one number
// from one angle is easy to fool yourself with:
//   1. In-process Node hrtime around the exact function the API route calls
//      (getDashboardData) -- this is the "server-side render" number the brief's
//      500ms budget is actually about, with no HTTP/JSON overhead mixed in.
//   2. SQLite's own EXPLAIN QUERY PLAN for each query getDashboardData runs --
//      proves *why* it's fast (or isn't): index seeks vs full scans.
//   3. A real HTTP round trip via curl (see README/NOTES) for end-to-end sanity
//      on top of the in-process number.
//
// Usage:
//   node scripts/bench-dashboard.js [--start=YYYY-MM-DD --end=YYYY-MM-DD] [--iterations=30]
//
// Defaults to the last 90 days ending 2026-08-14 (the range Part B's budget is
// about) against NORTHSTAR_DB_PATH (see package.json's "bench" script).
import { openDb } from "../src/db.js";
import { getDashboardData } from "../src/kpi.js";
import { COMPANIES, lastNDaysRange } from "../src/companies.js";

function parseArgs(argv) {
  const out = { iterations: 30 };
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function percentile(sortedMs, p) {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

function explainQueryPlan(db, sql, params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
}

const args = parseArgs(process.argv.slice(2));
const range = args.start && args.end ? { start: args.start, end: args.end } : lastNDaysRange("2026-08-14", 90);
const iterations = Number(args.iterations);

console.log(`Range under test: ${range.start} .. ${range.end} (inclusive)`);
console.log(`DB: ${process.env.NORTHSTAR_DB_PATH || "(default path — see src/db.js)"}`);
console.log(`Iterations per company: ${iterations}\n`);

const db = openDb();

for (const cfg of Object.values(COMPANIES)) {
  const company = db.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
  if (!company) {
    console.log(`(skipping ${cfg.slug} — not seeded in this DB)`);
    continue;
  }

  // Tool 1: in-process hrtime, one cold call then N warm calls.
  const coldStart = process.hrtime.bigint();
  const data = getDashboardData(db, company, range);
  const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;

  const warmMs = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    getDashboardData(db, company, range);
    warmMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  warmMs.sort((a, b) => a - b);

  console.log(`## ${company.name} (${company.slug})`);
  console.log(
    `  cold: ${coldMs.toFixed(2)}ms   warm min/p50/p95/max: ` +
      `${warmMs[0].toFixed(2)}/${percentile(warmMs, 50).toFixed(2)}/` +
      `${percentile(warmMs, 95).toFixed(2)}/${warmMs[warmMs.length - 1].toFixed(2)} ms`
  );
  console.log(
    `  totals over range: ${data.totals.orders} orders, $${data.totals.grossSales.toFixed(2)} gross, ` +
      `$${data.totals.netRevenue.toFixed(2)} net, $${data.totals.adSpend.toFixed(2)} spend, ` +
      `ROAS ${data.totals.roas === null ? "—" : data.totals.roas.toFixed(2)}`
  );

  // Tool 2: query plans for the same four queries getDashboardData runs.
  console.log(`  query plans:`);
  const plans = {
    gross: explainQueryPlan(
      db,
      `SELECT o.store_local_date AS date, SUM(li.price_cents * li.quantity) AS cents
       FROM line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.company_id = ? AND o.store_local_date BETWEEN ? AND ?
       GROUP BY o.store_local_date`,
      [company.id, range.start, range.end]
    ),
    orderCount: explainQueryPlan(
      db,
      `SELECT store_local_date AS date, COUNT(*) AS cnt FROM orders
       WHERE company_id = ? AND store_local_date BETWEEN ? AND ? GROUP BY store_local_date`,
      [company.id, range.start, range.end]
    ),
    refunds: explainQueryPlan(
      db,
      `SELECT store_local_date AS date, SUM(amount_cents) AS cents FROM refunds
       WHERE company_id = ? AND store_local_date BETWEEN ? AND ? GROUP BY store_local_date`,
      [company.id, range.start, range.end]
    ),
    spend: explainQueryPlan(
      db,
      `SELECT store_local_date AS date, SUM(spend_cents) AS cents FROM ad_spend
       WHERE company_id = ? AND currency = ? AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date`,
      [company.id, company.currency, range.start, range.end]
    ),
  };
  for (const [name, rows] of Object.entries(plans)) {
    for (const row of rows) {
      console.log(`    ${name}: ${row.detail}`);
    }
  }
  console.log("");
}

db.close();
