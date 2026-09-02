#!/usr/bin/env bash
# Publicerar Dagsformen till Cloudflare Workers.
#
# Kräver tre miljövariabler:
#   CLOUDFLARE_API_TOKEN   token med Workers Scripts:Edit och D1:Edit
#   CLOUDFLARE_ACCOUNT_ID  konto-id från Cloudflares översiktssida
#   ANTHROPIC_API_KEY      nyckeln som driver coachen
#
# Skriptet går att köra om hur många gånger som helst: databasen skapas bara
# om den saknas, och tabellerna använder CREATE TABLE IF NOT EXISTS.
set -euo pipefail
cd "$(dirname "$0")"

saknas=()
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ANTHROPIC_API_KEY; do
  [ -n "${!v:-}" ] || saknas+=("$v")
done
if [ ${#saknas[@]} -gt 0 ]; then
  echo "Saknar miljövariabler: ${saknas[*]}" >&2
  exit 1
fi

echo "==> Installerar beroenden"
npm install --silent

echo "==> Letar efter D1-databasen"
db_id="$(npx wrangler d1 list --json 2>/dev/null \
  | python3 -c "
import json,sys
try: rader = json.load(sys.stdin)
except Exception: rader = []
print(next((r.get('uuid') or r.get('database_id','') for r in rader if r.get('name') == 'dagsformen'), ''))
")"

if [ -z "$db_id" ]; then
  echo "    Skapar databasen dagsformen"
  npx wrangler d1 create dagsformen >/dev/null
  db_id="$(npx wrangler d1 list --json 2>/dev/null \
    | python3 -c "
import json,sys
rader = json.load(sys.stdin)
print(next((r.get('uuid') or r.get('database_id','') for r in rader if r.get('name') == 'dagsformen'), ''))
")"
fi
[ -n "$db_id" ] || { echo "Kunde inte läsa ut databasens id." >&2; exit 1; }
echo "    database_id: $db_id"

echo "==> Skriver in id:t i wrangler.toml"
python3 - "$db_id" <<'PY'
import re, sys
id_ = sys.argv[1]
p = "wrangler.toml"
s = open(p, encoding="utf-8").read()
s = re.sub(r'database_id = "[^"]*"', f'database_id = "{id_}"', s, count=1)
open(p, "w", encoding="utf-8").write(s)
PY

echo "==> Lägger upp tabellerna"
npx wrangler d1 execute dagsformen --remote --file=./schema.sql --yes >/dev/null

echo "==> Lägger in API-nyckeln som hemlighet"
printf '%s' "$ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY >/dev/null

echo "==> Publicerar"
npx wrangler deploy
