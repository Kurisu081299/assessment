import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { COMPANIES } from "../src/companies.js";
import { ingestOrders } from "../src/ingest/orders.js";
import { ingestAds } from "../src/ingest/ads.js";
import { getDashboardData } from "../src/kpi.js";
import { loadOrders, loadAds } from "../src/ingest/loadSource.js";
import { freshIngestedDb } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLAKY_SCRIPT = join(__dirname, "..", "..", "tools", "flaky_source.py");
const PORT = 8798;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RANGE = { start: "2026-08-01", end: "2026-08-14" };

let flaky;

before(async () => {
  flaky = spawn("python3", [FLAKY_SCRIPT, "--port", String(PORT)], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE_URL}/stats`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("flaky_source.py did not start listening in time");
});

after(() => {
  flaky?.kill();
});

// End-to-end proof that ingest driven at tools/flaky_source.py -- real 5xx,
// 429+Retry-After, truncated bodies, and a repeated page, not a mock of the
// retry logic -- still lands on exactly Part A's numbers. Also asserts the
// server's own /stats counters to prove every failure mode was actually
// triggered, not just theoretically handled.
test("ingest against the flaky HTTP source reproduces Part A's totals and row counts exactly", async () => {
  process.env.NORTHSTAR_SOURCE = "http";
  process.env.NORTHSTAR_SOURCE_URL = BASE_URL;
  try {
    await fetch(`${BASE_URL}/reset`);

    const db = openDb(":memory:");
    migrate(db);
    const companies = {};
    for (const cfg of Object.values(COMPANIES)) {
      const company = db.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
      companies[cfg.slug] = company;
      const orderRecords = await loadOrders(cfg.slug);
      const adRecords = await loadAds(cfg.slug);
      ingestOrders(db, company, orderRecords);
      ingestAds(db, company, adRecords);
    }

    const expected = freshIngestedDb();
    for (const slug of Object.keys(COMPANIES)) {
      const got = getDashboardData(db, companies[slug], RANGE).totals;
      const exp = getDashboardData(expected.db, expected.companies[slug], RANGE).totals;
      assert.deepEqual(got, exp, `${slug} totals must match Part A exactly`);
    }
    expected.db.close();

    const rowCounts = (d) => ({
      orders: d.prepare(`SELECT COUNT(*) n FROM orders`).get().n,
      lineItems: d.prepare(`SELECT COUNT(*) n FROM line_items`).get().n,
      refunds: d.prepare(`SELECT COUNT(*) n FROM refunds`).get().n,
      adSpend: d.prepare(`SELECT COUNT(*) n FROM ad_spend`).get().n,
    });
    const expectedFresh = freshIngestedDb();
    assert.deepEqual(rowCounts(db), rowCounts(expectedFresh.db));
    expectedFresh.db.close();
    db.close();

    const stats = await (await fetch(`${BASE_URL}/stats`)).json();
    assert.ok(stats.failed_500 > 0, "run must have actually hit a 500");
    assert.ok(stats.failed_429 > 0, "run must have actually hit a 429");
    assert.ok(stats.truncated > 0, "run must have actually hit a truncated body");
    assert.ok(stats.dup_pages > 0, "run must have actually hit a duplicate page");
  } finally {
    delete process.env.NORTHSTAR_SOURCE;
    delete process.env.NORTHSTAR_SOURCE_URL;
  }
});
