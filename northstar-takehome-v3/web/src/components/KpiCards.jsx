import { money, roas } from "../format.js";

export default function KpiCards({ totals, currency }) {
  const cards = [
    { label: "Gross sales", value: money(totals.grossSales, currency) },
    { label: "Net revenue", value: money(totals.netRevenue, currency) },
    { label: "Orders", value: totals.orders.toLocaleString() },
    { label: "Ad spend", value: money(totals.adSpend, currency) },
    { label: "ROAS", value: roas(totals.roas) },
  ];

  return (
    <div className="kpi-grid">
      {cards.map((c) => (
        <div className="kpi-card" key={c.label}>
          <div className="kpi-label">{c.label}</div>
          <div className="kpi-value">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
