#!/usr/bin/env python3
"""Parser för Apple Hälsa-export.

Läser export.zip (direkt från Hälsa-appen) eller en uppackad export.xml och
skriver dagliga nyckeltal samt träningspass som CSV till data/processed/.

Endast standardbiblioteket används; filen läses strömmande (iterparse) så
även fleråriga exporter på hundratals MB fungerar.

Användning:
    python3 scripts/parse_apple_health.py data/export.zip
    python3 scripts/parse_apple_health.py data/export.xml --out data/processed
"""

import argparse
import csv
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree

# Kvantitetstyper som summeras per dag; iPhone och Apple Watch registrerar
# ofta samma aktivitet, så per dag används källan med högst summa i stället
# för att addera källorna (annars dubbelräknas steg m.m.).
SUMMED_TYPES = {
    "HKQuantityTypeIdentifierStepCount": "steg",
    "HKQuantityTypeIdentifierDistanceWalkingRunning": "distans_km",
    "HKQuantityTypeIdentifierActiveEnergyBurned": "aktiv_energi_kcal",
}

# Typer där dagens medelvärde är det intressanta.
AVERAGED_TYPES = {
    "HKQuantityTypeIdentifierRestingHeartRate": "vilopuls",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "hrv_ms",
}

# Typer där senaste mätningen per dag gäller.
LAST_VALUE_TYPES = {
    "HKQuantityTypeIdentifierBodyMass": "vikt_kg",
}

SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis"
ASLEEP_PREFIX = "HKCategoryValueSleepAnalysisAsleep"

DAILY_COLUMNS = [
    "datum",
    "steg",
    "distans_km",
    "aktiv_energi_kcal",
    "vilopuls",
    "hrv_ms",
    "vikt_kg",
    "somn_timmar",
]

WORKOUT_COLUMNS = [
    "datum",
    "starttid",
    "typ",
    "varaktighet_min",
    "distans_km",
    "energi_kcal",
    "kalla",
]


def parse_date(value):
    # Formatet i exporten: "2026-08-31 07:15:00 +0300"
    return datetime.strptime(value, "%Y-%m-%d %H:%M:%S %z")


def clean_workout_type(raw):
    return raw.removeprefix("HKWorkoutActivityType")


def open_export(path):
    """Returnerar ett filobjekt med export.xml, oavsett zip eller xml."""
    if path.suffix.lower() == ".zip":
        zf = zipfile.ZipFile(path)
        for name in zf.namelist():
            if name.endswith("export.xml") and "export_cda" not in name:
                return zf.open(name)
        sys.exit(f"Hittade ingen export.xml i {path}")
    return open(path, "rb")


def parse(source):
    # dag -> källa -> metrik -> summa
    summed = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    # dag -> metrik -> [värden]
    averaged = defaultdict(lambda: defaultdict(list))
    # dag -> metrik -> (tidsstämpel, värde)
    last_value = {}
    # natt (slutdatum) -> källa -> sekunder sömn
    sleep = defaultdict(lambda: defaultdict(float))
    workouts = []

    for _, elem in ElementTree.iterparse(source):
        if elem.tag == "Record":
            rtype = elem.get("type")
            if rtype in SUMMED_TYPES:
                day = elem.get("startDate")[:10]
                value = float(elem.get("value", 0))
                summed[day][elem.get("sourceName", "?")][SUMMED_TYPES[rtype]] += value
            elif rtype in AVERAGED_TYPES:
                day = elem.get("startDate")[:10]
                averaged[day][AVERAGED_TYPES[rtype]].append(float(elem.get("value", 0)))
            elif rtype in LAST_VALUE_TYPES:
                day = elem.get("startDate")[:10]
                key = (day, LAST_VALUE_TYPES[rtype])
                stamp = elem.get("startDate")
                if key not in last_value or stamp > last_value[key][0]:
                    last_value[key] = (stamp, float(elem.get("value", 0)))
            elif rtype == SLEEP_TYPE and elem.get("value", "").startswith(ASLEEP_PREFIX):
                start = parse_date(elem.get("startDate"))
                end = parse_date(elem.get("endDate"))
                night = end.date().isoformat()
                sleep[night][elem.get("sourceName", "?")] += (end - start).total_seconds()
            elem.clear()
        elif elem.tag == "Workout":
            start = elem.get("startDate")
            distance = elem.get("totalDistance")
            energy = elem.get("totalEnergyBurned")
            # Nyare exporter lägger distans/energi i WorkoutStatistics-barn.
            for stat in elem.findall("WorkoutStatistics"):
                stype = stat.get("type", "")
                if distance is None and "Distance" in stype:
                    distance = stat.get("sum")
                if energy is None and stype.endswith("ActiveEnergyBurned"):
                    energy = stat.get("sum")
            workouts.append(
                {
                    "datum": start[:10],
                    "starttid": start[11:16],
                    "typ": clean_workout_type(elem.get("workoutActivityType", "")),
                    "varaktighet_min": round(float(elem.get("duration", 0)), 1),
                    "distans_km": round(float(distance), 2) if distance else "",
                    "energi_kcal": round(float(energy)) if energy else "",
                    "kalla": elem.get("sourceName", ""),
                }
            )
            elem.clear()

    daily = {}
    days = set(summed) | set(averaged) | {d for d, _ in last_value} | set(sleep)
    for day in days:
        row = {"datum": day}
        per_source = summed.get(day, {})
        for metric in SUMMED_TYPES.values():
            best = max((src[metric] for src in per_source.values()), default=0)
            if best:
                row[metric] = round(best, 2)
        for metric, values in averaged.get(day, {}).items():
            row[metric] = round(sum(values) / len(values), 1)
        for metric in LAST_VALUE_TYPES.values():
            if (day, metric) in last_value:
                row[metric] = round(last_value[(day, metric)][1], 1)
        if day in sleep:
            best = max(sleep[day].values())
            row["somn_timmar"] = round(best / 3600, 2)
        daily[day] = row

    return daily, workouts


def write_csv(path, columns, rows):
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def summarize(daily, workouts):
    if not daily:
        print("Ingen daglig data hittades i exporten.")
        return
    days = sorted(daily)
    print(f"Period: {days[0]} – {days[-1]} ({len(days)} dagar med data)")
    print(f"Träningspass totalt: {len(workouts)}")

    cutoff = (datetime.strptime(days[-1], "%Y-%m-%d") - timedelta(days=28)).date().isoformat()
    recent = [daily[d] for d in days if d >= cutoff]

    def mean(metric):
        values = [r[metric] for r in recent if r.get(metric)]
        return sum(values) / len(values) if values else None

    print(f"\nSnitt senaste 4 veckorna ({len(recent)} dagar):")
    for metric, label, fmt in [
        ("steg", "Steg/dag", "{:.0f}"),
        ("distans_km", "Distans/dag", "{:.1f} km"),
        ("aktiv_energi_kcal", "Aktiv energi/dag", "{:.0f} kcal"),
        ("somn_timmar", "Sömn/natt", "{:.1f} h"),
        ("vilopuls", "Vilopuls", "{:.0f} slag/min"),
        ("hrv_ms", "HRV", "{:.0f} ms"),
        ("vikt_kg", "Vikt", "{:.1f} kg"),
    ]:
        value = mean(metric)
        if value is not None:
            print(f"  {label}: " + fmt.format(value))

    recent_workouts = [w for w in workouts if w["datum"] >= cutoff]
    if recent_workouts:
        print(f"\nTräningspass senaste 4 veckorna: {len(recent_workouts)}")
        per_type = defaultdict(int)
        for w in recent_workouts:
            per_type[w["typ"]] += 1
        for wtype, count in sorted(per_type.items(), key=lambda kv: -kv[1]):
            print(f"  {wtype}: {count} pass")


def main():
    parser = argparse.ArgumentParser(description="Apple Hälsa-export → CSV")
    parser.add_argument("export", type=Path, help="export.zip eller export.xml")
    parser.add_argument("--out", type=Path, default=Path("data/processed"))
    args = parser.parse_args()

    if not args.export.exists():
        sys.exit(f"Filen finns inte: {args.export}")

    with open_export(args.export) as source:
        daily, workouts = parse(source)

    args.out.mkdir(parents=True, exist_ok=True)
    daily_rows = [daily[d] for d in sorted(daily)]
    workouts.sort(key=lambda w: (w["datum"], w["starttid"]))
    write_csv(args.out / "daglig.csv", DAILY_COLUMNS, daily_rows)
    write_csv(args.out / "traningspass.csv", WORKOUT_COLUMNS, workouts)
    print(f"Skrev {args.out / 'daglig.csv'} och {args.out / 'traningspass.csv'}\n")

    summarize(daily, workouts)


if __name__ == "__main__":
    main()
