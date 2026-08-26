import { money, roas, weekday } from "../format.js";

export default function DailyTable({ daily, currency }) {
  return (
    <div className="table-wrap">
      <table className="daily-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Orders</th>
            <th>Gross sales</th>
            <th>Refunds</th>
            <th>Net revenue</th>
            <th>Ad spend</th>
            <th>ROAS</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((row) => (
            <tr key={row.date} className={row.orders === 0 && row.adSpend > 0 ? "row-spend-only" : ""}>
              <td>
                {row.date} <span className="weekday">{weekday(row.date)}</span>
              </td>
              <td>{row.orders}</td>
              <td>{money(row.grossSales, currency)}</td>
              <td>{row.refunds ? money(row.refunds, currency) : "—"}</td>
              <td>{money(row.netRevenue, currency)}</td>
              <td>{money(row.adSpend, currency)}</td>
              <td>{roas(row.roas)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
