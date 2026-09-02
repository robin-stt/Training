/**
 * Inloggning med en kod som användaren väljer själv.
 *
 * Koden är både identitet och hemlighet: det finns inget användarnamn vid
 * sidan om. Det gör den bekväm men också känslig — en gissad kod ger direkt
 * åtkomst till kontot. Därför krävs minst MIN_LANGD tecken, uppenbart svaga
 * koder avvisas, och upprepade felförsök spärras (se kollaForsok).
 *
 * Koden lagras bara som SHA-256. Osaltat, eftersom inloggningen måste slå upp
 * kontot på enbart koden; hashen bär också unikhetskravet så att två personer
 * inte kan välja samma kod.
 */

const SESSION_DYGN = 30;
export const MIN_LANGD = 12;
const MAX_LANGD = 128;

// Fönster och tak för felförsök från samma avsändare.
const SPARR_MINUTER = 15;
const MAX_FORSOK = 10;

// Utan I, L, O, U och 0/1 — tecken som lätt förväxlas vid avskrift.
const ALFABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_NYCKEL?: { get(): Promise<string> };
  MANADSTAK_USD: string;
  SVAR_PER_ANVANDARE: string;
}

/** Förslag till den som inte vill hitta på en kod själv. */
export function foreslaKod(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let kod = "";
  for (const b of bytes) kod += ALFABET[b % ALFABET.length];
  return (kod.match(/.{1,4}/g) as string[]).join("-");
}

/** Trimmar kanterna men rör inte innehållet — versaler räknas. */
export function normaliseraKod(kod: unknown): string | null {
  if (typeof kod !== "string") return null;
  const rensad = kod.trim();
  if (rensad.length < MIN_LANGD || rensad.length > MAX_LANGD) return null;
  // Kontrolltecken skulle bara ställa till det vid avskrift.
  if (/[\x00-\x1f\x7f]/.test(rensad)) return null;
  return rensad;
}

/** Uppenbart svaga koder som annars gissas på första försöket. */
const SVAGA = [
  "lösenord", "losenord", "password", "hemligkod", "123456789012",
  "abcdefghijkl", "qwertyuiopas", "dagsformen",
];
export function forSvagKod(kod: string): boolean {
  const l = kod.toLowerCase();
  if (SVAGA.some(s => l === s || l.startsWith(s))) return true;
  // En kod av bara ett par olika tecken bär ingen hemlighet.
  if (new Set(l).size <= 3) return true;
  return false;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Räknar felförsök per avsändare. Eftersom en självvald kod går att gissa är
 * det här skyddet som faktiskt håller — inte hashningen.
 */
export async function kollaForsok(env: Env, request: Request): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") || "okand";
  const rad = await env.DB.prepare("SELECT antal, nollstalls FROM forsok WHERE nyckel = ?")
    .bind(ip).first<{ antal: number; nollstalls: string }>();
  if (!rad) return true;
  if (Date.parse(rad.nollstalls) < Date.now()) {
    await env.DB.prepare("DELETE FROM forsok WHERE nyckel = ?").bind(ip).run();
    return true;
  }
  return rad.antal < MAX_FORSOK;
}

export async function raknaFelforsok(env: Env, request: Request): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") || "okand";
  const nollstalls = new Date(Date.now() + SPARR_MINUTER * 60000).toISOString();
  await env.DB.prepare(
    `INSERT INTO forsok (nyckel, antal, nollstalls) VALUES (?, 1, ?)
     ON CONFLICT(nyckel) DO UPDATE SET antal = antal + 1`,
  ).bind(ip, nollstalls).run();
}

export async function nollstallForsok(env: Env, request: Request): Promise<void> {
  const ip = request.headers.get("CF-Connecting-IP") || "okand";
  await env.DB.prepare("DELETE FROM forsok WHERE nyckel = ?").bind(ip).run();
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
 * API-nyckeln kan komma två vägar: som hemlighet på själva Workern, eller ur
 * kontots Secrets Store. Första träffen vinner.
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
