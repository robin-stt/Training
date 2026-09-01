#!/usr/bin/env python3
"""Slår ihop Health Auto Export-filerna i data/health-auto-export/ till en CSV.

Varje fil är en rå payload från appens REST API-export:
    {"data": {"metrics": [{"name": ..., "units": ..., "data": [{"date": ..., "qty": ...}]}],
              "workouts": [...]}}

Skriptet aggregerar per dag och metrik och skriver
data/processed/hae_daglig.csv. Exporter kan överlappa (appen kan skicka
"idag" flera gånger); filerna läses i namnordning och senaste filens värde
för en given dag+metrik vinner.

Användning:
    python3 scripts/merge_hae.py
    python3 scripts/merge_hae.py --in data/health-auto-export --out data/processed
"""

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

# Metriknamn i Health Auto Export → kolumn och aggregering.
# Aggregering per dag: sum = summa av datapunkter, avg = medel, last = sista.
KNOWN_METRICS = {
    "step_count": ("steg", "sum"),
    "active_energy": ("aktiv_energi_kcal", "sum"),
    "walking_running_distance": ("distans_km", "sum"),
    "resting_heart_rate": ("vilopuls", "avg"),
    "heart_rate_variability": ("hrv_ms", "avg"),
    "weight_body_mass": ("vikt_kg", "last"),
    "sleep_analysis": ("somn_timmar", "sum"),
}

BASE_COLUMNS = ["datum"] + [col for col, _ in KNOWN_METRICS.values()]


def point_value(metric_name, point):
    """Plockar värdet ur en datapunkt; sömn har egna fält i stället för qty."""
    if metric_name == "sleep_analysis":
        if "asleep" in point:
            return point["asleep"]
        phases = [point.get(k) for k in ("core", "deep", "rem")]
        phases = [v for v in phases if isinstance(v, (int, float))]
        if phases:
            return sum(phases)
    value = point.get("qty", point.get("avg"))
    return value if isinstance(value, (int, float)) else None


def aggregate(metric_name, points_by_day):
    """dag -> [värden] → dag -> aggregat."""
    _, how = KNOWN_METRICS.get(metric_name, (None, "avg"))
    result = {}
    for day, values in points_by_day.items():
        if not values:
            continue
        if how == "sum":
            result[day] = round(sum(values), 2)
        elif how == "last":
            result[day] = round(values[-1], 2)
        else:
            result[day] = round(sum(values) / len(values), 2)
    return result


def main():
    parser = argparse.ArgumentParser(description="Health Auto Export-JSON → CSV")
    parser.add_argument("--in", dest="indir", type=Path, default=Path("data/health-auto-export"))
    parser.add_argument("--out", type=Path, default=Path("data/processed"))
    args = parser.parse_args()

    files = sorted(args.indir.glob("*.json"))
    if not files:
        sys.exit(f"Inga JSON-filer i {args.indir} — har appen skickat något än?")

    # (dag, kolumn) -> värde; senare filer skriver över tidigare.
    table = {}
    extra_columns = []

    for path in files:
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            print(f"Hoppar över {path.name}: kunde inte läsas ({err})", file=sys.stderr)
            continue
        metrics = payload.get("data", {}).get("metrics", [])
        if not isinstance(metrics, list):
            continue
        for metric in metrics:
            name = metric.get("name", "")
            column = KNOWN_METRICS.get(name, (name, None))[0]
            if not column:
                continue
            if column not in BASE_COLUMNS and column not in extra_columns:
                extra_columns.append(column)
            points_by_day = defaultdict(list)
            for point in metric.get("data", []):
                date = str(point.get("date", ""))[:10]
                value = point_value(name, point)
                if len(date) == 10 and value is not None:
                    points_by_day[date].append(value)
            for day, value in aggregate(name, points_by_day).items():
                table[(day, column)] = value

    if not table:
        sys.exit("Ingen metrikdata hittades i filerna.")

    columns = BASE_COLUMNS + extra_columns
    days = sorted({day for day, _ in table})
    rows = []
    for day in days:
        row = {"datum": day}
        for column in columns[1:]:
            if (day, column) in table:
                row[column] = table[(day, column)]
        rows.append(row)

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "hae_daglig.csv"
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, restval="")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Skrev {out_path}: {len(rows)} dagar ({days[0]} – {days[-1]}) från {len(files)} filer")


if __name__ == "__main__":
    main()
