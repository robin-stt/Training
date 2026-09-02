/**
 * Kostnadsspärrar. Coachen drivs av ägarens API-nyckel, så två tak gäller:
 * ett per användare och månad, och ett för hela appens månadskostnad.
 */
import type { Env } from "./auth";

// Priser per miljon tokens för claude-opus-5. Cache-läsning och cache-skrivning
// följer standardmultiplikatorerna (0,1× respektive 1,25× av inpriset).
const IN_PER_MTOK = 5;
const UT_PER_MTOK = 25;

export interface Forbrukning {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function kostnadUsd(f: Forbrukning): number {
  const inTok = f.input_tokens ?? 0;
  const utTok = f.output_tokens ?? 0;
  const cacheLast = f.cache_read_input_tokens ?? 0;
  const cacheSkriv = f.cache_creation_input_tokens ?? 0;
  return (
    (inTok * IN_PER_MTOK + cacheLast * IN_PER_MTOK * 0.1 + cacheSkriv * IN_PER_MTOK * 1.25 + utTok * UT_PER_MTOK) / 1e6
  );
}

export const manadNu = (): string => new Date().toISOString().slice(0, 7);

export interface KvotStatus {
  tillaten: boolean;
  skal?: "anvandartak" | "manadstak";
  kvarForAnvandaren: number;
  manadstakUsd: number;
  spenderatUsd: number;
}

export async function kollaKvot(env: Env, anvandareId: string): Promise<KvotStatus> {
  const manad = manadNu();
  const takUsd = Number(env.MANADSTAK_USD) || 0;
  const perAnvandare = Number(env.SVAR_PER_ANVANDARE) || 0;

  const [mitt, totalt] = await Promise.all([
    env.DB.prepare("SELECT svar FROM anvandning WHERE anvandare_id = ? AND manad = ?")
      .bind(anvandareId, manad).first<{ svar: number }>(),
    env.DB.prepare("SELECT kostnad_usd FROM total_anvandning WHERE manad = ?")
      .bind(manad).first<{ kostnad_usd: number }>(),
  ]);

  const anvant = mitt?.svar ?? 0;
  const spenderat = totalt?.kostnad_usd ?? 0;
  const kvar = Math.max(0, perAnvandare - anvant);

  if (spenderat >= takUsd) {
    return { tillaten: false, skal: "manadstak", kvarForAnvandaren: kvar, manadstakUsd: takUsd, spenderatUsd: spenderat };
  }
  if (kvar <= 0) {
    return { tillaten: false, skal: "anvandartak", kvarForAnvandaren: 0, manadstakUsd: takUsd, spenderatUsd: spenderat };
  }
  return { tillaten: true, kvarForAnvandaren: kvar, manadstakUsd: takUsd, spenderatUsd: spenderat };
}

/**
 * Räknas upp direkt när ett svar påbörjas, inte när det är klart. Annars kan
 * flera samtidiga anrop passera samma kvotkontroll innan någon hunnit bokföras.
 */
export async function reserveraSvar(env: Env, anvandareId: string): Promise<void> {
  const manad = manadNu();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO anvandning (anvandare_id, manad, svar, kostnad_usd) VALUES (?, ?, 1, 0)
       ON CONFLICT(anvandare_id, manad) DO UPDATE SET svar = svar + 1`,
    ).bind(anvandareId, manad),
    env.DB.prepare(
      `INSERT INTO total_anvandning (manad, svar, kostnad_usd) VALUES (?, 1, 0)
       ON CONFLICT(manad) DO UPDATE SET svar = svar + 1`,
    ).bind(manad),
  ]);
}

/** Bokför den faktiska kostnaden när svaret är klart och förbrukningen känd. */
export async function bokforKostnad(env: Env, anvandareId: string, f: Forbrukning): Promise<void> {
  const manad = manadNu();
  const usd = kostnadUsd(f);
  if (!(usd > 0)) return;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO anvandning (anvandare_id, manad, svar, kostnad_usd) VALUES (?, ?, 0, ?)
       ON CONFLICT(anvandare_id, manad) DO UPDATE SET kostnad_usd = kostnad_usd + ?`,
    ).bind(anvandareId, manad, usd, usd),
    env.DB.prepare(
      `INSERT INTO total_anvandning (manad, svar, kostnad_usd) VALUES (?, 0, ?)
       ON CONFLICT(manad) DO UPDATE SET kostnad_usd = kostnad_usd + ?`,
    ).bind(manad, usd, usd),
  ]);
}

/** Ångrar reservationen när anropet aldrig gick igenom. */
export async function angraReservation(env: Env, anvandareId: string): Promise<void> {
  const manad = manadNu();
  await env.DB.batch([
    env.DB.prepare("UPDATE anvandning SET svar = MAX(0, svar - 1) WHERE anvandare_id = ? AND manad = ?").bind(anvandareId, manad),
    env.DB.prepare("UPDATE total_anvandning SET svar = MAX(0, svar - 1) WHERE manad = ?").bind(manad),
  ]);
}
