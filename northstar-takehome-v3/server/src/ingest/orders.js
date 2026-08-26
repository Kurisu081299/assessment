import { decimalStringToCents } from "../money.js";
import { toStoreLocalDate } from "../timezone.js";

// A record with `refund_of` set is a refund event, not a new order (NOTES.md
// defect #1) -- it never touches the `orders` table. Two passes: real orders
// first, then refunds, so a refund can always resolve its parent regardless of
// file ordering.
export function ingestOrders(db, company, records) {
  const stats = { ordersUpserted: 0, refundsUpserted: 0, issues: 0 };
  const ingestedAt = new Date().toISOString();

  const upsertOrder = db.prepare(`
    INSERT INTO orders (company_id, source_order_id, name, created_at_raw, store_local_date, currency, financial_status, total_price_cents, ingested_at)
    VALUES (@companyId, @sourceOrderId, @name, @createdAtRaw, @storeLocalDate, @currency, @financialStatus, @totalPriceCents, @ingestedAt)
    ON CONFLICT(company_id, source_order_id) DO UPDATE SET
      name = excluded.name,
      created_at_raw = excluded.created_at_raw,
      store_local_date = excluded.store_local_date,
      currency = excluded.currency,
      financial_status = excluded.financial_status,
      total_price_cents = excluded.total_price_cents,
      ingested_at = excluded.ingested_at
    RETURNING id
  `);
  const deleteLineItems = db.prepare(`DELETE FROM line_items WHERE order_id = ?`);
  const insertLineItem = db.prepare(`
    INSERT INTO line_items (order_id, sku, title, quantity, price_cents) VALUES (?, ?, ?, ?, ?)
  `);
  const upsertRefund = db.prepare(`
    INSERT INTO refunds (company_id, source_refund_id, order_id, store_local_date, amount_cents, created_at_raw, ingested_at)
    VALUES (@companyId, @sourceRefundId, @orderId, @storeLocalDate, @amountCents, @createdAtRaw, @ingestedAt)
    ON CONFLICT(company_id, source_refund_id) DO UPDATE SET
      order_id = excluded.order_id,
      store_local_date = excluded.store_local_date,
      amount_cents = excluded.amount_cents,
      created_at_raw = excluded.created_at_raw,
      ingested_at = excluded.ingested_at
  `);
  const findOrderId = db.prepare(`SELECT id FROM orders WHERE company_id = ? AND source_order_id = ?`);
  const recordIssue = db.prepare(`
    INSERT INTO ingest_issues (company_id, source, source_record_id, reason, detail, detected_at)
    VALUES (@companyId, 'orders', @sourceRecordId, @reason, @detail, @detectedAt)
    ON CONFLICT(company_id, source, source_record_id, reason) DO UPDATE SET
      detail = excluded.detail, detected_at = excluded.detected_at
  `);

  const run = db.transaction((records) => {
    const orderRecords = records.filter((r) => !r.refund_of);
    const refundRecords = records.filter((r) => r.refund_of);

    for (const rec of orderRecords) {
      if (!rec.created_at) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: rec.id ?? null,
          reason: "missing_created_at",
          detail: "order missing created_at",
          detectedAt: ingestedAt,
        });
        stats.issues++;
        continue;
      }

      const storeLocalDate = toStoreLocalDate(rec.created_at, company.timezone);
      const { id: orderId } = upsertOrder.get({
        companyId: company.id,
        sourceOrderId: rec.id,
        name: rec.name ?? null,
        createdAtRaw: rec.created_at,
        storeLocalDate,
        currency: rec.currency ?? company.currency,
        financialStatus: rec.financial_status ?? null,
        totalPriceCents: decimalStringToCents(rec.total_price),
        ingestedAt,
      });

      deleteLineItems.run(orderId);
      for (const li of rec.line_items ?? []) {
        insertLineItem.run(orderId, li.sku ?? null, li.title ?? null, li.quantity ?? 0, decimalStringToCents(li.price));
      }
      stats.ordersUpserted++;
    }

    for (const rec of refundRecords) {
      if (!rec.created_at) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: rec.id ?? null,
          reason: "missing_created_at",
          detail: "refund missing created_at",
          detectedAt: ingestedAt,
        });
        stats.issues++;
        continue;
      }

      const storeLocalDate = toStoreLocalDate(rec.created_at, company.timezone);
      const original = findOrderId.get(company.id, rec.refund_of);
      if (!original) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: rec.id ?? null,
          reason: "orphan_refund",
          detail: `refund_of "${rec.refund_of}" not found among ingested orders`,
          detectedAt: ingestedAt,
        });
      }

      upsertRefund.run({
        companyId: company.id,
        sourceRefundId: rec.id,
        orderId: original ? original.id : null,
        storeLocalDate,
        amountCents: decimalStringToCents(rec.total_refunded),
        createdAtRaw: rec.created_at,
        ingestedAt,
      });
      stats.refundsUpserted++;
    }
  });

  run(records);
  return stats;
}
