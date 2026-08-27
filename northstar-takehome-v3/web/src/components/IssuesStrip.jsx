import { money } from "../format.js";

const REASON_LABEL = {
  missing_created_at: "excluded — missing date",
  currency_mismatch: "excluded — wrong currency",
  orphan_refund: "refund with no matching order",
  ambiguous_timestamp: "excluded — timestamp has no timezone, can't be trusted",
  voided_order: "excluded — order voided, not a sale",
  conflicting_duplicate_in_batch: "same order id sent twice with different content — last one kept",
  negative_spend_credit: "negative spend — platform credit, included in total",
};

// Rows the pipeline couldn't cleanly use must be visible, not silently dropped.
export default function IssuesStrip({ issues, excludedForeignSpend, excludedForeignRevenue, currency }) {
  // Currency mismatches are already shown with full amount detail below; don't
  // list the same row twice.
  const otherIssues = issues.filter((i) => i.reason !== "currency_mismatch");
  if (otherIssues.length === 0 && excludedForeignSpend.length === 0 && excludedForeignRevenue.length === 0) {
    return null;
  }

  return (
    <div className="issues-strip">
      <div className="issues-title">Data quality flags</div>
      <ul>
        {excludedForeignRevenue.map((row) => (
          <li key={`fx-rev-${row.date}-${row.currency}`}>
            {new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(row.amount)} of
            revenue on {row.date} excluded from totals — recorded in {row.currency}, not the company's {currency}.
          </li>
        ))}
        {excludedForeignSpend.map((row) => (
          <li key={`fx-spend-${row.date}-${row.currency}`}>
            {new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency }).format(row.amount)} of ad
            spend on {row.date} excluded from totals — recorded in {row.currency}, not the company's {currency}.
          </li>
        ))}
        {otherIssues.map((issue, i) => (
          <li key={`${issue.source}-${issue.source_record_id}-${issue.reason}-${i}`}>
            [{issue.source}] {issue.source_record_id || "(no id)"} — {REASON_LABEL[issue.reason] || issue.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
