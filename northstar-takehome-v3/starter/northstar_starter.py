#!/usr/bin/env python3
"""
Northstar KPI pipeline — first pass.

Reads the Shopify-shaped order dumps and Meta-shaped ad dumps for each company,
normalizes them, and prints the daily KPI table for the default reporting range.
Stdlib only, no database yet; the SQL schema is the obvious next step once the
numbers are agreed.

Usage:
    python3 starter/northstar_starter.py            # both companies
    python3 starter/northstar_starter.py lumen      # one company

Handles the known data quality issues in the exports:
  * Meta occasionally re-sends the same campaign/day row — deduplicated.
  * Refunded orders carry total_refunded — netted out of revenue.
  * Some records are missing created_at — skipped.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

COMPANIES = {
    "lumen": {"name": "Lumen Co", "tz": "America/Los_Angeles", "currency": "USD"},
    "harbor": {"name": "Harbor Co", "tz": "Australia/Sydney", "currency": "AUD"},
}

RANGE_START = "2026-08-01"
RANGE_END = "2026-08-14"


def load(company: str, source: str) -> list[dict]:
    suffix = "shopify.orders.json" if source == "orders" else "meta.ads.json"
    with open(FIXTURES / f"{company}.{suffix}") as f:
        return json.load(f)


def order_day(rec: dict) -> str | None:
    """Store-local calendar date of the order."""
    created = rec.get("created_at")
    if not created:
        return None
    # ISO 8601: the date is always the first ten characters.
    return created[:10]


def in_range(day: str) -> bool:
    return RANGE_START <= day < RANGE_END


def ingest_orders(company: str):
    gross = defaultdict(float)
    refunds = defaultdict(float)
    orders = defaultdict(int)

    for rec in load(company, "orders"):
        day = order_day(rec)
        if day is None:
            continue  # export is missing the field; nothing we can do with it
        if not in_range(day):
            continue
        line_total = sum(float(li["price"]) * li["quantity"] for li in rec.get("line_items", []))
        gross[day] += line_total
        orders[day] += 1
        refunded = float(rec.get("total_refunded") or 0)
        if refunded:
            refunds[day] += refunded
    return gross, refunds, orders


def ingest_ads(company: str):
    """Meta re-sends rows; key on (campaign, date) so a re-send can't double count."""
    seen = {}
    for rec in load(company, "ads"):
        key = (rec["campaign_id"], rec["date"])
        seen[key] = rec  # latest wins
    spend = defaultdict(float)
    for (_, day), rec in seen.items():
        if in_range(day):
            spend[day] += float(rec["spend"])
    return spend


def report(company: str) -> None:
    meta = COMPANIES[company]
    gross, refunds, orders = ingest_orders(company)
    spend = ingest_ads(company)

    days = sorted(set(gross) | set(orders))
    print(f"\n=== {meta['name']} ({meta['currency']}, {meta['tz']}) {RANGE_START}..{RANGE_END} ===")
    print(f"{'day':<12}{'orders':>7}{'gross':>10}{'refunds':>10}{'net':>10}{'spend':>10}{'roas':>8}")
    tg = tr = ts = 0.0
    to = 0
    for d in days:
        g, r, s, o = gross[d], refunds[d], spend[d], orders[d]
        net = g - r
        roas = f"{net / s:.2f}" if s else "—"
        print(f"{d:<12}{o:>7}{g:>10.2f}{r:>10.2f}{net:>10.2f}{s:>10.2f}{roas:>8}")
        tg += g; tr += r; ts += s; to += o
    print(f"{'TOTAL':<12}{to:>7}{tg:>10.2f}{tr:>10.2f}{tg - tr:>10.2f}{ts:>10.2f}{(tg - tr) / ts:>8.2f}")


if __name__ == "__main__":
    targets = sys.argv[1:] or list(COMPANIES)
    for c in targets:
        report(c)
