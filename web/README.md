# Dagsformen — webbapp med konton

Samma app som artifact-versionen, men som en egen webbplats: besökarna får en
inloggningskod och coachen drivs av **din** Anthropic-nyckel i stället för deras
egen.

```
Webbläsare  ──►  Cloudflare Worker  ──►  Anthropic API (din nyckel)
 hälsodata        konton, kvoter,          coachens svar
 i localStorage   kostnadstak
```

Hälsodatan lämnar aldrig besökarens webbläsare. Servern ser bara den
sammanfattning av nyckeltal som skickas med när någon frågar coachen, och den
sparas inte.

## Inloggning utan lösenord

Första gången trycker besökaren på **Skapa min kod** och får en slumpad kod i
stilen `ABCD-EFGH-JKMN-PQRS`. Den koden är hela inloggningen — ingen e-post,
inget lösenord. Nästa gång skriver de in samma kod.

Koden har 80 bitars entropi och går inte att gissa. Servern lagrar bara
SHA-256 av den, vilket är ett enda snabbt hashsteg — därför ryms appen på
Cloudflares **gratisnivå**.

Priset är att koden inte kan återställas: tappar besökaren bort den kommer de
inte in i sitt konto igen och får skapa ett nytt. Appen säger det tydligt när
koden visas. Hälsodatan ligger ändå kvar i webbläsaren, så det som går
förlorat är kontot och månadens kvot — inte datan.

## Vad som krävs

- Ett Cloudflare-konto. **Gratisnivån räcker** (100 000 anrop/dygn).
- En Anthropic API-nyckel från <https://console.anthropic.com>.
- Node 18+ lokalt.

## Publicera

### Automatiskt (ett kommando)

Sätt tre miljövariabler och kör skriptet — det skapar databasen, lägger upp
tabellerna, lägger in API-nyckeln som hemlighet och publicerar:

```bash
cd web
./deploy.sh
```

| Variabel | Var den kommer ifrån |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → Custom token med **Account: Workers Scripts: Edit** och **Account: D1: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Står till höger på Cloudflares Workers-översikt |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> |

Skriptet går att köra om: databasen skapas bara om den saknas, och tabellerna
använder `CREATE TABLE IF NOT EXISTS`.

### Manuellt

```bash
cd web
npm install
npx wrangler login
npx wrangler d1 create dagsformen     # klistra in id:t i wrangler.toml
npm run db:init
npx wrangler secret put ANTHROPIC_API_KEY
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

Lokalt kör appen mot en egen SQLite-fil. Vill du testa coachen på riktigt, lägg
nyckeln i `web/.dev.vars` (den filen är git-ignorerad):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Utan nyckel fungerar allt utom coachens svar.

## Säkerhet

- Inloggningskoder skapas av servern med `crypto.getRandomValues` och lagras
  bara som SHA-256, så en läckt databas innehåller inga användbara koder.
- Bara hashen av sessionstoken lagras, av samma skäl.
- Sessionskakan är `HttpOnly`, `Secure` och `SameSite=Lax`.
- POST-anrop med främmande `Origin` avvisas.
- Ingen personuppgift lagras: appen frågar aldrig efter namn eller e-post.

## Filer

```
src/index.ts    Router, registrering, inloggning, kvotkontroll
src/auth.ts     Inloggningskoder, sessioner, kakor
src/kvot.ts     Kostnadsberäkning och de två taken
src/coach.ts    Prompt till Claude och strömning tillbaka till webbläsaren
deploy.sh       Publicerar allt i ett kommando
public/         Frontend (samma app som artifact-versionen)
schema.sql      Tabeller
```
