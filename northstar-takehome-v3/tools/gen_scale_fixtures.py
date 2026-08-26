#!/usr/bin/env python3
"""
Generate large, deterministic fixtures with the same kinds of dirt as the small ones.

    python3 tools/gen_scale_fixtures.py                 # ~300k orders/company, 730 days
    python3 tools/gen_scale_fixtures.py --orders 50000  # smaller

Writes JSONL (one record per line) to fixtures/scale/:
    {company}.shopify.orders.jsonl
    {company}.meta.ads.jsonl
and fixtures/scale/EXPECTED.json with per-company totals for the last 90 days
so the candidate can check themselves (and so you can check them).

Dirt ratios: 1% exact duplicate orders, 2% UTC ("Z") timestamps, 0.3% null
created_at, 3% refunds (posted 1-10 days later, 30% of them partial),
one foreign-currency ad row per ~200, two same-day rows for a campaign ~5% of days.
"""
import argparse
import json
import os
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone, date
from decimal import Decimal as D
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures", "scale")

COS = {
    "lumen": dict(tz="America/Los_Angeles", cur="USD", prefix="L", off="-07:00",
                  skus=[("LM-TEE-BLK", 48), ("LM-TEE-WHT", 48), ("LM-CAP", 38), ("LM-HOOD", 128), ("LM-KIT", 64)],
                  campaigns=["L-C1", "L-C2", "L-C3"]),
    "harbor": dict(tz="Australia/Sydney", cur="AUD", prefix="H", off="+10:00",
                   skus=[("HB-OIL", 90), ("HB-SET", 240), ("HB-MASK", 55)],
                   campaigns=["H-C1", "H-C2"]),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orders", type=int, default=300_000)
    ap.add_argument("--days", type=int, default=730)
    ap.add_argument("--end", default="2026-08-14")
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(a.seed)
    end = date.fromisoformat(a.end)
    start = end - timedelta(days=a.days - 1)
    check_from = end - timedelta(days=89)
    expected = {}

    for co, c in COS.items():
        Z = ZoneInfo(c["tz"])
        gross = defaultdict(D); refunds = defaultdict(D); orders = defaultdict(int); spend = defaultdict(D)
        unattributed = 0; dupes = 0; foreign = 0
        opath = os.path.join(OUT, f"{co}.shopify.orders.jsonl")
        with open(opath, "w") as f:
            for i in range(a.orders):
                oid = f"{c['prefix']}-{100000 + i}"
                day = start + timedelta(days=rng.randrange(a.days))
                local = datetime(day.year, day.month, day.day, rng.randrange(24), rng.randrange(60), rng.randrange(60), tzinfo=Z)
                items = []
                for _ in range(rng.choice([1, 1, 1, 2, 2, 3])):
                    sku, price = rng.choice(c["skus"])
                    items.append({"sku": sku, "title": sku, "quantity": rng.choice([1, 1, 1, 2]), "price": f"{price:.2f}"})
                total = sum(D(li["price"]) * li["quantity"] for li in items)
                r = rng.random()
                if r < 0.003:
                    created = None; unattributed += 1
                elif r < 0.023:
                    created = local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                else:
                    created = local.isoformat()
                rec = {"id": oid, "name": f"#{oid}", "created_at": created, "currency": c["cur"],
                       "financial_status": "paid", "total_price": f"{total:.2f}", "total_refunded": "0.00",
                       "line_items": items}
                f.write(json.dumps(rec) + "\n")
                if created is not None:
                    ld = local.date()
                    gross[ld] += total; orders[ld] += 1
                if rng.random() < 0.01:
                    f.write(json.dumps(rec) + "\n"); dupes += 1
                if created is not None and rng.random() < 0.03:
                    rday = local + timedelta(days=rng.randrange(1, 11), hours=rng.randrange(24))
                    amt = total if rng.random() > 0.3 else (total * D("0.5")).quantize(D("0.01"))
                    rrec = {"id": f"{oid}-R", "name": f"#{oid}-R", "created_at": rday.isoformat(), "currency": c["cur"],
                            "financial_status": "refunded", "total_price": f"{total:.2f}", "total_refunded": f"{amt:.2f}",
                            "line_items": items, "refund_of": oid}
                    f.write(json.dumps(rrec) + "\n")
                    refunds[rday.date()] += amt

        apath = os.path.join(OUT, f"{co}.meta.ads.jsonl")
        with open(apath, "w") as f:
            for dno in range(a.days):
                day = start + timedelta(days=dno)
                for camp in c["campaigns"]:
                    rows = 2 if rng.random() < 0.05 else 1
                    for _ in range(rows):
                        local = datetime(day.year, day.month, day.day, rng.randrange(24), rng.randrange(60), tzinfo=Z)
                        amt = D(rng.randrange(2000, 12000)) / 100
                        cur = c["cur"]
                        if rng.random() < 0.005:
                            cur = "EUR"; foreign += 1
                        rec = {"campaign_id": camp, "campaign_name": camp, "date": day.isoformat(),
                               "date_start": local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "spend": f"{amt:.2f}", "currency": cur,
                               "impressions": rng.randrange(1000, 20000), "clicks": rng.randrange(50, 600)}
                        f.write(json.dumps(rec) + "\n")
                        if cur == c["cur"]:
                            spend[local.date()] += amt

        days = [check_from + timedelta(days=i) for i in range(90)]
        G = sum(gross[d] for d in days); R = sum(refunds[d] for d in days)
        S = sum(spend[d] for d in days); O = sum(orders[d] for d in days)
        expected[co] = {"range": [check_from.isoformat(), end.isoformat()], "orders": O,
                        "gross": f"{G:.2f}", "refunds": f"{R:.2f}", "net": f"{G - R:.2f}", "spend": f"{S:.2f}",
                        "roas": f"{((G - R) / S):.4f}" if S else None,
                        "unattributed_total": unattributed, "duplicate_records_total": dupes,
                        "foreign_currency_ad_rows_total": foreign}
        print(f"{co}: {a.orders} orders (+{dupes} dupes, {unattributed} undated) -> {opath}")

    with open(os.path.join(OUT, "EXPECTED.json"), "w") as f:
        json.dump(expected, f, indent=2)
    print("expected last-90-day totals ->", os.path.join(OUT, "EXPECTED.json"))


if __name__ == "__main__":
    main()
