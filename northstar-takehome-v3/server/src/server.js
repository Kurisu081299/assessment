import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { openDb } from "./db.js";
import { getCompanyByToken, getDashboardData } from "./kpi.js";
import { DEFAULT_RANGE } from "./companies.js";

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
    const data = getDashboardData(db, company, { start, end });
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  const app = createApp(db);
  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`Northstar server listening on http://localhost:${port}`);
  });
}
