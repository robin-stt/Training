/** Dagsformen — Cloudflare Worker: konton, kvoter och coachen. */
import {
  type Env, type Anvandare,
  MIN_LANGD, foreslaKod, normaliseraKod, forSvagKod, sha256Hex,
  kollaForsok, raknaFelforsok, nollstallForsok,
  skapaSession, slutaSession, inloggad,
  kakaFran, sessionsKaka, raderadKaka, hamtaNyckel, logga,
} from "./auth";
import { kollaKvot, reserveraSvar, angraReservation } from "./kvot";
import { giltigBegaran, stromaCoach } from "./coach";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

async function laesJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!/application\/json/i.test(request.headers.get("Content-Type") || "")) return null;
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Skydd mot att någon annans sida postar i en inloggad användares namn. */
function sammaUrsprung(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // samma ursprung skickar ingen Origin på navigeringar
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

const KOD_KRAV = `Koden måste vara minst ${MIN_LANGD} tecken och får inte vara lätt att gissa.`;

/** Skapar ett konto med den kod användaren själv valt. */
async function registrera(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await kollaForsok(env, request))) {
    return json({ fel: "För många försök. Vänta en kvart och prova igen." }, 429);
  }
  const b = await laesJson(request);
  const kod = b ? normaliseraKod(b.kod) : null;
  if (!kod || forSvagKod(kod)) {
    await raknaFelforsok(env, request);
    return json({ fel: KOD_KRAV }, 400);
  }
  const kodHash = await sha256Hex(kod);
  const upptagen = await env.DB.prepare("SELECT id FROM anvandare WHERE kod_hash = ?")
    .bind(kodHash).first();
  if (upptagen) {
    // Räknas som felförsök: annars blir registreringen ett sätt att leta
    // efter koder som redan finns.
    await raknaFelforsok(env, request);
    return json({ fel: "Den koden är upptagen. Välj en annan." }, 409);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO anvandare (id, kod_hash, skapad) VALUES (?, ?, ?)")
    .bind(id, kodHash, new Date().toISOString())
    .run();
  await nollstallForsok(env, request);
  ctx.waitUntil(logga(env, "konto_skapat", null, id));
  const token = await skapaSession(env, id);
  return json({ ok: true }, 200, { "Set-Cookie": sessionsKaka(token) });
}

async function loggaIn(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(await kollaForsok(env, request))) {
    return json({ fel: "För många försök. Vänta en kvart och prova igen." }, 429);
  }
  const b = await laesJson(request);
  const kod = b ? normaliseraKod(b.kod) : null;
  if (!kod) {
    await raknaFelforsok(env, request);
    return json({ fel: KOD_KRAV }, 400);
  }
  const rad = await env.DB.prepare("SELECT id FROM anvandare WHERE kod_hash = ?")
    .bind(await sha256Hex(kod)).first<{ id: string }>();
  if (!rad) {
    await raknaFelforsok(env, request);
    return json({ fel: "Ingen hittades med den koden." }, 401);
  }
  await nollstallForsok(env, request);
  ctx.waitUntil(logga(env, "inloggning", null, rad.id));
  const token = await skapaSession(env, rad.id);
  return json({ ok: true }, 200, { "Set-Cookie": sessionsKaka(token) });
}

async function migStatus(anv: Anvandare, env: Env): Promise<Response> {
  const kvot = await kollaKvot(env, anv.id);
  return json({
    inloggad: true,
    svarKvar: kvot.kvarForAnvandaren,
    coachPausad: kvot.skal === "manadstak",
  });
}

async function coach(request: Request, env: Env, anv: Anvandare, ctx: ExecutionContext): Promise<Response> {
  const kvot = await kollaKvot(env, anv.id);
  if (!kvot.tillaten) {
    return json({
      fel: kvot.skal === "manadstak"
        ? "Coachen är pausad resten av månaden eftersom appens kostnadstak är nått. Allt annat fungerar."
        : "Du har använt månadens coach-svar. Kvoten återställs den 1:a.",
      skal: kvot.skal,
    }, 429);
  }
  const b = await laesJson(request);
  if (!giltigBegaran(b)) return json({ fel: "Ogiltig begäran." }, 400);

  // Allt som kan avgöras utan att fråga Claude måste avgöras före
  // reservationen, annars kostar ett rent konfigurationsfel adepten
  // ett av månadens svar.
  const nyckel = await hamtaNyckel(env);
  if (!nyckel) {
    return json({
      fel: "Coachen är inte konfigurerad ännu: API-nyckeln saknas i Cloudflare.",
    }, 503);
  }

  await reserveraSvar(env, anv.id);
  try {
    return await stromaCoach(env, anv.id, b, ctx, nyckel);
  } catch (fel) {
    ctx.waitUntil(angraReservation(env, anv.id));
    return json({ fel: "Coachen kunde inte nås just nu. Prova igen." }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (request.method === "POST" && !sammaUrsprung(request)) {
      return json({ fel: "Ogiltigt ursprung." }, 403);
    }

    // Förslag till den som inte vill hitta på en kod själv.
    if (url.pathname === "/api/foresla-kod" && request.method === "GET") {
      return json({ kod: foreslaKod() });
    }
    if (url.pathname === "/api/registrera" && request.method === "POST") return registrera(request, env, ctx);
    if (url.pathname === "/api/logga-in" && request.method === "POST") return loggaIn(request, env, ctx);

    if (url.pathname === "/api/logga-ut" && request.method === "POST") {
      const token = kakaFran(request, "sess");
      if (token) await slutaSession(env, token);
      return json({ ok: true }, 200, { "Set-Cookie": raderadKaka });
    }

    const anv = await inloggad(request, env);
    if (url.pathname === "/api/mig" && request.method === "GET") {
      return anv ? migStatus(anv, env) : json({ inloggad: false });
    }
    // Tar emot händelser från webbläsaren. Kräver ingen inloggning, eftersom
    // importfel oftast inträffar innan någon skapat konto.
    if (url.pathname === "/api/handelse" && request.method === "POST") {
      const b = await laesJson(request);
      const typ = b && typeof b.typ === "string" ? b.typ : null;
      if (!typ) return json({ fel: "Ogiltig begäran." }, 400);
      const anv0 = await inloggad(request, env);
      ctx.waitUntil(logga(env, typ, typeof b!.detalj === "string" ? b!.detalj : null, anv0 ? anv0.id : null));
      return json({ ok: true });
    }

    // Öppen hälsokontroll: säger bara om coachen är redo, inget mer. Går att
    // öppna i webbläsaren för att se direkt när nyckeln blivit aktiv.
    if (url.pathname === "/api/status" && request.method === "GET") {
      const redo = (await hamtaNyckel(env)) !== null;
      return json({
        coachRedo: redo,
        meddelande: redo
          ? "Coachen är redo — API-nyckeln är aktiv."
          : "API-nyckeln når inte koden ännu. Lägg till ANTHROPIC_API_KEY som Secret på Workern dagsformen och klicka Deploy.",
      });
    }

    // Diagnostik: visar VILKA miljövariabler Workern ser, aldrig deras värden.
    // Gör skillnad på "hemligheten saknas" och "hemligheten heter något annat".
    if (url.pathname === "/api/diagnostik" && request.method === "GET") {
      if (!anv) return json({ fel: "Logga in med din kod först." }, 401);
      const namn = Object.keys(env as unknown as Record<string, unknown>).sort();
      return json({
        variabelnamn: namn,
        harAnthropicNyckel: (await hamtaNyckel(env)) !== null,
        harDirektHemlighet: typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0,
        harSecretsStore: !!env.ANTHROPIC_NYCKEL,
        manadstak: env.MANADSTAK_USD,
        svarPerAnvandare: env.SVAR_PER_ANVANDARE,
      });
    }
    if (url.pathname === "/api/coach" && request.method === "POST") {
      if (!anv) return json({ fel: "Logga in med din kod först." }, 401);
      return coach(request, env, anv, ctx);
    }
    return json({ fel: "Okänd endpoint." }, 404);
  },
} satisfies ExportedHandler<Env>;
