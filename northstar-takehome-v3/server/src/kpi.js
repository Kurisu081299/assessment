import { centsToNumber } from "./money.js";

function enumerateDates(start, end) {
  const dates = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return dates;
}

function toMap(rows, key = "date", value = "cents") {
  const map = new Map();
  for (const row of rows) map.set(row[key], row[value] ?? 0);
  return map;
}

export function getCompanyByToken(db, token) {
  return db.prepare(`SELECT * FROM companies WHERE dashboard_token = ?`).get(token);
}

// Every calendar day in [start, end] gets a row, zero-filled -- not just the days
// that happen to have an order or a spend record. This is what makes a day with ad
// spend and zero orders show up correctly (NOTES.md defect #7), rather than only
// appearing when it happens to intersect the set of days with orders.
export function getDashboardData(db, company, { start, end }) {
  const dates = enumerateDates(start, end);

  const grossRows = db
    .prepare(
      `SELECT o.store_local_date AS date, SUM(li.price_cents * li.quantity) AS cents
       FROM line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.company_id = ? AND o.store_local_date BETWEEN ? AND ?
       GROUP BY o.store_local_date`
    )
    .all(company.id, start, end);

  const orderCountRows = db
    .prepare(
      `SELECT store_local_date AS date, COUNT(*) AS cnt
       FROM orders
       WHERE company_id = ? AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date`
    )
    .all(company.id, start, end);

  const refundRows = db
    .prepare(
      `SELECT store_local_date AS date, SUM(amount_cents) AS cents
       FROM refunds
       WHERE company_id = ? AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date`
    )
    .all(company.id, start, end);

  const spendRows = db
    .prepare(
      `SELECT store_local_date AS date, SUM(spend_cents) AS cents
       FROM ad_spend
       WHERE company_id = ? AND currency = ? AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date`
    )
    .all(company.id, company.currency, start, end);

  const excludedSpendRows = db
    .prepare(
      `SELECT store_local_date AS date, currency, SUM(spend_cents) AS cents
       FROM ad_spend
       WHERE company_id = ? AND currency != ? AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date, currency`
    )
    .all(company.id, company.currency, start, end);

  const grossMap = toMap(grossRows);
  const orderCountMap = toMap(orderCountRows, "date", "cnt");
  const refundMap = toMap(refundRows);
  const spendMap = toMap(spendRows);

  const daily = dates.map((date) => {
    const grossCents = grossMap.get(date) ?? 0;
    const refundCents = refundMap.get(date) ?? 0;
    const spendCents = spendMap.get(date) ?? 0;
    const netCents = grossCents - refundCents;
    return {
      date,
      orders: orderCountMap.get(date) ?? 0,
      grossSales: centsToNumber(grossCents),
      netRevenue: centsToNumber(netCents),
      refunds: centsToNumber(refundCents),
      adSpend: centsToNumber(spendCents),
      roas: spendCents > 0 ? netCents / spendCents : null,
    };
  });

  const totals = daily.reduce(
    (acc, row) => {
      acc.orders += row.orders;
      acc.grossSales += row.grossSales;
      acc.netRevenue += row.netRevenue;
      acc.refunds += row.refunds;
      acc.adSpend += row.adSpend;
      return acc;
    },
    { orders: 0, grossSales: 0, netRevenue: 0, refunds: 0, adSpend: 0 }
  );
  totals.roas = totals.adSpend > 0 ? totals.netRevenue / totals.adSpend : null;

  const lastRun = db
    .prepare(`SELECT finished_at FROM ingest_runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1`)
    .get();

  const issues = db
    .prepare(`SELECT source, source_record_id, reason, detail, detected_at FROM ingest_issues WHERE company_id = ? ORDER BY detected_at DESC`)
    .all(company.id);

  return {
    company: {
      name: company.name,
      currency: company.currency,
      timezone: company.timezone,
    },
    range: { start, end },
    daily,
    totals,
    lastIngestAt: lastRun ? lastRun.finished_at : null,
    issues,
    excludedForeignSpend: excludedSpendRows.map((r) => ({
      date: r.date,
      currency: r.currency,
      amount: centsToNumber(r.cents),
    })),
  };
}
