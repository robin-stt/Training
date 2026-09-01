# Guide: Automatisk kvällsrapport från Apple Hälsa via Genvägar

Den här guiden bygger en genväg på iPhone som varje kväll läser dagens nyckeltal ur Apple Hälsa och sparar dem som en JSON-fil i det här repot (`data/genvagar/ÅÅÅÅ-MM-DD.json`). Claude kan sedan analysera datan när du frågar.

Tid att sätta upp: ca 15 minuter. Kostnad: 0 kr, inga extra appar.

## Steg 1 — Skapa en GitHub-token

Genvägen behöver en nyckel för att få skriva till repot. Skapa en **fine-grained personal access token** som bara kommer åt detta repo:

1. Gå till <https://github.com/settings/personal-access-tokens/new> (inloggad som ditt GitHub-konto).
2. **Token name:** t.ex. `halsa-genvag`.
3. **Expiration:** t.ex. 1 år (sätt en påminnelse om att förnya).
4. **Repository access:** *Only select repositories* → välj `robin-stt/Training`.
5. **Permissions → Repository permissions → Contents:** *Read and write*. Inget annat behövs.
6. Klicka **Generate token** och kopiera token-strängen (visas bara en gång).

> **Viktigt:** Token ger skrivåtkomst till just detta repo och inget annat. Dela den inte, och klistra aldrig in den i en chatt. Den ska bara ligga inne i genvägen på din telefon.

## Steg 2 — Bygg genvägen

Öppna appen **Genvägar** → **+** (ny genväg). Döp den till t.ex. *Hälsorapport*. Lägg till åtgärderna nedan i ordning. (Åtgärdsnamn inom parentes är de engelska, om telefonen är på engelska.)

### 2a. Datum

1. **Datum** (Date) → *Aktuellt datum*.
2. **Formatera datum** (Format Date) → Datumformat: *Anpassat* → formatsträng `yyyy-MM-dd`.
   Döp resultatet till variabeln **Datum** (tryck på åtgärdens resultat → Byt namn).

### 2b. Steg

3. **Hitta hälsoprover** (Find Health Samples) → Typ: **Steg**. Lägg till filter: *Startdatum* → *är idag*. Slå på **Gruppera prov: Kombinerat** om alternativet finns.
4. **Beräkna statistik** (Calculate Statistics) → *Summa* av hälsoproverna. Döp resultatet till **Steg**.

### 2c. Aktiv energi

5. **Hitta hälsoprover** → Typ: **Aktiv energi**, filter *Startdatum är idag*.
6. **Beräkna statistik** → *Summa*. Döp till **AktivEnergi**.

### 2d. Distans

7. **Hitta hälsoprover** → Typ: **Gå- + löpsträcka**, filter *Startdatum är idag*.
8. **Beräkna statistik** → *Summa*. Döp till **Distans**.

### 2e. Vilopuls

9. **Hitta hälsoprover** → Typ: **Vilopuls**, filter *Startdatum är idag*.
10. **Beräkna statistik** → *Genomsnitt*. Döp till **Vilopuls**.

### 2f. Sömn (senaste natten)

11. **Hitta hälsoprover** → Typ: **Sömn**, filter: *Startdatum* → *är under de senaste* → *18 timmar*. Lägg om möjligt till filtret *Värde är Sover* (Asleep) så att "i sängen"-tid inte räknas med.
12. **Beräkna statistik** → *Summa* (ger sömntid; enheten följer provet, oftast timmar eller minuter — kontrollera vid testkörningen och notera vilken det blev).
    Döp till **Somn**.

### 2g. Bygg JSON och skicka till GitHub

13. **Text** (Text) → klistra in din token från steg 1. Döp till **Token**.
14. **Ordbok** (Dictionary) → lägg till nycklarna, med variablerna från stegen ovan som värden:
    | Nyckel | Värde |
    |---|---|
    | `datum` | Datum |
    | `steg` | Steg |
    | `aktiv_energi_kcal` | AktivEnergi |
    | `distans_km` | Distans |
    | `vilopuls` | Vilopuls |
    | `somn` | Somn |
15. **Hämta text från inmatning** (Get Text from Input) med Ordboken som inmatning — detta ger ordboken som JSON-text.
16. **Base64-koda** (Base64 Encode) → koda texten från föregående steg. Döp till **Innehall**.
17. **Ordbok** (Dictionary) — API-anropets kropp:
    | Nyckel | Värde |
    |---|---|
    | `message` | Text: `Hälsodata` + variabeln Datum |
    | `content` | Innehall |
18. **Hämta innehåll i URL** (Get Contents of URL):
    - **URL:** `https://api.github.com/repos/robin-stt/Training/contents/data/genvagar/` + variabeln **Datum** + `.json`
    - Tryck på *Visa mer*:
    - **Metod:** `PUT`
    - **Rubriker (Headers):**
      - `Authorization` = `Bearer ` + variabeln **Token** (observera mellanslaget efter Bearer)
      - `Accept` = `application/vnd.github+json`
    - **Begärans innehåll (Request Body):** JSON → välj ordboken från steg 17.

## Steg 3 — Testkör

Kör genvägen manuellt (▶). Godkänn frågorna om åtkomst till Hälsa-data och nätverk första gången. Kontrollera sedan att filen dykt upp i repot under `data/genvagar/`. Öppna den och rimlighetskolla värdena (särskilt sömnens enhet, se steg 12).

## Steg 4 — Automatisera

1. Genvägar-appen → fliken **Automation** → **+**.
2. **Tid på dagen** → t.ex. **21:30**, Varje dag.
3. Välj **Kör direkt** (Run Immediately) så att den inte frågar varje kväll.
4. Välj genvägen *Hälsorapport*.

## Bra att veta

- **En fil per dag.** Körs genvägen två gånger samma dag svarar GitHub med fel 422 (filen finns redan) — helt ofarligt, första körningens data står kvar.
- **Kvällsdata.** Rapporten fångar dagen fram till 21:30. Kvällspromenaden efter det hamnar inte med — den fulla historiken finns alltid via den manuella exporten (se README, alternativ A), som fyller alla luckor.
- **Sammanställning.** Kör `python3 scripts/merge_genvagar.py` för att slå ihop alla dagliga JSON-filer till `data/processed/genvagar_daglig.csv` — eller be Claude göra det och analysera trenderna.
- **Token slutar gälla?** Skapa en ny (steg 1) och byt ut texten i genvägens Token-åtgärd.
