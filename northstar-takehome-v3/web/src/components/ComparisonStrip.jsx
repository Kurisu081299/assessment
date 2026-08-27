import { money, percent } from "../format.js";

const METRICS = [
  { key: "netRevenue", label: "Net revenue", format: (v, currency) => money(v, currency) },
  { key: "orders", label: "Orders", format: (v) => v.toLocaleString() },
  { key: "adSpend", label: "Ad spend", format: (v, currency) => money(v, currency) },
];

// CR1: "yesterday" is the last day of the selected range, not the calendar day
// relative to the server clock -- an operator picking a past range still gets a
// same-weekday comparison for the range they're actually looking at.
export default function ComparisonStrip({ comparison, currency }) {
  if (!comparison) return null;
  const { current, previous, changes } = comparison;

  return (
    <section className="comparison-strip">
      <h2>
        {current.date} vs {previous.date} <span className="comparison-subtitle">(same weekday, one week earlier)</span>
      </h2>
      {!changes ? (
        <p className="comparison-no-data">
          {!current.hasData && !previous.hasData
            ? `No data for ${current.date} or ${previous.date} — nothing to compare.`
            : !current.hasData
              ? `No data for ${current.date} — nothing to compare.`
              : `No data for ${previous.date} — nothing to compare.`}
        </p>
      ) : (
        <div className="comparison-grid">
          {METRICS.map((m) => (
            <div className="comparison-cell" key={m.key}>
              <div className="comparison-label">{m.label}</div>
              <div className="comparison-values">
                <span className="comparison-current">{m.format(current[m.key], currency)}</span>
                <span className="comparison-previous">vs {m.format(previous[m.key], currency)}</span>
              </div>
              <div
                className={
                  "comparison-change" +
                  (changes[m.key] > 0 ? " up" : changes[m.key] < 0 ? " down" : "")
                }
              >
                {percent(changes[m.key])}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
