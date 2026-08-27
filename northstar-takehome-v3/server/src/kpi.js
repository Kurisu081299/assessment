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

// Pure calendar-date arithmetic (no timezone conversion) -- store_local_date is
// already a company-local bucket, so "one week earlier" is just subtracting 7
// from that string, the same way enumerateDates walks the range.
function daysBefore(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return new Date(d.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function getCompanyByToken(db, token) {
  return db.prepare(`SELECT * FROM companies WHERE dashboard_token = ?`).get(token);
}

// CR1's "yesterday vs same day last week" strip needs one day's net revenue,
// orders, and ad spend at a time, using the exact same currency/voided filters
// as the range KPIs above -- otherwise the comparison and the daily table could
// disagree on what a "sale" is. `hasData` is a *separate* signal (any row at all
// recorded for the company on that date, filtered or not) from "the filtered
// totals are zero" -- a day before the shop existed and a day where every order
// was voided both zero out the same way, but only the first is "no data".
function getSingleDayMetrics(db, company, date) {
  const gross = db
    .prepare(
      `SELECT SUM(li.price_cents * li.quantity) AS cents
       FROM line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.company_id = ? AND o.currency = ? AND o.financial_status != 'voided' AND o.store_local_date = ?`
    )
    .get(company.id, company.currency, date).cents ?? 0;

  const orders = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE company_id = ? AND currency = ? AND financial_status != 'voided' AND store_local_date = ?`
    )
    .get(company.id, company.currency, date).cnt;

  const refunds = db
    .prepare(
      `SELECT SUM(r.amount_cents) AS cents
       FROM refunds r LEFT JOIN orders o ON o.id = r.order_id
       WHERE r.company_id = ? AND (o.id IS NULL OR (o.currency = ? AND o.financial_status != 'voided'))
         AND r.store_local_date = ?`
    )
    .get(company.id, company.currency, date).cents ?? 0;

  const spend = db
    .prepare(
      `SELECT SUM(spend_cents) AS cents FROM ad_spend WHERE company_id = ? AND currency = ? AND store_local_date = ?`
    )
    .get(company.id, company.currency, date).cents ?? 0;

  const anyRow = db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM orders WHERE company_id = ? AND store_local_date = ?
         UNION SELECT 1 FROM ad_spend WHERE company_id = ? AND store_local_date = ?) AS present`
    )
    .get(company.id, date, company.id, date).present;

  const netCents = gross - refunds;
  return {
    date,
    netRevenue: centsToNumber(netCents),
    orders,
    adSpend: centsToNumber(spend),
    hasData: Boolean(anyRow),
  };
}

// null when the baseline is 0 (or missing) -- a percentage against a zero or
// absent base is meaningless/divides-by-zero, not "misleadingly small". The UI
// renders that as "—", same convention as ROAS with zero spend.
function percentChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function getComparison(db, company, endDate) {
  const previousDate = daysBefore(endDate, 7);
  const current = getSingleDayMetrics(db, company, endDate);
  const previous = getSingleDayMetrics(db, company, previousDate);

  return {
    current,
    previous,
    changes:
      current.hasData && previous.hasData
        ? {
            netRevenue: percentChange(current.netRevenue, previous.netRevenue),
            orders: percentChange(current.orders, previous.orders),
            adSpend: percentChange(current.adSpend, previous.adSpend),
          }
        : null,
  };
}

// Every calendar day in [start, end] gets a row, zero-filled -- not just the days
// that happen to have an order or a spend record. This is what makes a day with ad
// spend and zero orders show up correctly (NOTES.md defect #7), rather than only
// appearing when it happens to intersect the set of days with orders.
export function getDashboardData(db, company, { start, end }) {
  const dates = enumerateDates(start, end);

  // Orders in the wrong currency (Fina's F-308, a $50 USD order in a PHP company)
  // and voided orders (F-305 -- authorization voided, nothing ever captured) are
  // excluded from every sales KPI the same way ad_spend already excludes foreign-
  // currency rows below: visible in ingest_issues / excludedForeignRevenue, never
  // silently summed as if they were real store-currency sales.
  const grossRows = db
    .prepare(
      `SELECT o.store_local_date AS date, SUM(li.price_cents * li.quantity) AS cents
       FROM line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.company_id = ? AND o.currency = ? AND o.financial_status != 'voided'
         AND o.store_local_date BETWEEN ? AND ?
       GROUP BY o.store_local_date`
    )
    .all(company.id, company.currency, start, end);

  const orderCountRows = db
    .prepare(
      `SELECT store_local_date AS date, COUNT(*) AS cnt
       FROM orders
       WHERE company_id = ? AND currency = ? AND financial_status != 'voided'
         AND store_local_date BETWEEN ? AND ?
       GROUP BY store_local_date`
    )
    .all(company.id, company.currency, start, end);

  // A refund's own currency isn't stored (Shopify refunds are always in the
  // parent order's currency); a refund is excluded here exactly when its parent
  // order was excluded from gross above, so net revenue = gross - refunds stays
  // internally consistent for the same set of orders. An orphan refund (no
  // resolvable order_id -- already flagged as its own issue) is kept, since we
  // have no currency to judge it against.
  const refundRows = db
    .prepare(
      `SELECT r.store_local_date AS date, SUM(r.amount_cents) AS cents
       FROM refunds r LEFT JOIN orders o ON o.id = r.order_id
       WHERE r.company_id = ? AND (o.id IS NULL OR (o.currency = ? AND o.financial_status != 'voided'))
         AND r.store_local_date BETWEEN ? AND ?
       GROUP BY r.store_local_date`
    )
    .all(company.id, company.currency, start, end);

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

  const excludedRevenueRows = db
    .prepare(
      `SELECT store_local_date AS date, currency, SUM(total_price_cents) AS cents
       FROM orders
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
    excludedForeignRevenue: excludedRevenueRows.map((r) => ({
      date: r.date,
      currency: r.currency,
      amount: centsToNumber(r.cents),
    })),
    comparison: getComparison(db, company, end),
  };
}
