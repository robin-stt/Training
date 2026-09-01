#!/usr/bin/env python3
"""Bearbetar en manuell zip-export från Health Auto Export.

Zippen (Exportera → CSV i appen) innehåller bl.a. två summeringsfiler:
  HealthAutoExport-<period>.csv   en rad per dag, alla mätvärden
  Workouts-<period>.csv           en rad per träningspass

Skriptet plockar ut de intressanta kolumnerna, konverterar kJ → kcal och
skriver data/processed/hae_manuell_daglig.csv och hae_traningspass.csv.

Användning:
    python3 scripts/parse_hae_zip.py data/HealthAutoExport_20260901114844.zip
"""

import argparse
import csv
import io
import sys
import zipfile
from pathlib import Path

KJ_PER_KCAL = 4.184

# Kolumn i exporten -> (utkolumn, omvandling)
DAILY_MAP = {
    "Stegräkning (count)": ("steg", round),
    "Promenad + Löpsträcka (km)": ("distans_km", lambda v: round(v, 2)),
    "Aktiv energi (kJ)": ("aktiv_energi_kcal", lambda v: round(v / KJ_PER_KCAL)),
    "Apple Träningstid (min)": ("traningstid_min", round),
    "Vilo hjärtfrekvens (count/min)": ("vilopuls", lambda v: round(v, 1)),
    "Hjärtfrekvensvariabilitet (ms)": ("hrv_ms", lambda v: round(v, 1)),
    "Puls [Gen] (count/min)": ("puls_medel", lambda v: round(v, 1)),
    "Löphastighet (km/hr)": ("lophastighet_kmh", lambda v: round(v, 2)),
    "Blodets Syremättnad (%)": ("syremattnad_pct", lambda v: round(v, 1)),
    "Sömnanalyser [Sova] (hr)": ("somn_timmar", lambda v: round(v, 2)),
    "Sömnanalyser [Djup] (hr)": ("djupsomn_timmar", lambda v: round(v, 2)),
    "Trappor Bestigna (count)": ("trappor", round),
    "Tid i dagsljus (min)": ("dagsljus_min", round),
    "Vikt (kg)": ("vikt_kg", lambda v: round(v, 1)),
}

WORKOUT_MAP = {
    "Aktiv energi (kJ)": ("energi_kcal", lambda v: round(v / KJ_PER_KCAL)),
    "Genom. Hjärtfrekvens (count/min)": ("puls_medel", lambda v: round(v)),
    "Max. Hjärtfrekvens (count/min)": ("puls_max", lambda v: round(v)),
    "Avstånd (km)": ("distans_km", lambda v: round(v, 2)),
    "Genomsnittlig hastighet (km/hr)": ("hastighet_kmh", lambda v: round(v, 2)),
    "Stegräkning": ("steg", round),
}


def find_member(zf, prefix):
    for name in zf.namelist():
        if Path(name).name.startswith(prefix) and name.endswith(".csv"):
            return name
    sys.exit(f"Hittade ingen {prefix}*.csv i zippen")


def read_rows(zf, member):
    with zf.open(member) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        return list(csv.DictReader(text))


def convert(row, mapping):
    out = {}
    for source, (target, fn) in mapping.items():
        raw = (row.get(source) or "").strip()
        if raw:
            try:
                out[target] = fn(float(raw))
            except ValueError:
                pass
    return out


def duration_to_min(text):
    try:
        h, m, s = (int(p) for p in text.split(":"))
        return round(h * 60 + m + s / 60, 1)
    except (ValueError, AttributeError):
        return ""


def tempo_min_per_km(speed_kmh):
    if not speed_kmh:
        return ""
    minutes = 60 / speed_kmh
    return f"{int(minutes)}:{round((minutes % 1) * 60):02d}"


def main():
    parser = argparse.ArgumentParser(description="Health Auto Export-zip → CSV")
    parser.add_argument("zip", type=Path, help="HealthAutoExport_*.zip")
    parser.add_argument("--out", type=Path, default=Path("data/processed"))
    args = parser.parse_args()

    with zipfile.ZipFile(args.zip) as zf:
        daily_rows = read_rows(zf, find_member(zf, "HealthAutoExport-"))
        workout_rows = read_rows(zf, find_member(zf, "Workouts-"))

    daily = []
    for row in daily_rows:
        out = {"datum": (row.get("Datum/Tid") or row.get("Date/Time", ""))[:10]}
        out.update(convert(row, DAILY_MAP))
        if len(out) > 1:
            daily.append(out)
    daily.sort(key=lambda r: r["datum"])

    workouts = []
    for row in workout_rows:
        start = row.get("Start", "")
        out = {
            "datum": start[:10],
            "starttid": start[11:16],
            "typ": row.get("Workout Type", ""),
            "varaktighet_min": duration_to_min(row.get("Duration", "")),
        }
        out.update(convert(row, WORKOUT_MAP))
        out["tempo_min_per_km"] = tempo_min_per_km(out.get("hastighet_kmh"))
        workouts.append(out)
    workouts.sort(key=lambda r: (r["datum"], r["starttid"]))

    daily_columns = ["datum"] + [t for t, _ in DAILY_MAP.values()]
    workout_columns = ["datum", "starttid", "typ", "varaktighet_min"] + [
        t for t, _ in WORKOUT_MAP.values()
    ] + ["tempo_min_per_km"]

    args.out.mkdir(parents=True, exist_ok=True)
    for name, columns, rows in [
        ("hae_manuell_daglig.csv", daily_columns, daily),
        ("hae_traningspass.csv", workout_columns, workouts),
    ]:
        with open(args.out / name, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=columns, restval="")
            writer.writeheader()
            writer.writerows(rows)
        print(f"Skrev {args.out / name}: {len(rows)} rader")


if __name__ == "__main__":
    main()
