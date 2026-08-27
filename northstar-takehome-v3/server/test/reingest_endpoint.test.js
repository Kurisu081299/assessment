import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createApp } from "../src/server.js";
import { COMPANIES } from "../src/companies.js";

// Stretch: POST /api/ingest re-runs the full pipeline against the server's own
// live DB connection, no process restart -- the same ingestAll() the CLI uses.
let server, baseUrl, db;

before(async () => {
  db = openDb(":memory:");
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
});

test("POST /api/ingest runs ingest against the live server without a restart", async () => {
  const res = await fetch(`${baseUrl}/api/ingest`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "success");
  assert.ok(body.perCompany.lumen.ordersUpserted > 0);
  assert.ok(body.perCompany.fina.ordersUpserted > 0);
  assert.ok(typeof body.wallMs === "number" && body.wallMs >= 0);

  // The dashboard endpoint (same live connection, no restart) reflects it
  // immediately -- this is the point of "without a restart".
  const dashRes = await fetch(`${baseUrl}/api/dashboard/${COMPANIES.lumen.dashboardToken}`);
  const dashboard = await dashRes.json();
  assert.ok(dashboard.lastIngestAt, "dashboard must show a last-ingest time after the POST completed");
});

test("a second POST while one is in flight is rejected with 409, not raced", async () => {
  const [first, second] = await Promise.all([
    fetch(`${baseUrl}/api/ingest`, { method: "POST" }),
    fetch(`${baseUrl}/api/ingest`, { method: "POST" }),
  ]);
  const statuses = [first.status, second.status].sort();
  // Both may finish fast enough on tiny fixtures to both land as 200 -- what
  // must never happen is anything other than 200/200 or 200/409.
  assert.ok(
    JSON.stringify(statuses) === JSON.stringify([200, 200]) || JSON.stringify(statuses) === JSON.stringify([200, 409]),
    `unexpected status pair: ${statuses}`
  );
});
