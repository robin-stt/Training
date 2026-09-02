/** Dagsformen — Cloudflare Worker: konton, kvoter och coachen. */
import {
  type Env, type Anvandare,
  hashaLosenord, verifieraLosenord, skapaSession, slutaSession, inloggad,
  kakaFran, sessionsKaka, raderadKaka, giltigEpost, giltigtLosenord,
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

async function registrera(request: Request, env: Env): Promise<Response> {
  const b = await laesJson(request);
  if (!b) return json({ fel: "Ogiltig begäran." }, 400);
  const epost = typeof b.epost === "string" ? b.epost.trim().toLowerCase() : null;
  if (!giltigEpost(epost)) return json({ fel: "Ange en giltig e-postadress." }, 400);
  if (!giltigtLosenord(b.losenord)) return json({ fel: "Lösenordet måste vara minst 10 tecken." }, 400);

  const finns = await env.DB.prepare("SELECT id FROM anvandare WHERE epost = ?").bind(epost).first();
  if (finns) return json({ fel: "Det finns redan ett konto med den adressen." }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO anvandare (id, epost, losenord, skapad) VALUES (?, ?, ?, ?)")
    .bind(id, epost, await hashaLosenord(b.losenord), new Date().toISOString())
    .run();
  const token = await skapaSession(env, id);
  return json({ epost }, 200, { "Set-Cookie": sessionsKaka(token) });
}

async function loggaIn(request: Request, env: Env): Promise<Response> {
  const b = await laesJson(request);
  if (!b) return json({ fel: "Ogiltig begäran." }, 400);
  const epost = typeof b.epost === "string" ? b.epost.trim().toLowerCase() : "";
  const losenord = typeof b.losenord === "string" ? b.losenord : "";
  const rad = await env.DB.prepare("SELECT id, losenord FROM anvandare WHERE epost = ?")
    .bind(epost).first<{ id: string; losenord: string }>();
  // Samma svar oavsett om kontot saknas eller lösenordet är fel.
  const ok = rad ? await verifieraLosenord(losenord, rad.losenord) : false;
  if (!rad || !ok) return json({ fel: "Fel e-post eller lösenord." }, 401);
  const token = await skapaSession(env, rad.id);
  return json({ epost }, 200, { "Set-Cookie": sessionsKaka(token) });
}

async function migStatus(anv: Anvandare, env: Env): Promise<Response> {
  const kvot = await kollaKvot(env, anv.id);
  return json({
    epost: anv.epost,
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
      return anv ? migStatus(anv, env) : json({ epost: null });
    }
    if (url.pathname === "/api/coach" && request.method === "POST") {
      if (!anv) return json({ fel: "Logga in först." }, 401);
      return coach(request, env, anv, ctx);
    }
    return json({ fel: "Okänd endpoint." }, 404);
  },
} satisfies ExportedHandler<Env>;
