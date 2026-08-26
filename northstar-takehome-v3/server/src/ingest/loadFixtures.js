import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "fixtures");

export function loadOrders(slug) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${slug}.shopify.orders.json`), "utf8"));
}

export function loadAds(slug) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${slug}.meta.ads.json`), "utf8"));
}
