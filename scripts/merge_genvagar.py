#!/usr/bin/env python3
"""Slår ihop de dagliga JSON-filerna från Genvägar-automationen till en CSV.

Genvägen (se docs/genvag-guide.md) sparar en fil per dag i data/genvagar/.
Det här skriptet läser alla, sorterar på datum och skriver
data/processed/genvagar_daglig.csv.

Användning:
    python3 scripts/merge_genvagar.py
    python3 scripts/merge_genvagar.py --in data/genvagar --out data/processed
"""

import argparse
import csv
import json
import sys
from pathlib import Path

COLUMNS = ["datum", "steg", "aktiv_energi_kcal", "distans_km", "vilopuls", "somn"]


def main():
    parser = argparse.ArgumentParser(description="Genvägar-JSON → CSV")
    parser.add_argument("--in", dest="indir", type=Path, default=Path("data/genvagar"))
    parser.add_argument("--out", type=Path, default=Path("data/processed"))
    args = parser.parse_args()

    files = sorted(args.indir.glob("*.json"))
    if not files:
        sys.exit(f"Inga JSON-filer i {args.indir} — har genvägen körts än?")

    rows = []
    extra_keys = []
    for path in files:
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            print(f"Hoppar över {path.name}: kunde inte läsas ({err})", file=sys.stderr)
            continue
        if not isinstance(data, dict):
            print(f"Hoppar över {path.name}: inte ett JSON-objekt", file=sys.stderr)
            continue
        # Filnamnet (ÅÅÅÅ-MM-DD.json) gäller om datumfältet saknas.
        data.setdefault("datum", path.stem)
        for key in data:
            if key not in COLUMNS and key not in extra_keys:
                extra_keys.append(key)
        rows.append(data)

    if not rows:
        sys.exit("Inga läsbara filer hittades.")

    rows.sort(key=lambda r: str(r["datum"]))
    columns = COLUMNS + extra_keys

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / "genvagar_daglig.csv"
    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns, restval="")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Skrev {out_path}: {len(rows)} dagar ({rows[0]['datum']} – {rows[-1]['datum']})")


if __name__ == "__main__":
    main()
