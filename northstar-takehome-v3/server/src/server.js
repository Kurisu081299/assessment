import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { openDb } from "./db.js";
import { getCompanyByToken, getDashboardData } from "./kpi.js";
import { COMPANIES, DEFAULT_RANGE, lastNDaysRange } from "./companies.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(__dirname, "..", "..", "web", "dist");

export function createApp(db) {
  const app = express();

  if (existsSync(WEB_DIST)) {
    // index: false -- "/" must hit our own handler below, not auto-serve the SPA
    // shell (which is only valid under a checked /d/:token route).
    app.use(express.static(WEB_DIST, { index: false }));
  }

  // Wrong or unknown token -> a real 404, not a redirect and not the SPA shell.
  app.get("/api/dashboard/:token", (req, res) => {
    const company = getCompanyByToken(db, req.params.token);
    if (!company) {
      return res.status(404).json({ error: "not_found" });
    }
    const start = req.query.start || DEFAULT_RANGE.start;
    const end = req.query.end || DEFAULT_RANGE.end;
    // Server-Timing exposes the same server-side render time the Part B budget
    // is measured against directly in a normal HTTP response, so `curl -w` or
    // browser devtools can see it without an in-process harness.
    const t0 = process.hrtime.bigint();
    const data = getDashboardData(db, company, { start, end });
    const renderMs = Number(process.hrtime.bigint() - t0) / 1e6;
    res.set("Server-Timing", `dashboard;dur=${renderMs.toFixed(2)}`);
    res.json(data);
  });

  app.get("/d/:token", (req, res) => {
    const company = getCompanyByToken(db, req.params.token);
    if (!company) {
      return res.status(404).send("Not found.");
    }
    const indexPath = join(WEB_DIST, "index.html");
    if (!existsSync(indexPath)) {
      return res.status(500).send("Web app is not built yet — run `npm run build`.");
    }
    res.sendFile(indexPath);
  });

  app.get("/", (_req, res) => {
    res.send("Northstar — open your dashboard link (/d/{token}).");
  });

  return app;
}

// A cold SQLite connection's first hit on the dashboard's line_items JOIN costs
// ~500ms (page-in + b-tree decode on first touch of each page it needs) --
// index seeks already confirmed via EXPLAIN QUERY PLAN, so this isn't a missing-
// index problem. The server holds one long-lived connection for its whole life
// (see below), so that cost would otherwise land on whichever real request
// happens to be first. Pay it once at boot instead, before traffic arrives.
// See NOTES.md -> "Bottleneck" for the before/after measurements.
function warmDashboardCache(db) {
  const range = lastNDaysRange(DEFAULT_RANGE.end, 90);
  const t0 = process.hrtime.bigint();
  for (const cfg of Object.values(COMPANIES)) {
    const company = db.prepare(`SELECT * FROM companies WHERE slug = ?`).get(cfg.slug);
    if (company) getDashboardData(db, company, range);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`Warmed dashboard cache for ${range.start}..${range.end} in ${ms.toFixed(1)}ms`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const app = createApp(db);
  warmDashboardCache(db);
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Northstar server listening on http://localhost:${port}`);
  });
}
