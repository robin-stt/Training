CREATE TABLE IF NOT EXISTS anvandare (
  id TEXT PRIMARY KEY,
  -- Bara SHA-256 av inloggningskoden lagras, så en läckt databas inte
  -- innehåller några användbara koder.
  kod_hash TEXT NOT NULL UNIQUE,
  skapad TEXT NOT NULL
);

-- Bara hashen av sessionstoken lagras, av samma skäl.
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

-- Spärr mot att gissa sig till någons kod. En självvald kod går att gissa,
-- så det är den här räknaren som håller, inte hashningen.
CREATE TABLE IF NOT EXISTS forsok (
  nyckel TEXT PRIMARY KEY,
  antal INTEGER NOT NULL DEFAULT 0,
  nollstalls TEXT NOT NULL
);
