# Dagsformen — webbapp med konton

Samma app som artifact-versionen, men som en egen webbplats: besökarna skapar
konto och coachen drivs av **din** Anthropic-nyckel i stället för deras egen.

```
Webbläsare  ──►  Cloudflare Worker  ──►  Anthropic API (din nyckel)
 hälsodata        konton, kvoter,          coachens svar
 i localStorage   kostnadstak
```

Hälsodatan lämnar aldrig besökarens webbläsare. Servern ser bara den
sammanfattning av nyckeltal som skickas med när någon frågar coachen, och den
sparas inte.

## Vad som krävs

- Ett Cloudflare-konto med **Workers Paid** (5 USD/mån). Gratisnivån ger bara
  10 ms CPU per anrop, vilket inte räcker för säker lösenordshashning.
- En Anthropic API-nyckel från <https://console.anthropic.com>.
- Node 18+ lokalt.

## Kom igång

```bash
cd web
npm install
npx wrangler login
```

**1. Skapa databasen** och klistra in id:t som skrivs ut i `wrangler.toml`
(raden `database_id = "FYLL_I_HAR"`):

```bash
npx wrangler d1 create dagsformen
```

**2. Lägg upp tabellerna:**

```bash
npm run db:init
```

**3. Lägg in API-nyckeln** som hemlighet (hamnar aldrig i koden eller i git):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

**4. Publicera:**

```bash
npm run deploy
```

Wrangler skriver ut adressen, i stilen `https://dagsformen.<ditt-konto>.workers.dev`.

## Kostnadsspärrar

Två tak, båda i `wrangler.toml` under `[vars]`:

| Variabel | Standard | Betyder |
|---|---|---|
| `MANADSTAK_USD` | `19` (≈ 200 kr) | När månadens uppskattade kostnad passerar taket pausas coachen till den 1:a. Resten av appen fungerar. |
| `SVAR_PER_ANVANDARE` | `15` | Hur många coach-svar varje konto får per månad. |

Ett coach-svar kostar ungefär 0,25–0,35 kr, så 19 USD räcker till i runda tal
600 svar i månaden. Kostnaden bokförs per svar utifrån den faktiska
tokenförbrukningen, och ett svar som misslyckas dras inte från kvoten.

Ändra taken och kör `npm run deploy` igen. Så här ser du förbrukningen:

```bash
npx wrangler d1 execute dagsformen --remote \
  --command "SELECT * FROM total_anvandning ORDER BY manad DESC LIMIT 3"
```

## Utveckla lokalt

```bash
npm run db:init-local
npm run dev
```

Lokalt kör appen mot en egen SQLite-fil. Sätt `ANTHROPIC_API_KEY` i miljön om du
vill testa coachen på riktigt — utan nyckel svarar allt utom coachen som vanligt.

## Säkerhet

- Lösenord hashas med PBKDF2-SHA256 (210 000 varv, slumpat salt per konto).
- Bara hashen av sessionstoken lagras, så en läckt databas ger inte inloggning.
- Sessionskakan är `HttpOnly`, `Secure` och `SameSite=Lax`.
- POST-anrop med främmande `Origin` avvisas.
- Inloggning svarar likadant oavsett om kontot saknas eller lösenordet är fel.

## Filer

```
src/index.ts    Router, registrering, inloggning, kvotkontroll
src/auth.ts     Lösenordshashning, sessioner, kakor
src/kvot.ts     Kostnadsberäkning och de två taken
src/coach.ts    Prompt till Claude och strömning tillbaka till webbläsaren
public/         Frontend (samma app som artifact-versionen)
schema.sql      Tabeller
```
