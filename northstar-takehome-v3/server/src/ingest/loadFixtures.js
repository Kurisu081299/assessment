import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "fixtures");
const SCALE_DIR = join(FIXTURES_DIR, "scale");

// Part B's scale fixtures (tools/gen_scale_fixtures.py) are JSONL -- one record
// per line, ~300k+ lines/company -- rather than the small fixtures' single JSON
// array, so ingest can read them without buffering one giant array literal to
// parse in one JSON.parse() call. Switch source with NORTHSTAR_FIXTURES=scale;
// default stays the small hand-authored fixtures Part A was built against.
function useScale() {
  return process.env.NORTHSTAR_FIXTURES === "scale";
}

function readJsonl(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) records.push(JSON.parse(trimmed));
  }
  return records;
}

export function loadOrders(slug) {
  return useScale()
    ? readJsonl(join(SCALE_DIR, `${slug}.shopify.orders.jsonl`))
    : JSON.parse(readFileSync(join(FIXTURES_DIR, `${slug}.shopify.orders.json`), "utf8"));
}

export function loadAds(slug) {
  return useScale()
    ? readJsonl(join(SCALE_DIR, `${slug}.meta.ads.jsonl`))
    : JSON.parse(readFileSync(join(FIXTURES_DIR, `${slug}.meta.ads.json`), "utf8"));
}
