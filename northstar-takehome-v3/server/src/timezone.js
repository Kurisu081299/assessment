// Store-local calendar date for a company, derived from the record's true instant
// (Date correctly parses both a `-07:00` offset and a bare `Z`/UTC suffix) rather
// than string-slicing the first 10 characters of `created_at`, which silently
// assumes the timestamp is already store-local (see NOTES.md defect #3).
const formatterCache = new Map();

function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// A timestamp with no `Z` and no numeric UTC offset (e.g. "2026-08-03T23:30:00")
// has no fixed instant in time -- `new Date(...)` on such a string resolves it
// against the *host machine's* local timezone (ECMA-262 date-time string parsing),
// which is non-deterministic across environments and silently wrong the moment
// the server isn't running in UTC. Fina's F-303 is the first record we've seen
// this from (Lumen/Harbor's fixtures always carry an explicit offset). We refuse
// to guess: callers treat this the same as a missing timestamp.
export function hasExplicitOffset(isoTimestamp) {
  return typeof isoTimestamp === "string" && /(Z|[+-]\d{2}:?\d{2})$/i.test(isoTimestamp.trim());
}

export function toStoreLocalDate(isoTimestamp, timeZone) {
  if (!isoTimestamp) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}
