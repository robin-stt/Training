/**
 * Mottagare för Health Auto Export → GitHub.
 *
 * Tar emot appens REST API-export (POST med JSON) och sparar hela payloaden
 * som en tidsstämplad fil under data/health-auto-export/ i repot via
 * GitHub:s contents-API.
 *
 * Miljövariabler (sätts i Cloudflare-dashboarden, se docs/health-auto-export-guide.md):
 *   API_KEY       Hemlig nyckel; appen skickar samma värde i headern x-api-key.
 *   GITHUB_TOKEN  Fine-grained PAT med Contents: Read and write för repot. (Secret!)
 *   GITHUB_REPO   T.ex. "robin-stt/Training".
 *   GITHUB_BRANCH Valfri; utelämnad = repots standardgren.
 */

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Endast POST", { status: 405 });
    }
    if (!env.API_KEY || request.headers.get("x-api-key") !== env.API_KEY) {
      return new Response("Fel eller saknad x-api-key", { status: 401 });
    }

    const payload = await request.text();
    if (!payload) {
      return new Response("Tom kropp", { status: 400 });
    }
    try {
      JSON.parse(payload);
    } catch {
      return new Response("Kroppen är inte giltig JSON", { status: 400 });
    }

    // Tidsstämplat filnamn (UTC) — varje export blir en egen fil, så inga
    // skrivkonflikter kan uppstå; merge-skriptet i repot hanterar överlapp.
    const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
    const path = `data/health-auto-export/${stamp}.json`;

    const body = {
      message: `Health Auto Export ${stamp}`,
      content: toBase64(payload),
    };
    if (env.GITHUB_BRANCH) {
      body.branch = env.GITHUB_BRANCH;
    }

    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "health-auto-export-worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      return new Response(`GitHub svarade ${response.status}: ${detail}`, { status: 502 });
    }
    return new Response(`Sparade ${path}`, { status: 200 });
  },
};
