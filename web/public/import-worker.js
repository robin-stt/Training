/**
 * Importtråd. Hela tolkningen av exportfilen sker här, inte på sidans egen
 * tråd — en 34 MB zip kan innehålla närmare en gigabyte uppackad XML, och när
 * det arbetet låg på huvudtråden frös fliken så länge att mobilen dödade den.
 * Då syntes varken resultat eller felmeddelande.
 *
 * Tar emot en fil, skickar tillbaka framsteg löpande och till sist resultatet.
 */
self.importScripts("/fflate.js");

// Hjälpare som tolkningen behöver. Ligger även på sidan, men tråden har sitt
// eget scope och kommer inte åt dem — det gav "medel is not defined".
const KJ = 4.184, MI = 1.609344;
const medel = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/* ================================================= CSV / Health Auto === */
function parseCsv(text) {
  const rader = []; let rad = [], falt = "", cit = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (cit) { if (c === '"') { if (text[i + 1] === '"') { falt += '"'; i++; } else cit = false; } else falt += c; }
    else if (c === '"') cit = true;
    else if (c === ",") { rad.push(falt); falt = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rad.push(falt); falt = "";
      if (rad.length > 1 || rad[0] !== "") rader.push(rad);
      rad = [];
    } else falt += c;
  }
  if (falt !== "" || rad.length) { rad.push(falt); rader.push(rad); }
  return rader;
}
function enhetsFaktor(h) {
  if (/\(kJ\)/i.test(h)) return 1 / KJ;
  if (/\(mi\)/i.test(h)) return MI;
  return 1;
}
const HAE_DAG = [
  [/stegräkning|step count/i, "steg"],
  [/promenad \+ löpsträcka|walking \+ running distance/i, "distans_km"],
  [/^aktiv energi|^active energy/i, "aktiv_energi_kcal"],
  [/apple träningstid|apple exercise time/i, "traningstid_min"],
  [/vilo ?hjärtfrekvens|resting heart rate/i, "vilopuls"],
  [/hjärtfrekvensvariabilitet|heart rate variability/i, "hrv_ms"],
  // Sömn rapporteras antingen som klumpsumma i [Sova] eller uppdelat på faser
  // med [Sova] = 0 beroende på om klockan burits. Båda läses; den större gäller.
  [/sömnanalyser \[sova\]|sleep analysis \[asleep\]/i, "_sova"],
  [/sömnanalyser \[kärna\]|sleep analysis \[core\]/i, "_karna"],
  [/sömnanalyser \[djup\]|sleep analysis \[deep\]/i, "djupsomn_timmar"],
  [/sömnanalyser \[rem\]|sleep analysis \[rem\]/i, "_rem"],
  [/^vikt \(|^weight \(|body mass \((?!.*index)/i, "vikt_kg"],
  [/vo2 max/i, "vo2max"],
];
const HAE_PASS = [
  [/^aktiv energi|^active energy/i, "energi_kcal"],
  [/genom.* hjärtfrekvens|avg.* heart rate/i, "puls_medel"],
  [/max.* hjärtfrekvens|max.* heart rate/i, "puls_max"],
  [/^avstånd|^distance \(/i, "distans_km"],
];
function kolumner(rubriker, karta) {
  const ut = {};
  rubriker.forEach((h, i) => { for (const [re, key] of karta) if (re.test(h) && ut[key] === undefined) { ut[key] = { i, f: enhetsFaktor(h) }; break; } });
  return ut;
}
function haeDaglig(text) {
  const rader = parseCsv(text);
  if (rader.length < 2) return [];
  const kol = kolumner(rader[0], HAE_DAG);
  const iDat = rader[0].findIndex(h => /datum|date/i.test(h));
  const ut = [];
  for (const r of rader.slice(1)) {
    const rec = { datum: (r[iDat] || "").slice(0, 10) };
    for (const [key, { i, f }] of Object.entries(kol)) { const v = parseFloat(r[i]); if (isFinite(v)) rec[key] = Math.round(v * f * 100) / 100; }
    const faser = (rec._karna || 0) + (rec.djupsomn_timmar || 0) + (rec._rem || 0);
    const somn = Math.max(rec._sova || 0, faser);
    delete rec._sova; delete rec._karna; delete rec._rem;
    if (somn > 0) rec.somn_timmar = Math.round(somn * 100) / 100;
    if (!rec.djupsomn_timmar) delete rec.djupsomn_timmar;
    ut.push(rec);
  }
  return ut;
}
function haePass(text) {
  const rader = parseCsv(text);
  if (rader.length < 2) return [];
  const h = rader[0], kol = kolumner(h, HAE_PASS);
  const iTyp = h.findIndex(x => /workout type|typ av träning/i.test(x));
  const iStart = h.findIndex(x => /^start/i.test(x));
  const iTid = h.findIndex(x => /^duration|varaktighet/i.test(x));
  const ut = [];
  for (const r of rader.slice(1)) {
    const start = (r[iStart] || "").replace(" ", "T").slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(start)) continue;
    const w = { start, typ: r[iTyp] || "Träning" };
    const d = (r[iTid] || "").split(":").map(Number);
    if (d.length === 3 && d.every(isFinite)) w.varaktighet_min = Math.round((d[0] * 60 + d[1] + d[2] / 60) * 10) / 10;
    for (const [key, { i, f }] of Object.entries(kol)) { const v = parseFloat(r[i]); if (isFinite(v) && v > 0) w[key] = Math.round(v * f * 10) / 10; }
    ut.push(w);
  }
  return ut;
}
// Per-minut-puls: "<Typ>-Puls-ÅÅÅÅMMDD_HHMMSS.csv" med kolumnen Avg.
function haePuls(namn, text) {
  const m = namn.match(/-(?:Puls|Heart Rate)-(\d{8})_(\d{6})\.csv$/i);
  if (!m) return null;
  const d = m[1], t = m[2];
  const start = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}`;
  const rader = parseCsv(text);
  if (rader.length < 2) return null;
  const iAvg = rader[0].findIndex(h => /^avg/i.test(h));
  if (iAvg < 0) return null;
  const hr = [];
  for (const r of rader.slice(1)) { const v = parseFloat(r[iAvg]); if (isFinite(v) && v > 30) hr.push(Math.round(v)); }
  return hr.length ? { start, hr } : null;
}

/* =========================================== Apple Hälsa export.xml === */
const XML_SUM = { HKQuantityTypeIdentifierStepCount: "steg", HKQuantityTypeIdentifierDistanceWalkingRunning: "distans_km", HKQuantityTypeIdentifierActiveEnergyBurned: "aktiv_energi_kcal", HKQuantityTypeIdentifierAppleExerciseTime: "traningstid_min" };
const XML_SNITT = { HKQuantityTypeIdentifierRestingHeartRate: "vilopuls", HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv_ms", HKQuantityTypeIdentifierVO2Max: "vo2max" };
const PASSNAMN = { Running: "Löpning", Walking: "Promenad", Cycling: "Cykling", TraditionalStrengthTraining: "Styrketräning", FunctionalStrengthTraining: "Funktionell styrka", HighIntensityIntervalTraining: "HIIT", Swimming: "Simning", Yoga: "Yoga", Hiking: "Vandring", Elliptical: "Crosstrainer", Rowing: "Rodd", CrossTraining: "Cirkelträning", CoreTraining: "Bålträning", StairClimbing: "Trappor", Soccer: "Fotboll", Tennis: "Tennis", Padel: "Padel", DownhillSkiing: "Utförsåkning", CrossCountrySkiing: "Längdskidor", Other: "Övrigt" };

// "2026-06-01 23:30:00 +0300" → ms. Både mellanslaget före tiden och det före
// tidszonen måste bort för att Date.parse ska godta strängen.
function hkDatum(s) { return Date.parse(String(s || "").replace(" ", "T").replace(/\s+(?=[+-]\d{2}:?\d{2}$)/, "")); }
// Posttyper importen faktiskt använder. Allt annat sållas bort direkt.
const INTRESSANTA = /HKQuantityTypeIdentifier(?:StepCount|DistanceWalkingRunning|ActiveEnergyBurned|AppleExerciseTime|RestingHeartRate|HeartRateVariabilitySDNN|VO2Max|BodyMass)|HKCategoryTypeIdentifierSleepAnalysis/;

function attr(tag) { const o = {}; const re = /([\w:]+)="([^"]*)"/g; let m; while ((m = re.exec(tag))) o[m[1]] = m[2]; return o; }

function xmlAggregator() {
  const sum = {}, snitt = {}, sist = {}, somn = {}, djup = {}, pass = [];
  let nu = null;
  function post(tag) {
    // Billig förprövning först: en Apple-export innehåller miljontals poster
    // av typer vi inte använder, och att plocka isär var och en av dem åt både
    // tid och minne. Ett enda test sållar bort dem innan attr() körs.
    if (!INTRESSANTA.test(tag)) return;
    const a = attr(tag), t = a.type; if (!t) return;
    const dag = (a.startDate || "").slice(0, 10); if (!dag) return;
    const v = parseFloat(a.value);
    if (t in XML_SUM) {
      if (!isFinite(v)) return;
      const key = XML_SUM[t];
      let f = 1;
      if (key === "distans_km" && a.unit === "mi") f = MI;
      if (key === "aktiv_energi_kcal" && a.unit === "kJ") f = 1 / KJ;
      ((sum[dag] ||= {})[key] ||= {})[a.sourceName || "?"] = (sum[dag][key][a.sourceName || "?"] || 0) + v * f;
    } else if (t in XML_SNITT) {
      if (isFinite(v)) ((snitt[dag] ||= {})[XML_SNITT[t]] ||= []).push(v);
    } else if (t === "HKQuantityTypeIdentifierBodyMass") {
      if (!isFinite(v)) return;
      const kg = v * (a.unit === "lb" ? 0.4536 : 1);
      if (!sist[dag] || a.startDate > sist[dag].t) sist[dag] = { t: a.startDate, v: kg };
    } else if (t === "HKCategoryTypeIdentifierSleepAnalysis" && /Asleep/.test(a.value || "")) {
      const s = hkDatum(a.startDate), e = hkDatum(a.endDate);
      if (!isFinite(s) || !isFinite(e)) return;
      const natt = (a.endDate || "").slice(0, 10), k = a.sourceName || "?", h = (e - s) / 36e5;
      (somn[natt] ||= {})[k] = (somn[natt][k] || 0) + h;
      if (/Deep/.test(a.value)) (djup[natt] ||= {})[k] = (djup[natt][k] || 0) + h;
    }
  }
  function passStart(tag) {
    const a = attr(tag);
    const start = (a.startDate || "").replace(" ", "T").slice(0, 16);
    if (!start) { nu = null; return; }
    const rå = (a.workoutActivityType || "").replace("HKWorkoutActivityType", "");
    const w = { start, typ: PASSNAMN[rå] || rå || "Träning" };
    const d = parseFloat(a.duration);
    if (isFinite(d)) w.varaktighet_min = Math.round((a.durationUnit === "s" ? d / 60 : d) * 10) / 10;
    const km = parseFloat(a.totalDistance);
    if (isFinite(km) && km > 0) w.distans_km = Math.round(km * (a.totalDistanceUnit === "mi" ? MI : 1) * 100) / 100;
    const en = parseFloat(a.totalEnergyBurned);
    if (isFinite(en) && en > 0) w.energi_kcal = Math.round(en * (a.totalEnergyBurnedUnit === "kJ" ? 1 / KJ : 1));
    nu = w;
  }
  function passStat(tag) {
    if (!nu) return;
    const a = attr(tag), v = parseFloat(a.sum ?? a.average), t = a.type || "";
    if (!isFinite(v)) return;
    if (/Distance/.test(t) && nu.distans_km == null) nu.distans_km = Math.round(v * (a.unit === "mi" ? MI : 1) * 100) / 100;
    if (/ActiveEnergyBurned/.test(t) && nu.energi_kcal == null) nu.energi_kcal = Math.round(v * (a.unit === "kJ" ? 1 / KJ : 1));
    if (/HeartRate$/.test(t)) {
      if (a.average) nu.puls_medel = Math.round(parseFloat(a.average));
      if (a.maximum) nu.puls_max = Math.round(parseFloat(a.maximum));
    }
  }
  const passSlut = () => { if (nu) pass.push(nu); nu = null; };
  function klart() {
    const dagar = new Set([...Object.keys(sum), ...Object.keys(snitt), ...Object.keys(sist), ...Object.keys(somn)]);
    const daglig = [];
    for (const dag of dagar) {
      const r = { datum: dag };
      if (sum[dag]) for (const [key, kallor] of Object.entries(sum[dag])) {
        // iPhone och klockan loggar samma aktivitet — bästa källan, inte summan.
        const b = Math.max(...Object.values(kallor));
        if (b > 0) r[key] = Math.round(b * 100) / 100;
      }
      if (snitt[dag]) for (const [key, v] of Object.entries(snitt[dag])) r[key] = Math.round(medel(v) * 10) / 10;
      if (sist[dag]) r.vikt_kg = Math.round(sist[dag].v * 10) / 10;
      if (somn[dag]) r.somn_timmar = Math.round(Math.max(...Object.values(somn[dag])) * 100) / 100;
      if (djup[dag]) r.djupsomn_timmar = Math.round(Math.max(...Object.values(djup[dag])) * 100) / 100;
      daglig.push(r);
    }
    return { daglig, pass };
  }
  return { post, passStart, passStat, passSlut, klart };
}

/**
 * Läser hela zip-filen i ett svep och plockar ut det som finns, oavsett
 * format. Tidigare avgjordes formatet genom att titta på filens första
 * fyra megabyte — men i en riktig Apple-export ligger export.xml ofta
 * långt efter den gränsen, bakom den stora export_cda.xml, och då
 * misstogs exporten för ett annat format och importen sa att den var tom.
 */
async function importeraZip(fil) {
  const agg = xmlAggregator();
  const dec = new TextDecoder();
  let svans = "";
  let sagXml = false;
  let daglig = [], pass = [];
  const hr = [];
  let felIStrom = null;

  // Uppackningen kan lämna hela filen i ett enda anrop — 25 MB blev 50 MB som
  // JS-sträng, plus en kopia vid hopfogningen. På en telefon räckte det för att
  // webbläsaren skulle döda fliken. Därför avkodas och genomsöks bytena i små
  // bitar, så ingen stor sträng någonsin existerar.
  const BIT = 512 * 1024;

  function sokIgenom(t) {
    const re = /<(Record|Workout|WorkoutStatistics|\/Workout)\b[^>]*>/g;
    let m;
    while ((m = re.exec(t))) {
      if (m[1] === "Record") agg.post(m[0]);
      else if (m[1] === "Workout") agg.passStart(m[0]);
      else if (m[1] === "WorkoutStatistics") agg.passStat(m[0]);
      else agg.passSlut();
    }
  }

  function skannaXml(data, sista) {
    for (let i = 0; i < data.length; i += BIT) {
      const slut = Math.min(i + BIT, data.length);
      const sistaBiten = sista && slut >= data.length;
      let t = svans + dec.decode(data.subarray(i, slut), { stream: !sistaBiten });
      if (!sistaBiten) {
        // Bryt bara vid en avslutad tagg, annars kapas en post mitt itu.
        const c = t.lastIndexOf(">");
        if (c < 0) { svans = t; continue; }
        svans = t.slice(c + 1);
        t = t.slice(0, c + 1);
      } else svans = "";
      sokIgenom(t);
    }
  }

  const uz = new fflate.Unzip();
  uz.register(fflate.UnzipInflate);
  uz.onfile = f => {
    const namn = f.name;
    if (namn.endsWith("export.xml") && !namn.includes("export_cda")) {
      sagXml = true;
      f.ondata = (e, data, sista) => {
        if (e) { felIStrom = e; return; }
        skannaXml(data, sista);
      };
      f.start();
      return;
    }
    const arHae = /(^|\/)HealthAutoExport-[^/]*\.csv$/i.test(namn)
      || /(^|\/)Workouts-[^/]*\.csv$/i.test(namn)
      || /-(?:Puls|Heart Rate)-\d{8}_\d{6}\.csv$/i.test(namn);
    if (!arHae) {
      // Startas filen inte alls buffrar uppackningen den i väntan på besked.
      // Att starta den och kasta bitarna direkt håller minnet nere.
      f.ondata = () => {};
      f.start();
      return;
    }
    const bitar = [];
    f.ondata = (e, data, sista) => {
      if (e) { felIStrom = e; return; }
      bitar.push(data);
      if (!sista) return;
      let langd = 0;
      for (const b of bitar) langd += b.length;
      const hela = new Uint8Array(langd);
      let i = 0;
      for (const b of bitar) { hela.set(b, i); i += b.length; }
      const text = new TextDecoder().decode(hela);
      if (/HealthAutoExport-/i.test(namn)) daglig = daglig.concat(haeDaglig(text));
      else if (/Workouts-/i.test(namn)) pass = pass.concat(haePass(text));
      else { const sess = haePuls(namn, text); if (sess) hr.push(sess); }
    };
    f.start();
  };

  // Små bitar in ger små bitar ut: uppackningen buffrar mindre, och
  // framstegsvisningen blir jämnare.
  const CH = 512 * 1024;
  let off = 0;
  while (off < fil.size) {
    const buf = new Uint8Array(await fil.slice(off, Math.min(off + CH, fil.size)).arrayBuffer());
    off += buf.length;
    uz.push(buf, off >= fil.size);
    if (felIStrom) throw felIStrom;
    self.postMessage({ typ: "framsteg", pct: Math.round(off / fil.size * 100) });
    // Andrum så att inflate-bufferten hinner tömmas mellan bitarna.
    await new Promise(r => setTimeout(r));
  }

  if (sagXml) {
    const r = agg.klart();
    daglig = daglig.concat(r.daglig);
    pass = pass.concat(r.pass);
  }
  return { daglig, pass, hr };
}

self.onmessage = async (e) => {
  try {
    const r = await importeraZip(e.data.fil);
    self.postMessage({ typ: "klar", daglig: r.daglig, pass: r.pass, hr: r.hr });
  } catch (fel) {
    self.postMessage({ typ: "fel", meddelande: fel && fel.message ? fel.message : String(fel) });
  }
};
