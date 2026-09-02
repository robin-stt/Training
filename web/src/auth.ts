/** Konton och sessioner. Lösenord hashas med PBKDF2-SHA256 via WebCrypto. */

const ITERATIONER = 210000;
const SESSION_DYGN = 30;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  MANADSTAK_USD: string;
  SVAR_PER_ANVANDARE: string;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function franB64(s: string): Uint8Array {
  const bin = atob(s);
  const ut = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) ut[i] = bin.charCodeAt(i);
  return ut;
}

async function pbkdf2(losenord: string, salt: Uint8Array, iterationer: number): Promise<Uint8Array> {
  const nyckel = await crypto.subtle.importKey("raw", new TextEncoder().encode(losenord), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: iterationer, hash: "SHA-256" },
    nyckel,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashaLosenord(losenord: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(losenord, salt, ITERATIONER);
  return `pbkdf2$${ITERATIONER}$${b64(salt)}$${b64(hash)}`;
}

/** Konstanttidsjämförelse så svarstiden inte avslöjar hur mycket som stämde. */
export async function verifieraLosenord(losenord: string, lagrat: string): Promise<boolean> {
  const delar = lagrat.split("$");
  if (delar.length !== 4 || delar[0] !== "pbkdf2") return false;
  const iterationer = parseInt(delar[1], 10);
  if (!Number.isFinite(iterationer) || iterationer < 1000) return false;
  const salt = franB64(delar[2]);
  const forvantad = franB64(delar[3]);
  const faktisk = await pbkdf2(losenord, salt, iterationer);
  if (faktisk.length !== forvantad.length) return false;
  let diff = 0;
  for (let i = 0; i < faktisk.length; i++) diff |= faktisk[i] ^ forvantad[i];
  return diff === 0;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function skapaSession(env: Env, anvandareId: string): Promise<string> {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[^A-Za-z0-9]/g, "");
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

export interface Anvandare { id: string; epost: string; }

export async function inloggad(request: Request, env: Env): Promise<Anvandare | null> {
  const token = kakaFran(request, "sess");
  if (!token) return null;
  const rad = await env.DB.prepare(
    `SELECT a.id AS id, a.epost AS epost, s.gar_ut AS gar_ut
       FROM sessioner s JOIN anvandare a ON a.id = s.anvandare_id
      WHERE s.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<{ id: string; epost: string; gar_ut: string }>();
  if (!rad) return null;
  if (Date.parse(rad.gar_ut) < Date.now()) {
    await slutaSession(env, token);
    return null;
  }
  return { id: rad.id, epost: rad.epost };
}

export function giltigEpost(e: unknown): e is string {
  return typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
export function giltigtLosenord(l: unknown): l is string {
  return typeof l === "string" && l.length >= 10 && l.length <= 200;
}
