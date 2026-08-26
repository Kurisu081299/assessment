import { money } from "../format.js";

const REASON_LABEL = {
  missing_created_at: "excluded — missing date",
  currency_mismatch: "excluded from spend — wrong currency",
  orphan_refund: "refund with no matching order",
};

// Rows the pipeline couldn't cleanly use must be visible, not silently dropped.
export default function IssuesStrip({ issues, excludedForeignSpend, currency }) {
  // Currency mismatches are already shown with full amount detail below; don't
  // list the same row twice.
  const otherIssues = issues.filter((i) => i.reason !== "currency_mismatch");
  if (otherIssues.length === 0 && excludedForeignSpend.length === 0) return null;

  return (
    <div className="issues-strip">
      <div className="issues-title">Data quality flags</div>
      <ul>
        {excludedForeignSpend.map((row) => (
          <li key={`fx-${row.date}`}>
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
