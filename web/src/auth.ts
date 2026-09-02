/**
 * Inloggning med en slumpad kod i stället för e-post och lösenord.
 *
 * Koden skapas av servern vid första besöket och är både identitet och
 * hemlighet. Den har 80 bitars entropi, vilket inte går att gissa sig till, så
 * ingen långsam lösenordshashning behövs — ett SHA-256-uppslag räcker och tar
 * mikrosekunder. Det är därför appen får plats på Cloudflares gratisnivå.
 *
 * Priset är att koden inte kan återställas: tappar man bort den kommer man inte
 * in i sitt konto igen. Frontenden säger det tydligt när koden visas.
 */

const SESSION_DYGN = 30;

// Utan I, L, O, U och siffrorna 0/1 — tecken som lätt förväxlas vid avskrift.
const ALFABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const KOD_TECKEN = 16;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Hemlighet satt direkt på Workern. Kan saknas — se hamtaNyckel. */
  ANTHROPIC_API_KEY?: string;
  /** Hemlighet ur kontots Secrets Store; värdet hämtas asynkront. */
  ANTHROPIC_NYCKEL?: { get(): Promise<string> };
  MANADSTAK_USD: string;
  SVAR_PER_ANVANDARE: string;
}

/** Returnerar en kod i formen ABCD-EFGH-JKMN-PQRS. */
export function skapaKod(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KOD_TECKEN));
  let kod = "";
  for (let i = 0; i < KOD_TECKEN; i++) {
    // Modulo mot 30 av 256 ger en försumbar skevhet (256 = 8×30 + 16), och
    // entropin ligger ändå långt över vad som behövs.
    kod += ALFABET[bytes[i] % ALFABET.length];
  }
  return (kod.match(/.{1,4}/g) as string[]).join("-");
}

/** Gör koden jämförbar oavsett gemener, mellanslag eller bindestreck. */
export function normaliseraKod(kod: unknown): string | null {
  if (typeof kod !== "string" || kod.length > 64) return null;
  const rensad = kod.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (rensad.length !== KOD_TECKEN) return null;
  for (const tecken of rensad) if (!ALFABET.includes(tecken)) return null;
  return rensad;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function skapaSession(env: Env, anvandareId: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let token = "";
  for (const b of bytes) token += b.toString(16).padStart(2, "0");
  const garUt = new Date(Date.now() + SESSION_DYGN * 864e5).toISOString();
  await env.DB.prepare("INSERT INTO sessioner (token_hash, anvandare_id, gar_ut) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), anvandareId, garUt)
    .run();
  return token;
}

export async function slutaSession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessioner WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export function kakaFran(request: Request, namn: string): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const del of header.split(";")) {
    const [k, ...v] = del.trim().split("=");
    if (k === namn) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionsKaka(token: string): string {
  return `sess=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DYGN * 24 * 3600}`;
}
export const raderadKaka = "sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

export interface Anvandare { id: string; }

export async function inloggad(request: Request, env: Env): Promise<Anvandare | null> {
  const token = kakaFran(request, "sess");
  if (!token) return null;
  const rad = await env.DB.prepare(
    `SELECT a.id AS id, s.gar_ut AS gar_ut
       FROM sessioner s JOIN anvandare a ON a.id = s.anvandare_id
      WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<{ id: string; gar_ut: string }>();
  if (!rad) return null;
  if (Date.parse(rad.gar_ut) < Date.now()) {
    await slutaSession(env, token);
    return null;
  }
  return { id: rad.id };
}

/**
 * Nyckeln kan komma två vägar: som hemlighet på själva Workern, eller ur
 * kontots Secrets Store. Secrets Store är den som följer med konfigurationen
 * och därför överlever varje bygge; den direkta hemligheten är kvar som
 * alternativ. Första träffen vinner.
 */
export async function hamtaNyckel(env: Env): Promise<string | null> {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0) {
    return env.ANTHROPIC_API_KEY;
  }
  if (env.ANTHROPIC_NYCKEL && typeof env.ANTHROPIC_NYCKEL.get === "function") {
    try {
      const varde = await env.ANTHROPIC_NYCKEL.get();
      if (typeof varde === "string" && varde.length > 0) return varde;
    } catch (fel) {
      console.error("kunde inte läsa nyckeln ur Secrets Store:", fel);
    }
  }
  return null;
}
