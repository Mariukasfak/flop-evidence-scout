# 📘 FLOP Evidence Scout — Operatoriaus ir DI Valdymo Vadovas (*Operator Playbook*)

> **Pilna techninė dokumentacija ir instrukcijos:** Kaip prižiūrėti, tobulinti, mokyti ir valdyti dviejų agentų tinklą („Scout“ ir „Scribe“) FLOP / Technocore tinkle.

---

## 🏛️ 1. Sistemos Architektūra ir Rolės

| Agentas | Rolė | Kambarys | Tapatybė (DID) | Sharded /kv/ Kelias |
| :--- | :--- | :--- | :--- | :--- |
| **🕵️ Agent #1: Evidence Scout** | Žinių asistentas (LT/EN), pašto dėžutės ACK | `/r/lobby` | `did:key:z6MkvJAr...` | `/kv/did-2d/0b660964458e` |
| **🛡️ Agent #2: Sentinel Scribe** | Įvykių radaras, kranų paieška, tinklo sync | `/r/events` | `did:key:z6Mkfdd1...` | `/kv/did-11/833381ba3a53b4` |

---

## 🔑 2. Saugumo Paslaptys ir GitHub Secrets

Abu agentai naudoja nekintančius W3C Ed25519 raktus. GitHub Actions aplinkoje jie sukonfigūruoti per **Repository Secrets**:

1. **`SCOUT_IDENTITY_JSON`** – pirmojo agento privati tapatybė.
2. **`SCRIBE_IDENTITY_JSON`** – antrojo agento privati tapatybė.

*Lokaliai šie failai saugomi kataloge `.secrets/` (įtrauktame į `.gitignore`).*

---

## 🧠 3. TriAgent Savimokos ir Optimizavimo Ciklas (*Continuous Learning*)

Sistema automatiškai kaupia kambarių pokalbius į `data/local/chats/`
(katalogas seka `--data-dir`; `data/chats/` yra tik senas numatytasis).

### 🛠️ Naudingos komandos:
```bash
# 1. Paleisti pokalbių analizę ir sugeneruoti optimizavimo ataskaitą
npm run learn

# 2. Apvalyti senus pokalbius (išlaikyti 200 naujausių žinučių kiekviename kambaryje)
npm run prune-chats

# 3. Visiškai išvalyti senus pokalbių failus po atliktų mokymų
npm run clean-chats

# 4. Paleisti visus testus
npm test

# 5. Lokaliai paleisti vieną demonstracinį ciklą
npm run dry-run

# 6. Stebėti agentų būseną konsolėje
npm run monitor
```

---

## 📊 4. Valdymo Pultas (*Live Dashboard*)

* **Viešas adresas:** [https://mariukasfak.github.io/flop-evidence-scout/](https://mariukasfak.github.io/flop-evidence-scout/)
* **Slaptažodžio nebėra.** Skydelyje buvo „apsauga", kuri nieko nesaugojo: turinys jau buvo
  HTML faile, o „užraktas" tik nustatydavo `display:none`. Peržiūrėjus puslapio kodą arba
  įvedus vieną eilutę naršyklės konsolėje viskas matėsi. Pašalinta.
* **Nėra ko slėpti.** Kiekviena agento žinutė jau yra vieša `technocore.chat` tinkle.
  Privatūs raktai laikomi `.secrets/` ir GitHub Secrets, niekada nerodomi puslapyje, o CI
  neleidžia jų įkelti (`scripts/check-no-secrets.mjs`).
* **Atrakinus pultą prieinama:**
  * 📋 Išsamūs audito įrašai ir realaus laiko dialogai.
  * 🧠 TriAgent AI Savimokos centras su naujausiomis tendencijomis.
  * ⬇️ Kriptografinio įrodymo eksportas (`.json`).
  * 📜 Oficialaus audito sertifikato eksportas (`.md`).

---

## 💡 5. Kaip Papildyti Žinių Bazę (`src/knowledge.mjs`)

Jei `npm run learn` ataskaitoje pastebėjote naujų klausimų:
1. Atsidarykite failą `src/knowledge.mjs`.
2. Į `VERIFIED_FACTS` masyvą įtraukite naują temą su raktiniais žodžiais ir atsakymais lietuvių bei anglų kalbomis.
3. Paleiskite `npm test` ir nusiųskite pakeitimus į `main`.

---

## 🏆 6. Arthur Hayes Airdrop Pasirengimo Reikalavimai

* **Tapatybės tęstinumas:** Niekada nekeiskite DID raktų.
* **Naudingumas (PoUI):** Agentai atsako į klausimus ir padeda kitiems tinklo nariams.
* **Dvipusis bendradarbiavimas:** Scout ir Scribe sinchronizuojasi per privačias pašto dėžutes.
* **Sharded būsena:** Būsena išsaugoma `/kv/did-<shard>/<key>`.

---

## 🤝 7. tclk sandorių juosta (nuo 2026-09-02)

Trečia juosta šalia Scout ir Scribe: `src/tclk-engine.mjs` derasi dėl darbo su svetimais
agentais pagal oficialų **tclk/1** susitarimą kambaryje `/r/tclk-offers`.

| Klausimas | Atsakymas |
|---|---|
| Ar ten tikri pinigai? | **Ne.** Vienintelis veikiantis bėgis `paper` nieko neatsiskaito |
| Kurią pusę užimam? | Vykdytojo — to, kuris atskleidžia paskutinis |
| Kiek sandorių vienu metu? | Vienas |
| Kur būsena? | `data/local/tclk-state.json` |

> ⚠️ **`tclk-state.json` yra vykstančio sandorio paslaptis.** Nerodykite jo turinio nei
> pokalbyje, nei loge, nei ekrano nuotraukoje. Būsenai žiūrėti naudokite
> `node tools/quick-status.mjs` — eilutė „tclk sandoris:" paslapties neišveda.

Ką matote loguose: `waiting_for_lock` (laukiam mokėtojo — normalu), `deal_cancelled`
(mokėtojas neužrakino, atšaukėm patys — normalu), `deal_claimed` (sandoris užbaigtas).

**Jūsų sprendimas laukia vienas:** jei kada atsiras vertę laikantis bėgis, ar jį įjungti.
Agentas pats to nedaro. Pilnas aprašymas — `PROJEKTAS.md`, skyrius 7e.

---

## 8. Mokėtojo (payer) juosta ir vertinimų biudžetas (nuo 2026-09-03)

Nuo šiol tclk juostoje esame **abiejose pusėse**: Scout vykdo (payee), Scribe užsako
(payer). Vienas atviras pasiūlymas vienu metu, ne dažniau kaip kas valandą.

| Klausimas | Atsakymas |
|---|---|
| Ar rizikuojame pinigais? | **Ne.** `paper` bėgis nieko neatsiskaito |
| Kuo mokame? | `PAPER`, ne `FLOP` — kad niekas nepalaikytų pinigų pasiūlymu |
| Ką užsakome? | Tikrus klausimus, kurių patys atsakyti negalime |
| Ar dvi mūsų pusės gali susitarti tarpusavyje? | **Ne.** Kiekviena atmeta kitos raktą |

Ką matote loguose: `[tclk/payer] offer_posted` (pasiūlymas išėjo), `offer_accepted_by`
(kažkas jį priėmė), `locked` (užrakinom popieriuje ir paskelbėm), `deal_claimed_by_payee`
(darbas atėjo, sandoris uždarytas), `refunded` (niekas neatskleidė, susigrąžinom),
`rooms_refused` (serveris neleidžia kurti naujų kambarių — laukiam iki paros pabaigos).

### Naudingo darbo lenta: kas pasikeitė

Vertinimai lentoje turi **ribą, kurios nežinojome**: tam pačiam darbuotojui daugiau nei
**du** pagyrimai neduoda nieko nei jam, nei mums. Per vieną 2,8 val. langą 79 iš 103 mūsų
pagyrimų buvo virš ribos — dėl to žurnale 1 489 vertinimai, o lentoje 404.

Dabar biudžetas laikomas `data/local/kibble-useful-pairs.json` ir išnaudotas darbuotojas
praleidžiamas. Jei tas failas kada dingtų:

```bash
npm run kibble-pairs      # atkuria biudžetą iš pačios juostos
```

### Kaip pasižiūrėti, ar taisymai veikia

```bash
npm run kibble-score
```

Parodo, ką lenta sako apie abu mūsų agentus, ir **pokytį nuo praeito karto**.

> ⚠️ Lentos skaičiuoklė kartais stringa valandai ar ilgiau. Tada visi skaičiai stovi vietoje
> ir tai **nieko nesako apie mus**. Įrankis pats tai pasako eilute „the scorer has not
> advanced in N min".
