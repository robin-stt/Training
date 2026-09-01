# Guide: Health Auto Export → GitHub-repot

[Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1115567069) kan skicka hälsodata på schema till ett REST-API — men den kan **inte** prata direkt med GitHub. Appen skickar sin data som ett vanligt POST-anrop med sitt eget JSON-format, medan GitHub:s API kräver ett PUT-anrop där innehållet är base64-kodat och inpackat i ett särskilt kuvert. Därför behövs en liten gratis mellanhand: en **Cloudflare Worker** som tar emot appens anrop och skriver in datan i repot.

```
iPhone (Health Auto Export)  →  Cloudflare Worker  →  data/health-auto-export/*.json i repot
        POST, appens JSON          översätter till          en fil per export
                                   GitHub:s API-format
```

Worker-koden är färdigskriven i [`integrations/cloudflare-worker/worker.js`](../integrations/cloudflare-worker/worker.js). Setup tar ca 15 minuter, och Cloudflares gratisnivå (100 000 anrop/dag) räcker tusenfalt.

## Steg 1 — GitHub-token

Samma sorts token som i [Genvägar-guiden, steg 1](genvag-guide.md#steg-1--skapa-en-github-token): en fine-grained PAT med åtkomst till **enbart** `robin-stt/Training` och **enbart** *Contents: Read and write*. Har du redan skapat en för Genvägar kan samma token återanvändas.

## Steg 2 — Skapa Cloudflare-workern

1. Skapa ett gratis konto på <https://dash.cloudflare.com/sign-up> (om du inte har ett).
2. I dashboarden: **Workers & Pages** → **Create** → **Create Worker** (börja från "Hello World").
3. Ge den ett namn, t.ex. `halsodata` → **Deploy**.
4. Klicka **Edit code**, radera exempelkoden och klistra in hela innehållet i `integrations/cloudflare-worker/worker.js` → **Deploy**.
5. Gå till workerns **Settings → Variables and Secrets** och lägg till:

   | Namn | Typ | Värde |
   |---|---|---|
   | `GITHUB_TOKEN` | **Secret** | Token från steg 1 |
   | `API_KEY` | **Secret** | En egen lång slumpsträng, t.ex. 30+ tecken. Hitta på en eller kör `openssl rand -hex 24` |
   | `GITHUB_REPO` | Text | `robin-stt/Training` |

   (`GITHUB_BRANCH` kan utelämnas — då används repots standardgren.)

6. **Din URL** står på workerns översiktssida och ser ut så här:

   ```
   https://halsodata.<ditt-konto>.workers.dev
   ```

   Det är den URL:en du anger i appen.

## Steg 3 — Konfigurera Health Auto Export

I appen: **Automations** → **+** → **REST API**:

- **URL:** workerns URL från steg 2.6
- **Headers:** lägg till en header: nyckel `x-api-key`, värde = samma slumpsträng som `API_KEY` i steg 2.5
- **Data Type:** de mätvärden du vill följa (steg, aktiv energi, distans, vilopuls, HRV, sömn, vikt …)
- **Format:** `JSON`
- **Aggregate Data:** på, intervall **Days** (en datapunkt per dag)
- **Automation/Schedule:** t.ex. dagligen på kvällen
- **Export Period:** *Today* (eller *Previous Day* om exporten går tidigt på morgonen)

## Steg 4 — Testa

1. Kör automationen manuellt i appen (**Update/Export now**).
2. Appen ska visa lyckat svar; workern svarar `Sparade data/health-auto-export/...`.
3. Kontrollera att filen dykt upp i repot under `data/health-auto-export/`.

Felsökning: svar `401` = fel `x-api-key`; svar `502` med GitHub-felmeddelande = oftast fel token eller fel `GITHUB_REPO`. Workerns loggar finns under **Observability → Logs** i Cloudflare-dashboarden.

## Steg 5 — Analysera

Slå ihop alla exporter till en daglig CSV:

```bash
python3 scripts/merge_hae.py
```

Resultatet hamnar i `data/processed/hae_daglig.csv` (överlappande exporter hanteras — senaste värdet per dag gäller). Eller be Claude analysera trenderna direkt.

## Bra att veta

- **Säkerhet:** workern tar bara emot anrop med rätt `x-api-key`, och GitHub-token ligger som hemlighet hos Cloudflare — den finns aldrig i telefonen eller i repot. Klistra aldrig in token eller API-nyckeln i en chatt.
- **Filerna växer i antal.** Varje export blir en egen tidsstämplad fil. Det är avsiktligt (inga skrivkonflikter) — be Claude städa ihop gamla filer om mappen blir stökig.
- **Historik:** appen exporterar bara det valda tidsfönstret. För hela historiken bakåt i tiden, gör den manuella exporten från Hälsa-appen en gång (README, alternativ A).
