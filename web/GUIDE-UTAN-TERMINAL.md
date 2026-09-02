# Publicera Dagsformen — helt i webbläsaren

Den här guiden kräver ingen Terminal och inga kommandon. Du behöver två flikar:
Cloudflares kontrollpanel och GitHub.

Räkna med ungefär 15 minuter.

---

## Steg 1 — Skapa databasen

1. Logga in på <https://dash.cloudflare.com>.
2. I menyn till vänster: **Storage & Databases** → **D1 SQL Database**.
3. Klicka **Create Database**.
4. Namn: `dagsformen` (exakt så, gemener).
5. Klicka **Create**.

När databasen är skapad visas en ruta med **Database ID** — en lång rad
bokstäver och siffror. **Kopiera den och spara den någonstans**, du behöver den
i steg 3.

---

## Steg 2 — Skapa tabellerna

Du är kvar på databasens sida.

1. Klicka fliken **Console**.
2. Klistra in hela texten nedan i rutan.
3. Klicka **Execute**.

```sql
CREATE TABLE IF NOT EXISTS anvandare (
  id TEXT PRIMARY KEY,
  kod_hash TEXT NOT NULL UNIQUE,
  skapad TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessioner (
  token_hash TEXT PRIMARY KEY,
  anvandare_id TEXT NOT NULL,
  gar_ut TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessioner_anvandare ON sessioner (anvandare_id);
CREATE INDEX IF NOT EXISTS idx_sessioner_gar_ut ON sessioner (gar_ut);
CREATE TABLE IF NOT EXISTS anvandning (
  anvandare_id TEXT NOT NULL,
  manad TEXT NOT NULL,
  svar INTEGER NOT NULL DEFAULT 0,
  kostnad_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (anvandare_id, manad)
);
CREATE TABLE IF NOT EXISTS total_anvandning (
  manad TEXT PRIMARY KEY,
  svar INTEGER NOT NULL DEFAULT 0,
  kostnad_usd REAL NOT NULL DEFAULT 0
);
```

Klicka på fliken **Tables** — nu ska fyra tabeller finnas: `anvandare`,
`sessioner`, `anvandning` och `total_anvandning`.

---

## Steg 3 — Skriv in databasens id i inställningsfilen

Det här görs på GitHub, direkt i webbläsaren.

1. Gå till filen:
   <https://github.com/robin-stt/Training/blob/claude/health-fitness-tracking-ub3wug/web/wrangler.toml>
2. Klicka på **pennan** uppe till höger (Edit this file).
3. Leta upp raden `database_id = "FYLL_I_HAR"`.
4. Byt ut `FYLL_I_HAR` mot id:t du kopierade i steg 1. **Behåll citattecknen.**
   Raden ska se ut ungefär så här:
   ```
   database_id = "a1b2c3d4-5e6f-7890-abcd-ef1234567890"
   ```
5. Klicka **Commit changes** → **Commit changes** igen.

---

## Steg 4 — Skapa Workern och koppla den till GitHub

1. I Cloudflare: **Workers & Pages** → **Create**.
2. Välj att skapa en Worker (Hello World-mallen duger, koden byts ut direkt).
3. Namn: `dagsformen` — **exakt så**. Namnet måste stämma med inställningsfilen,
   annars misslyckas publiceringen.
4. Klicka **Deploy**. Nu finns en tom Worker; nästa steg fyller den med appen.
5. Gå till **Settings** → **Builds** → **Connect**.
6. Godkänn åtkomst till ditt GitHub-konto och välj repot **robin-stt/Training**.
7. Fyll i byggkonfigurationen:

   | Fält | Värde |
   |---|---|
   | Git branch | `claude/health-fitness-tracking-ub3wug` |
   | Build command | *(lämna tom)* |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `web` |

8. Spara. Cloudflare hämtar koden och publicerar den. Det tar någon minut.

Under **Builds** ser du hur det går. Blir det grönt är appen uppe — adressen
står överst på Workerns sida, i stilen `https://dagsformen.<ditt-konto>.workers.dev`.

---

## Steg 5 — Lägg in API-nyckeln

Appen fungerar nu, men coachen svarar inte förrän nyckeln är på plats.

1. På Workerns sida: **Settings** → **Variables and Secrets**.
2. Klicka **Add**.
3. Type: **Secret** (viktigt — inte "Text", då syns nyckeln i klartext).
4. Variable name: `ANTHROPIC_API_KEY`
5. Value: klistra in din nyckel från <https://console.anthropic.com>.
6. Klicka **Deploy** / **Save**.

Klart. Öppna adressen, släpp in din exportfil, tryck **Skapa min kod**, spara
koden och be om dina tips.

---

## Om något går fel

**Bygget blir rött i steg 4.** Klicka på bygget och läs sista raderna.
- Står det något om `database_id` blev steg 3 fel — kontrollera att hela
  `FYLL_I_HAR` byttes ut och att citattecknen står kvar.
- Står det att Workern inte hittas stämmer inte namnet. Det måste vara
  `dagsformen`.

**Coachen svarar "Något gick fel".** Nyckeln saknas eller är felaktig — gör om
steg 5. Kontrollera att Type var **Secret**.

**Ändra kostnadstaken.** De ligger i samma fil som i steg 3, längst ner:
`MANADSTAK_USD` (standard 19, ungefär 200 kr) och `SVAR_PER_ANVANDARE`
(standard 15). Ändra och committa — bygget kör om automatiskt.

**Se hur mycket coachen kostat.** Cloudflare → D1 → `dagsformen` → **Console**:

```sql
SELECT * FROM total_anvandning ORDER BY manad DESC LIMIT 3;
```
