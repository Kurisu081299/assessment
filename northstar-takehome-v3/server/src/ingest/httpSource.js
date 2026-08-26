// Client for tools/flaky_source.py -- a paginated HTTP source that returns
// 5xx, 429+Retry-After, truncated bodies, and a repeated page, on a schedule
// documented in that file's docstring. Every failure mode gets a distinct,
// deliberate handling; see NOTES.md -> "Failures" for the reasoning.
//
// This module only *fetches*. It returns a complete, deduped array of records
// for one (company, source) stream, or throws. Nothing is written to the
// database until the caller has a complete array in hand -- that's what makes
// ingest safe to kill mid-run: a kill during fetch touches no DB state at all,
// and a kill during the write phase lands inside a single sqlite transaction
// that rolls back cleanly on next open.

const DEFAULT_LIMIT = 5;
const MAX_ATTEMPTS = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff for 5xx/network errors: the server isn't telling us
// when it'll recover, so we guess with a capped, jittered exponential curve.
function backoffMs(attempt) {
  const base = Math.min(2000, 200 * 2 ** (attempt - 1));
  return base + Math.random() * 100;
}

// Thrown for a response that retrying can never fix (e.g. a 404 from a
// mistyped company/source) -- distinct from every other branch below, all of
// which are transient and worth another attempt.
class FatalFetchError extends Error {}

// A truncated body doesn't always surface as invalid JSON: undici enforces
// the Content-Length header strictly, and flaky_source.py's truncated
// response declares a Content-Length *larger* than the bytes it actually
// sends before closing the connection -- so the failure can show up as a
// body-read error (ResponseContentLengthMismatchError) before JSON.parse
// ever runs. Both are the same "bad body, re-fetch" case.
function isTruncatedBodyError(err) {
  return err.name === "SyntaxError" || err.cause?.code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH";
}

async function fetchPage(baseUrl, company, source, cursor, limit) {
  const url = `${baseUrl}/${company}/${source}?cursor=${cursor}&limit=${limit}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let delayMs;
    try {
      const res = await fetch(url);

      if (res.status === 429) {
        // Server told us exactly how long to wait -- honor it instead of our
        // own backoff curve. Drain the body so the socket can be reused.
        await res.arrayBuffer().catch(() => {});
        delayMs = (Number(res.headers.get("retry-after")) || 1) * 1000;
      } else if (res.status >= 500) {
        await res.arrayBuffer().catch(() => {});
        delayMs = backoffMs(attempt);
      } else if (!res.ok) {
        // A 404 or other 4xx here means a config error (bad company/source
        // name), not a flaky upstream -- retrying can't fix that. Fail fast
        // and loud instead of looping forever against a URL that will never
        // succeed. This is the one thing we deliberately do NOT retry.
        throw new FatalFetchError(`fatal ${res.status} fetching ${url} -- not retrying`);
      } else {
        const text = await res.text();
        return JSON.parse(text);
      }
    } catch (err) {
      if (err instanceof FatalFetchError) throw err;
      // Connection-level failure or a truncated/broken body -- both
      // transient, worth another attempt.
      delayMs = isTruncatedBodyError(err) ? 50 : backoffMs(attempt);
    }

    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`giving up on ${url} after ${attempt} attempts`);
    }
    await sleep(delayMs);
  }
}

// Walks the cursor chain for one (company, source) stream to completion.
// The mock source hands back the SAME next_cursor once, on purpose, so the
// very next fetch re-serves the page we just processed -- we track which
// cursors we've already appended and skip the data (not the request) on a
// repeat, so a duplicate page can't double-count records.
export async function fetchAllPages(baseUrl, company, source, { limit = DEFAULT_LIMIT } = {}) {
  const records = [];
  const seenCursors = new Set();
  let cursor = 0;
  let pagesFetched = 0;
  const guard = 100000; // pagination-loop backstop, not a real limit

  while (cursor !== null) {
    if (pagesFetched++ > guard) {
      throw new Error(`pagination did not terminate for ${company}/${source} (>${guard} pages)`);
    }

    const page = await fetchPage(baseUrl, company, source, cursor, limit);

    if (!seenCursors.has(cursor)) {
      records.push(...page.data);
      seenCursors.add(cursor);
    }
    // else: this is the repeated page -- already captured on the first pass.

    cursor = page.next_cursor === null || page.next_cursor === undefined ? null : Number(page.next_cursor);
  }

  return records;
}

// Clears the mock source's failure counters so a run's behavior doesn't
// depend on how many requests a previous run happened to make.
export async function resetFlakySource(baseUrl) {
  const res = await fetch(`${baseUrl}/reset`);
  if (!res.ok) {
    throw new Error(`failed to reset flaky source at ${baseUrl}: ${res.status}`);
  }
  await res.json();
}
