import crypto from "node:crypto";
import { decimalStringToCents } from "../money.js";
import { toStoreLocalDate, hasExplicitOffset } from "../timezone.js";

// A byte-identical resend must be dropped; two genuinely different spend events for
// the same campaign/day must both be summed (NOTES.md defect #4 -- the starter's
// (campaign, date) key conflates the two). We dedupe on a hash of the full row
// instead, so identity is "this exact spend event", not "this campaign on this day".
function rowHash(rec) {
  const canonical = JSON.stringify({
    campaign_id: rec.campaign_id,
    date: rec.date,
    date_start: rec.date_start,
    spend: rec.spend,
    currency: rec.currency,
    impressions: rec.impressions,
    clicks: rec.clicks,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function ingestAds(db, company, records) {
  const stats = { rowsUpserted: 0, rowsSkippedDuplicate: 0, currencyMismatches: 0, issues: 0 };
  const ingestedAt = new Date().toISOString();

  const insertAd = db.prepare(`
    INSERT INTO ad_spend (company_id, campaign_id, campaign_name, store_local_date, date_start_utc, spend_cents, currency, impressions, clicks, row_hash, ingested_at)
    VALUES (@companyId, @campaignId, @campaignName, @storeLocalDate, @dateStartUtc, @spendCents, @currency, @impressions, @clicks, @rowHash, @ingestedAt)
    ON CONFLICT(company_id, row_hash) DO NOTHING
  `);
  const recordIssue = db.prepare(`
    INSERT INTO ingest_issues (company_id, source, source_record_id, reason, detail, detected_at)
    VALUES (@companyId, 'ads', @sourceRecordId, @reason, @detail, @detectedAt)
    ON CONFLICT(company_id, source, source_record_id, reason) DO UPDATE SET
      detail = excluded.detail, detected_at = excluded.detected_at
  `);

  const run = db.transaction((records) => {
    for (const rec of records) {
      if (!rec.date_start) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: rec.campaign_id ?? null,
          reason: "missing_date_start",
          detail: "ad row missing date_start",
          detectedAt: ingestedAt,
        });
        stats.issues++;
        continue;
      }

      if (!hasExplicitOffset(rec.date_start)) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: rec.campaign_id ?? null,
          reason: "ambiguous_timestamp",
          detail: `ad row date_start "${rec.date_start}" has no UTC offset or Z -- true instant is undeterminable, row not ingested`,
          detectedAt: ingestedAt,
        });
        stats.issues++;
        continue;
      }

      const storeLocalDate = toStoreLocalDate(rec.date_start, company.timezone);
      const hash = rowHash(rec);
      const result = insertAd.run({
        companyId: company.id,
        campaignId: rec.campaign_id,
        campaignName: rec.campaign_name ?? null,
        storeLocalDate,
        dateStartUtc: rec.date_start,
        spendCents: decimalStringToCents(rec.spend),
        currency: rec.currency ?? company.currency,
        impressions: rec.impressions ?? null,
        clicks: rec.clicks ?? null,
        rowHash: hash,
        ingestedAt,
      });

      if (result.changes === 0) {
        stats.rowsSkippedDuplicate++;
        continue;
      }
      stats.rowsUpserted++;

      // Negative spend is a real platform-issued credit (Meta refunding an
      // over-charge), not corrupt data -- it genuinely reduces what the company
      // was billed that day, so it stays in the sum (CR2-RESPONSE.md #4: we do
      // NOT hand-delete it from the fixture, which would silently erase the
      // audit trail and re-break the moment the fixture is re-synced). Flagged
      // here so it's visible on the dashboard rather than an unexplained dip.
      if (decimalStringToCents(rec.spend) < 0) {
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: `${rec.campaign_id}:${rec.date_start}`,
          reason: "negative_spend_credit",
          detail: `ad row for ${rec.campaign_id} on ${storeLocalDate} has negative spend (${rec.spend} ${rec.currency ?? company.currency}) -- treated as a platform credit and included in the total, not deleted`,
          detectedAt: ingestedAt,
        });
        stats.issues++;
      }

      if (rec.currency && rec.currency !== company.currency) {
        stats.currencyMismatches++;
        recordIssue.run({
          companyId: company.id,
          sourceRecordId: `${rec.campaign_id}:${rec.date}`,
          reason: "currency_mismatch",
          detail: `ad row currency ${rec.currency} does not match company currency ${company.currency}; excluded from spend total`,
          detectedAt: ingestedAt,
        });
      }
    }
  });

  run(records);
  return stats;
}
