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

export function toStoreLocalDate(isoTimestamp, timeZone) {
  if (!isoTimestamp) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}
