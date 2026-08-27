export function money(amount, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

export function roas(value) {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

export function weekday(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

export function percent(value) {
  if (value === null || value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

// Renders an ISO instant in the company's own timezone -- CR2 #3: the "last
// ingest" time was UTC-only, which doesn't tell an operator at a glance whether
// this morning's local sync ran.
export function localDateTime(isoTimestamp, timeZone) {
  if (!isoTimestamp) return null;
  // dateStyle/timeStyle can't be mixed with timeZoneName (Intl throws) -- spell
  // out the fields instead so the timezone abbreviation still shows.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(isoTimestamp));
}
