// Part C proof: SIGKILL the ingest process mid-run against tools/flaky_source.py,
// inspect the database left behind, then re-run to completion and confirm the
// final numbers match Part A exactly. Output is pasted into NOTES.md -> "Failures".
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { migrate } from "../src/migrate.js";
import { COMPANIES } from "../src/companies.js";
import { getDashboardData } from "../src/kpi.js";
import { ingestOrders } from "../src/ingest/orders.js";
import { ingestAds } from "../src/ingest/ads.js";
import { loadOrders as loadOrdersFile, loadAds as loadAdsFile } from "../src/ingest/loadFixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, "..");
const REPO_ROOT = join(SERVER_DIR, "..");
const FLAKY_SCRIPT = join(REPO_ROOT, "tools", "flaky_source.py");
const DB_PATH = join(SERVER_DIR, "data", "northstar.killtest.sqlite");
const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RANGE = { start: "2026-08-01", end: "2026-08-14" };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) rmSync(p);
  }
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE_URL}/stats`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error("flaky_source.py did not start listening in time");
}

function rowCounts(dbPath) {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      integrityCheck: db.pragma("integrity_check", { simple: true }),
      orders: db.prepare(`SELECT COUNT(*) n FROM orders`).get().n,
      lineItems: db.prepare(`SELECT COUNT(*) n FROM line_items`).get().n,
      refunds: db.prepare(`SELECT COUNT(*) n FROM refunds`).get().n,
      adSpend: db.prepare(`SELECT COUNT(*) n FROM ad_spend`).get().n,
      ingestRuns: db.prepare(`SELECT status, COUNT(*) n FROM ingest_runs GROUP BY status`).all(),
    };
  } finally {
    db.close();
  }
}

function expectedTotals() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  migrate(db);
  const totals = {};
  for (const cfg of Object.values(COMPANIES)) {
    const company = db.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
    ingestOrders(db, company, loadOrdersFile(cfg.slug));
    ingestAds(db, company, loadAdsFile(cfg.slug));
    totals[cfg.slug] = getDashboardData(db, company, RANGE).totals;
  }
  db.close();
  return totals;
}

function runIngestChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["src/ingest/run.js"], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    child.on("error", reject);
  });
}

async function main() {
  console.log("=== Part C kill-safety proof ===\n");
  cleanDbFiles();

  const flaky = spawn("python3", [FLAKY_SCRIPT, "--port", String(PORT)], { stdio: "ignore" });
  await waitForServer();

  const env = {
    NORTHSTAR_SOURCE: "http",
    NORTHSTAR_SOURCE_URL: BASE_URL,
    NORTHSTAR_DB_PATH: DB_PATH,
  };

  console.log("--- Phase 1: launch ingest against the flaky source, SIGKILL it mid-run ---");
  const child = spawn("node", ["src/ingest/run.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killedOut = "";
  child.stdout.on("data", (d) => (killedOut += d));
  child.stderr.on("data", (d) => (killedOut += d));
  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  // The flaky source's injected backoffs/latencies mean a full run takes
  // several seconds; NORTHSTAR_KILL_DELAY_MS (default 350ms) controls where
  // in the fetch/write pipeline the kill lands -- override it to land
  // earlier (before any company has committed) or later (mid-second-company,
  // after the first has fully committed).
  const killDelayMs = Number(process.env.NORTHSTAR_KILL_DELAY_MS) || 350;
  await sleep(killDelayMs);
  child.kill("SIGKILL");
  const killResult = await exitPromise;
  console.log(`killed child pid=${child.pid} with signal=${killResult.signal}`);
  console.log(`stdout/stderr captured before kill:\n${killedOut.trim() || "(none -- killed before first company finished fetching)"}\n`);

  const afterKill = rowCounts(DB_PATH);
  console.log("DB state immediately after SIGKILL:");
  console.log(JSON.stringify(afterKill, null, 2));
  console.log();

  console.log("--- Phase 2: re-run ingest to completion against the same (possibly partial) DB ---");
  const finished = await runIngestChild(env);
  console.log(`exit code ${finished.code}`);
  console.log(finished.out.trim());
  console.log();

  const afterFinish = rowCounts(DB_PATH);
  console.log("DB state after the completed run:");
  console.log(JSON.stringify(afterFinish, null, 2));
  console.log();

  console.log("--- Phase 3: compare final totals against Part A's known-correct numbers ---");
  const finalDb = new Database(DB_PATH, { readonly: true });
  const got = {};
  for (const cfg of Object.values(COMPANIES)) {
    const company = finalDb.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
    got[cfg.slug] = getDashboardData(finalDb, company, RANGE).totals;
  }
  finalDb.close();

  const expected = expectedTotals();
  let allMatch = true;
  for (const slug of Object.keys(COMPANIES)) {
    const g = JSON.stringify(got[slug]);
    const e = JSON.stringify(expected[slug]);
    const match = g === e;
    allMatch = allMatch && match;
    console.log(`${slug}: got ${g}`);
    console.log(`${slug}: exp ${e}`);
    console.log(`${slug}: ${match ? "MATCH" : "MISMATCH"}\n`);
  }

  flaky.kill();
  cleanDbFiles();

  console.log(allMatch ? "PASS -- post-kill re-ingest reproduces Part A totals exactly." : "FAIL -- totals diverge.");
  process.exit(allMatch ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
