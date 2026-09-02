/** Dagsformen — Cloudflare Worker: konton, kvoter och coachen. */
import {
  type Env, type Anvandare,
  skapaKod, normaliseraKod, sha256Hex, skapaSession, slutaSession, inloggad,
  kakaFran, sessionsKaka, raderadKaka,
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

/** Skapar ett konto och returnerar koden. Den visas en enda gång. */
async function registrera(request: Request, env: Env): Promise<Response> {
  const id = crypto.randomUUID();
  // I praktiken kolliderar två koder aldrig, men en krock ska ge en ny kod
  // i stället för ett fel — UNIQUE-villkoret på kod_hash fångar den.
  for (let forsok = 0; forsok < 5; forsok++) {
    const kod = skapaKod();
    try {
      await env.DB.prepare("INSERT INTO anvandare (id, kod_hash, skapad) VALUES (?, ?, ?)")
        .bind(id, await sha256Hex(normaliseraKod(kod) as string), new Date().toISOString())
        .run();
      const token = await skapaSession(env, id);
      return json({ kod }, 200, { "Set-Cookie": sessionsKaka(token) });
    } catch (fel) {
      if (forsok === 4) return json({ fel: "Kunde inte skapa en kod just nu. Prova igen." }, 500);
    }
  }
  return json({ fel: "Kunde inte skapa en kod just nu. Prova igen." }, 500);
}

async function loggaIn(request: Request, env: Env): Promise<Response> {
  const b = await laesJson(request);
  const kod = b ? normaliseraKod(b.kod) : null;
  if (!kod) return json({ fel: "Koden ser inte rätt ut. Den består av 16 tecken." }, 400);
  const rad = await env.DB.prepare("SELECT id FROM anvandare WHERE kod_hash = ?")
    .bind(await sha256Hex(kod)).first<{ id: string }>();
  if (!rad) return json({ fel: "Ingen hittades med den koden. Kontrollera att den är rätt avskriven." }, 401);
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
  if (!env.ANTHROPIC_API_KEY) {
    return json({
      fel: "Coachen är inte konfigurerad ännu: API-nyckeln saknas. Lägg till ANTHROPIC_API_KEY som Secret i Cloudflare.",
    }, 503);
  }

  await reserveraSvar(env, anv.id);
  try {
    return await stromaCoach(env, anv.id, b, ctx);
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

    if (url.pathname === "/api/registrera" && request.method === "POST") return registrera(request, env);
    if (url.pathname === "/api/logga-in" && request.method === "POST") return loggaIn(request, env);

    if (url.pathname === "/api/logga-ut" && request.method === "POST") {
      const token = kakaFran(request, "sess");
      if (token) await slutaSession(env, token);
      return json({ ok: true }, 200, { "Set-Cookie": raderadKaka });
    }

    const anv = await inloggad(request, env);
    if (url.pathname === "/api/mig" && request.method === "GET") {
      return anv ? migStatus(anv, env) : json({ inloggad: false });
    }
    // Öppen hälsokontroll: säger bara om coachen är redo, inget mer. Går att
    // öppna i webbläsaren för att se direkt när nyckeln blivit aktiv.
    if (url.pathname === "/api/status" && request.method === "GET") {
      const redo = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
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
        harAnthropicNyckel: typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0,
        nyckelLangd: typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.length : null,
        nyckelPrefix: typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.slice(0, 7) : null,
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
