# Läsa loggen

Loggen svarar på två frågor: **har någon kommit in i systemet**, och **uppstod
det fel**. Den innehåller aldrig hälsodata och aldrig någons inloggningskod —
bara händelsetyp, en kort beskrivning och tidpunkt.

Öppna Cloudflare → **Storage & Databases** → **D1 SQL Database** → `dagsformen`
→ fliken **Console**, och klistra in någon av frågorna nedan.

## Vad hände senast?

```sql
SELECT tid, typ, detalj FROM handelser ORDER BY id DESC LIMIT 40;
```

## Bara fel

```sql
SELECT tid, typ, detalj FROM handelser
WHERE typ LIKE '%fel%'
ORDER BY id DESC LIMIT 40;
```

## Hur många har kommit in?

```sql
SELECT
  (SELECT COUNT(*) FROM anvandare) AS konton,
  (SELECT COUNT(*) FROM handelser WHERE typ = 'inloggning') AS inloggningar,
  (SELECT COUNT(*) FROM handelser WHERE typ = 'import_klar') AS lyckade_importer,
  (SELECT COUNT(*) FROM handelser WHERE typ = 'import_fel') AS misslyckade_importer;
```

## Fastnar folk i importen?

Jämför hur många som börjar med hur många som lyckas — stor skillnad betyder att
något är fel med importen.

```sql
SELECT typ, COUNT(*) AS antal FROM handelser
WHERE typ IN ('import_start', 'import_klar', 'import_fel')
GROUP BY typ;
```

## Händelsetyper

| Typ | Betyder |
|---|---|
| `konto_skapat` | Någon skapade ett konto |
| `inloggning` | Någon loggade in med sin kod |
| `import_start` | En fil började läsas in (med filstorlek) |
| `import_klar` | Importen lyckades (antal dagar och pass) |
| `import_fel` | Importen misslyckades — texten säger varför |
| `coach_svar` | Coachen svarade (antal tokens ut) |
| `coach_fel` | Coachen misslyckades — texten säger varför |
| `js_fel` | Ett oväntat fel i besökarens webbläsare |

## Rensa gammalt

Loggen växer långsamt, men behöver den städas:

```sql
DELETE FROM handelser WHERE tid < date('now', '-90 days');
```

## Live medan något händer

Workerns egna fel syns direkt under **Workers & Pages** → `dagsformen` →
**Logs**. Där hamnar sådant som inte hinner skrivas till databasen.
