// Money is stored as integer minor units (cents) everywhere past ingest, computed
// by string parsing rather than float arithmetic -- avoids the accumulation drift
// the starter script was exposed to (native `float` totals, see NOTES.md defect #9).

export function decimalStringToCents(value) {
  if (value === null || value === undefined) return 0;
  const str = String(value).trim();
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [whole, frac = ""] = unsigned.split(".");
  const fracPadded = (frac + "00").slice(0, 2);
  const cents = Number(whole || "0") * 100 + Number(fracPadded || "0");
  return negative ? -cents : cents;
}

export function centsToNumber(cents) {
  return Math.round(cents) / 100;
}

export function centsToDisplay(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}
