// Selects where ingest reads records from, same env-var-toggle pattern
// loadFixtures.js already uses for NORTHSTAR_FIXTURES=scale. Default stays
// the local fixture files; NORTHSTAR_SOURCE=http points ingest at
// tools/flaky_source.py (Part C) via httpSource.js instead. loadFixtures.js
// itself is untouched -- test/helpers.js depends on its synchronous, file-
// only behavior, so the HTTP path lives here instead.
import { loadOrders as loadOrdersFromFile, loadAds as loadAdsFromFile } from "./loadFixtures.js";
import { fetchAllPages, resetFlakySource } from "./httpSource.js";

function useHttp() {
  return process.env.NORTHSTAR_SOURCE === "http";
}

function baseUrl() {
  return process.env.NORTHSTAR_SOURCE_URL || "http://127.0.0.1:8787";
}

// Clears the mock source's per-process failure counters at the start of a
// run, so retry behavior doesn't depend on requests a previous run made.
// No-op against the file source.
export async function resetSourceIfHttp() {
  if (useHttp()) await resetFlakySource(baseUrl());
}

export async function loadOrders(slug) {
  return useHttp() ? fetchAllPages(baseUrl(), slug, "orders") : loadOrdersFromFile(slug);
}

export async function loadAds(slug) {
  return useHttp() ? fetchAllPages(baseUrl(), slug, "ads") : loadAdsFromFile(slug);
}
