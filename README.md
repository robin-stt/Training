# Hälsa & Träning

Ett ställe för att samla, följa upp och analysera hälsodata och träningsinfo — med stöd för data från Apple Hälsa.

## Kan Claude kopplas direkt till Apple Hälsa?

Nej, inte live. Apple erbjuder inget moln-API för HealthKit — hälsodatan ligger krypterad på din iPhone/Apple Watch och kan bara läsas av appar på själva enheten. Men det finns tre bra vägar att få in datan hit, från enklast till mest automatisk:

### Alternativ A — Manuell export (enklast, inga extra appar)

1. Öppna **Hälsa**-appen på iPhone.
2. Tryck på din profilbild uppe till höger.
3. Skrolla ner och välj **Exportera alla hälsodata**.
4. Du får en `export.zip` — spara den (t.ex. till iCloud Drive) och lägg den i mappen `data/` här i repot, eller ladda upp den direkt i en Claude-session.
5. Kör parsern (se nedan) eller be Claude analysera filen.

Exporten innehåller *allt* (steg, puls, sömn, träningspass, vikt m.m.) sedan du började använda telefonen. Filen kan bli stor — parsern hanterar det.

### Alternativ B — Automatisk export med appen "Health Auto Export"

Appen [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069) (App Store) kan på schema (dagligen/veckovis) skicka valda mätvärden som JSON/CSV till:

- en mapp i iCloud Drive eller Dropbox, eller
- ett REST-API — t.ex. direkt till detta GitHub-repo via GitHub:s API.

Då finns färsk data alltid här, och Claude kan analysera den när du frågar.

### Alternativ C — Apple Genvägar (gratis, halvautomatiskt)

Appen **Genvägar** (Shortcuts) kan läsa hälsoprover ("Hitta hälsoprover") och skicka dem vidare. En automation som varje kväll POST:ar dagens nyckeltal (steg, träning, sömn) till GitHub:s API skriver in datan i `data/` utan extra appar. Be Claude bygga genvägen åt dig om du vill gå den vägen.

## Struktur

```
data/                    Rålägg export.zip / export.xml här (versioneras inte)
data/processed/          CSV-filer som parsern genererar
data/traningslogg.csv    Manuell träningslogg (fyll i själv eller be Claude)
scripts/parse_apple_health.py   Parser: export.xml → CSV + sammanfattning
```

## Använda parsern

```bash
python3 scripts/parse_apple_health.py data/export.zip
```

Den tar `.zip` (direkt från Hälsa-appen) eller en uppackad `export.xml` och skapar:

- `data/processed/daglig.csv` — per dag: steg, distans, aktiv energi, vilopuls, HRV, vikt, sömntimmar
- `data/processed/traningspass.csv` — alla träningspass: typ, längd, distans, kalorier

…samt skriver ut en sammanfattning (period, totaler, snitt senaste 4 veckorna).

Dubbelräkning från flera källor (iPhone + Apple Watch räknar samma steg) hanteras genom att bästa källan per dag används.

## Manuell träningslogg

`data/traningslogg.csv` är för sådant som inte fångas av klockan — styrkepass, upplevd ansträngning, kommentarer:

```csv
datum,typ,varaktighet_min,distans_km,anstrangning_1_10,kommentar
2026-09-01,Styrka,45,,7,Bänkpress 3x5 80 kg
```

Du kan också bara skriva till Claude ("logga dagens pass: 8 km löpning, 42 min, kändes tungt") så förs det in.

## Nästa steg

När första exporten ligger i `data/` kan Claude bygga en riktig dashboard (grafer över trender, veckosummeringar, mål) utifrån din faktiska data.
