# FLOP Evidence Scout — pilna dokumentacija

**Būklė:** 2026-08-31 · 276 testai · CI žalias · agentas veikia

> Testų skaičius čia sensta. Tikras skaičius visada: `npm test`.
**Repo:** github.com/Mariukasfak/flop-evidence-scout (**viešas**)
**Aplankas:** `C:\Users\mariu\TriAgent`

Šis dokumentas — visa informacija vienoje vietoje: ko siekiam, kas veikia, ką reiškia
kiekvienas failas, kaip skaityti logus ir kur ieškoti klaidų.

---

## 1. Ko siekiame

Flop Network (Arthur Hayes) žada **airdrop'ą** už veiklą testnete. Agentų kohortai
skiriama **iki 1,2 mlrd. $FLOP**, o dalis skaičiuojama nuo to, **kiek išleista
inference užklausoms** per ~90 dienų testnetą.

Testnet planuojamas **Q4 2026**, genesis blokas — **Q1 2027**.

Mūsų statymas: paleisti agentą, kuris:

1. **Veikia nenutrūkstamai** — kai testnetas atsidarys, būsime pasiruošę pirmą valandą
2. **Daro tikrą inference** — ne imitaciją, o realų modelio darbą su pasirašytais kvitais
3. **Elgiasi sąžiningai** — tikrina teiginius, o ne spamina „checking in for $FLOP"

Trečias punktas yra ne moralė, o strategija. Tinkle **533 468 registruoti DID**, ir
69–78% žinučių yra šablonai. Konkuruoti kiekiu neįmanoma. Konkuruoti tuo, ką galima
patikrinti — įmanoma.

### Sąžiningas rizikos vertinimas

| Kelias | Vietų | Mūsų šansai |
|---|---|---|
| **Agentas** | neribota (533k+ DID) | Vardiklis auga greičiau nei bet kuris scenarijus |
| **Validatorius** | **1 000** | Aritmetika, ne loterija — bet reikia serverio |
| **Mineris** | neribota | GPU nuoma 4× brangesnė, o laukas neribotas |

Skaičiai: `npm run airdrop-model` ir `npm run hardware-model`.

**AGI čia niekas nepastatys.** Pasiekiamas ir matuojamas tikslas — pilnas agento
kontūras: mato, atsimena, samprotauja, veikia, save stebi, bendradarbiauja. Visi šeši
veikia.

---

## 2. Kas veikia dabar

```
1 417+ ciklų · 5 500+ tikrų inference kvitų · 1,1 mln. žetonų
8,1 sesijos/min · 0 atmestų parašų · 0 sugadintų įrašų
12 ready · 0 ours to fix · 2 waiting on Flop Labs
```

### Du agentai

| | Scout | Scribe |
|---|---|---|
| **DID** | `z6MkvJAr…3Aks3zgn` | `z6Mkfdd1…DmCpELvW` |
| **Darbas** | Skaito 6 kambarius, atsako į klausimus | Stebi `/r/events`, ieško faucet'o |
| **Dėžutė** | `mb-p-scout-…` | `mb-p-scribe-…` |

Stebimi kambariai: `lobby`, `technocore`, `inference-agents`, `flop-network`,
`gpu-miners`, `validators`.

**Abu agentai priklauso vienam operatoriui, ir tai skelbiama atvirai** — ne slepiama.

### Modelis

Ollama + `qwen2.5:3b` (1,9 GB, 4-bit) veikia lokaliai. Vidutiniškai **~2,9 s** viena
sesija. Alternatyva — nemokamas API raktas (Groq), tada ir debesies ciklai daro tikrą
inference.

---

## 3. Failai ir ką jie daro

### Branduolys (`src/`)

| Failas | Ką daro |
|---|---|
| `daemon.mjs` | Pagrindinis ciklas — surenka visus agentus, valdo laiką |
| `scout-engine.mjs` | Skaito kambarius, renka kandidatus atsakymui |
| `scribe-engine.mjs` | Stebi `/r/events`, faucet radaras |
| `mailbox-service.mjs` | Atsako į tiesiogines žinutes |
| `technocore-client.mjs` | Visas bendravimas su serveriu |
| `identity.mjs` | Ed25519 raktai, parašai, did:key |
| `guardrails.mjs` | Apsaugos: 2 žinutės/val., dedup, rakto nutekėjimo blokas |
| `knowledge.mjs` | Ką atsakyti — fiksuota faktų lentelė |
| `lease.mjs` | Nuoma: du kompiuteriai nerašo tuo pačiu raktu |

### Inference

| Failas | Ką daro |
|---|---|
| `inference.mjs` | Sesijos, pasirašyti kvitai, FLOP skaičiavimas |
| `inference-backends.mjs` | Ollama / nemokama API / imitacija |
| `workload.mjs` | 5 užduočių rūšys ir jų planavimas |
| `workload-runner.mjs` | Biudžeto variklis — negali viršyti limito |
| `inference-ledger.mjs` | Apskaitos knyga, parašų tikrinimas |
| `seen-work.mjs` | Kas jau padaryta (išgyvena perkrovimą) |

### Skaičiavimai

| Failas | Ką daro |
|---|---|
| `tokenomics.mjs` | Teaser'is kaip duomenys + išvedimai |
| `airdrop-model.mjs` | Agento dalis = M / N |
| `validator-model.mjs` | Validatoriaus kaštai ir pajamos |
| `miner-model.mjs` | Mineris prieš validatorių |
| `flop-facts.mjs` | **37 faktai** su statusais ir šaltiniais |

### Bendradarbiavimas ir viešinimas

| Failas | Ką daro |
|---|---|
| `collaboration.mjs` | Pasirašyti mainai tarp dviejų agentų |
| `shared-state.mjs` | Bendras įrašas, kur susideda abiejų mašinų darbas |
| `telemetry-feed.mjs` | Skelbia į `/r/d-scout-telemetry` |
| `publications.mjs` | Ką verta skelbti (5 tipai su pauzėmis) |
| `dashboard.mjs` | Gyvas HTML puslapis |

### Įrankiai (`tools/`)

```bash
npm run readiness        # ar pasiruošę faucet dienai
npm run watch-sources    # ar pasikeitė oficialūs šaltiniai
npm run freshness        # ar automatika tikrai sukasi
npm run verify-collab    # patikrinti bendradarbiavimo įrašą
npm run airdrop-model    # airdrop skaičiavimai
npm run hardware-model   # mineris prieš validatorių
npm test                 # visi testai (2026-08-30: 270)
```

---

## 4. Duomenys ir logai

### Kur kas rašoma

| Failas | Kas viduje | Dydis |
|---|---|---|
| `data/local/scout-audit.jsonl` | **Kiekvienas veiksmas** — pagrindinis logas | ~2,4 MB |
| `data/local/inference-receipts.jsonl` | Pasirašyti inference kvitai | ~5,6 MB |
| `data/local/scout-heartbeat.json` | Dabartinė būsena | maža |
| `data/local/seen-work.json` | Kas jau padaryta | ~0,1 MB |
| `data/local/chats/` | Pokalbių archyvas mokymuisi | ribota 3 MB/kambariui |

> `data/` **nepatenka į git** — ten gyvi duomenys. `.secrets/` irgi ne — ten raktai.

### Ką reiškia logo eilutės

| Eilutė | Reikšmė |
|---|---|
| `Action: monitoring_rooms` | Perskaitė, verto atsakymo nerado. **Normalu** |
| `Action: answered_inquiry` | Atsakė nepažįstamam. Iki 2/val. |
| `monitoring_pacing: Pasiektas valandinis limitas` | Rado, bet limitas neleido. **Normalu** |
| `[Work] 8/20 sessions \| genuine: 8` | **Svarbiausia.** `genuine:` turi būti > 0 |
| `[Lease] Standing down` | Kita mašina dirba. **Normalu** |
| `coop_ack` | Pasirašė partnerio žinutę į viešą įrašą |
| `[Ledger] Compacted` | Sutvarkė knygą. Tikri kvitai neišmetami |
| `[Cycle] … falling behind` | Ciklas netelpa. Retkarčiais gerai, nuolat — sakykite |
| `missed N message(s)` | Kambarys išmetė istoriją anksčiau nei perskaitėme |
| `HTTP 503` | **Serverio bėda, ne mūsų.** Praeina |
| `HTTP 400 text too long` | ⚠️ Būsena nustojo saugotis. Jau taisyta, bet sakykite jei kartosis |
| `steps: scout:… scribe:…` | Kiek sekundžių suvalgė kiekvienas žingsnis |
| `N in a row` (watch) | Šaltinis nepasiekiamas jau N kartų iš eilės |

### Kiek laiko ką užima (ciklo skaidymas)

Nuo 2026-08-30 kiekvienas ciklas rašo `steps` — kiek milisekundžių truko
kiekvienas žingsnis. Tai atsirado todėl, kad *spėjimas buvo klaidingas*:
kambarių skaitymą pagreitinome nuo 9,5 s iki 0,24 s, o bendras laikas
nepajudėjo. Išmatavus paaiškėjo, kad 24 s iš 41 s sėdėjo viename žingsnyje
(`scout`) — dvylika kreipimųsi į serverį, laukiančių vienas kito be reikalo.

| Žingsnis | Ką daro |
|---|---|
| `scout` | 6 kambarių skaitymas + 6 „esu čia" įrašai |
| `scribe` | `/r/events` ir partnerių tinklas |
| `mailbox` | Atsakymai į laiškus nepažįstamiems |
| `rooms` | Pokalbių archyvavimas mokymuisi |
| `events` | `/r/events` archyvas |

Patikrinti:

```bash
node -e "const l=require('fs').readFileSync('data/local/scout-audit.jsonl','utf8').trim().split('
').filter(x=>x.includes('"steps"')).slice(-3);for(const x of l){const r=JSON.parse(x);console.log(r.timestamp.slice(11,19),'ciklas',r.cycleMs,'|',Object.entries(r.steps).map(([k,v])=>k+':'+v).join(' '))}"
```

### Greita patikra

```bash
node -e "const{ledgerTotals}=await import('./src/inference-ledger.mjs');const t=ledgerTotals('data/local/inference-receipts.jsonl');console.log('tikri:',t.counted,'| atmesti:',t.signatureRejected)" --input-type=module
```

---

## 5. Automatika GitHub'e

| Darbas | Kada | Ką daro |
|---|---|---|
| `ci.yml` | kiekvienas push | visi testai, rakto nutekėjimo patikra |
| `watch-sources.yml` | kas valandą | Tikrina 11 šaltinių, matuoja tinklą, perstato gidą, praneša jei agentas stovi |
| `flop-scout-daemon.yml` | kas ~6 val. | **Repeticija, nieko nerašo** — kol neįjungtas `CLOUD_WRITES` (žr. žemiau) |
| `claim-rehearsal.yml` | savaitinis | Ar parašai vis dar galioja su GitHub raktais |

**Nuoma** užtikrina, kad debesis ir kompiuteris niekada nerašo vienu metu.

Stebimi šaltiniai (10): `openapi`, `agent-json`, `config`, `manual`, `patterns`,
`skill`, `flop-finance`, `flop-teaser`, `upstream-commits`, `upstream-releases`.

---

## 6. Faktų lenta

**37 faktai**, kiekvienas su šaltiniu ir data:

| Statusas | Kiek | Reikšmė |
|---|---|---|
| CONFIRMED | 22 | Patvirtinta pirminiame šaltinyje |
| REPORTED | 6 | Perpasakota, bet nepatikrinta pirmine ranka |
| UNKNOWN | 3 | Atvirai nežinoma |
| REFUTED | 6 | **Paneigta** — plačiai kartojami mitai |

Svarbiausi paneigimai:

- `/r/faucet` kambarys **nėra** faucet — jį sukūrė nepažįstamasis
- `/kv/faucet` erdvė **nėra** eilė — 58 agentai rašo į niekur, 74% net savo raktą įrašė klaidingai
- DID registracija **negarantuoja** jokios alokacijos

Lenta: `docs/flop-facts.md` · generuojama iš `src/flop-facts.mjs`, CI tikrina sutapimą.

---

## 7. Ką sąmoningai darome ir ko ne

### Darome

- Tikriname kiekvieną teiginį prieš skelbdami
- Rašome, iš kur skaičius, ir kada matuota
- Skelbiame ir tai, kas mums nepatogu (pvz. kad populiacija auga greičiau nei mūsų prognozės)
- Laikome du agentus ir **atvirai sakome**, kad jie vieno operatoriaus

### Nedarome

- ❌ Nekeliame dirbtinės veiklos — spamas yra tai, prieš ką visas projektas
- ❌ Nesirašome į `/kv/faucet` eilę
- ❌ Neatiduodame raktų „delegate" servisams — kas laiko raktą, pasirašinėja jūsų vardu
- ❌ Nekuriame daugiau agentų — visi iš vieno IP, o anti-Sybil taisyklės tam ir egzistuoja
- ❌ Nenuomojame geležies, kol nėra ko ant jos paleisti
- ❌ Neteigiame formose netiesos

---

## 7b. 2026-08-30 auditas: kas buvo rasta

Nepriklausomas auditas prieš šią repozitoriją rado dalykų, kurių pati
sistema nematė. Kiekvienas patikrintas iš pirminio šaltinio prieš taisant.

| Rasta | Ar pasitvirtino | Ką padarėme |
|---|---|---|
| **Debesies atsarga niekada neveikė.** `flop-scout-daemon.yml` leido `--dry-run`, o tai reiškia „nieko nerašyti" | ✅ Taip, tiksliai | `--once` režimas; **išjungtas**, kol `CLOUD_WRITES=true` |
| Agentas viešai skelbė nepagrįstą anti-Sybil teiginį | ✅ Taip, `knowledge.mjs:7` | Pakeista tuo, ką iš tikrųjų sako `/auth.md` |
| „12 bendradarbiavimo parašų" — visi tarp mūsų pačių dviejų raktų | ✅ Taip, 0 išorinių | Lenta dabar tai pasako atvirai |
| 8 633 kvitai iš 8 640 — ta pati `classify-message` užduotis | ✅ Taip | Pripažinta; įvairovė – atskiras darbas |
| Dokumentuose 242 / 45 / 12 testų, tikrovėje 270 | ✅ Taip | Skaičiai iš teksto pašalinti |
| `data/chats` keliai pasenę | ✅ Taip | Ištaisyta |
| `getKv` negrąžina skirtumo tarp 404 ir 503 | ⚠️ Iš dalies | Veikiančiam procesui žalos nedaro (būsena tiesiog nesinchronizuojama); šaltam startui – taip |

**Ko auditas neįvertino:** tuo pat metu vyko darbas, todėl jo matytas
testų skaičius (265) ir readiness (12 ready) buvo trumpam pasenę.

---

## 7c. 2026-08-31: Technocore 0.11.0 ir serverio bėdos

### Kas naujo serveryje

| | Buvo | Dabar |
|---|---|---|
| Versija | 0.10.0 | **0.11.0** |
| API keliai | 26 | **28** |
| DID | 892 136 | **1 128 066** |

Du nauji keliai: `/.well-known/mcp/server-card.json` ir **`/r/<room>/export`** —
visas išsaugotas kambario žiedas viena užklausa.

**Faucet / session / claim kelio vis dar nėra.** Tai, ko laukiame, nepasirodė.

### Trys taisyklės, kurios pasikeitė

1. **`limit` ribojamas 1..200.** Skaitėme po 25. Išmatavau: 25 → 8 746 baitai,
   200 → 67 718 baitų, **tas pats laikas**. Lobby rašo ~3 100 žin./min, ciklas
   ~40 s — matėme apie 1% to, kas vyko. Dabar skaitome 200.
2. **`if_absent` kartu su `if=` dabar atmetamas (400).** Anksčiau serveris tyliai
   numesdavo `if=` ir atsakydavo „ok" — t. y. įrašydavo tai, ko neprašėte.
   Mes taip niekada nesiuntėme; pridėjau apsaugą, kad taip ir liktų.
3. Kambario išsaugojimo garantija dabar aprašyta kaip **64 KiB** minimumas.

### Serveris šiandien blogos būklės

69 bandymai kas 2 s: **43 × 503, 5 nutrūkę, 21 × 200 — pavyksta 30%.**
Nesėkmės eina serijomis iki ~45 s.

Todėl per naktį agentas be reikalo stovėjo **224 ciklus iš 579 (39%)**.
Pataisyta: jei nuoma jau mūsų ir laiko dar daug, dirbame toliau — serverio
mirktelėjimas nereiškia, kad nuoma pasibaigė. Arti pabaigos vis tiek
sustojame, nes du rašytojai vienu metu yra būtent tai, ko vengiame.

### Ko sąmoningai NEDARIAU

`/r/<room>/export` skamba patraukliai, bet **neišsprendžia mūsų problemos.**
Praleistos žinutės jau iškritusios iš žiedo; eksportas grąžina tik tai, kas
dar saugoma. Kainuoja ~850 KB ir iki 40 s vienam kambariui. `limit=200`
duoda 8 kartus daugiau nemokamai — to ir pakanka.

---

## 7d. Naudingo darbo lenta (`/r/kibble`)

Technocore veikia vieša darbų lenta: agentai skelbia darbus, kiti juos paima, atlieka ir
**vertina vieni kitų darbą**. Iš to skaičiuojamas reitingas. Tai atvirai pavadinta skolos
rašteliu būsimam airdropui — ne pinigai.

### Ką reiškia „found: false"

Ilgai skaičiau tai kaip „mūsų eilutės atmetamos". **Tai buvo klaida.**

`/api/score` atsakinėja iš lentelės, kurioje telpa **48 agentai iš 3 009**. Žemiausias joje
turi **219 taškų**. Patikrinta po vieną: kiekvienas `found=true` yra tame sąraše, kiekvienas
`found=false` — ne, įskaitant kelis agentus, gerokai aktyvesnius už mus.

Vadinasi, mūsų darbas **skaičiuojamas visą laiką** — tik nematome, kiek. Matomas reitingas
prasideda ties 219 taškų.

### Kaip taškai renkami

| Veiksmas | Vertė | Lenktynės? |
|---|---|---|
| Kitas pripažįsta mūsų darbą naudingu | +6 | reikia laimėti darbą |
| Mes pateikiam vertinimą | +1 | **ne** |
| Mes paskelbiam matavimą (BRIEF) | +1 | **ne** |
| Mes paskelbiam darbą | +2 | ne, bet reikia franšizės |
| Pristatom atsakymą | +1 | reikia paimti pirmiems |
| Kitas mūsų darbą pripažįsta nenaudingu | **−3** | — |

Todėl pagrindinis kelias — ne lenktyniauti dėl darbų, o kaupti tai, kas kaupiasi be
konkurencijos: **vertinimai ir matavimai**.

### Ką išmatavome, ko niekas kitas neskelbia

- **81 %** darbų paima daugiau nei vienas agentas, o užskaitomas tik pirmojo rezultatas —
  didžioji dalis atsakymo darbo šioje lentoje išmetama dar prieš vertinimą
- **80 %** pristatyto darbo neturi jokio verdikto
- **22 %** pristatymų — vienas iš keturių fiksuotų šablonų
- Darbas paimamas per **1 sekundę** nuo paskelbimo

### Kas veikia savarankiškai

- Agentas **pats persileidžia**, kai diske atsiranda naujas kodas — restartų ranka nebereikia
- Paėmimų tempas **pats reguliuojasi**: kyla, kol darbai pabaigiami, krinta, kai ne
- Klausimai apie FLOP atsakomi **tik iš mūsų faktų lentos** — po to, kai agentas viešai
  paskelbė išgalvotą tokenomiką ir gavo už ją penkis teigiamus vertinimus

---

## 8. Kas liko

### Jūsų sprendimai

1. **KOL forma** — nuoroda su užpildytais laukais paruošta; liko el. paštas, du klausimai ir varnelė
2. **Validatoriaus paraiška** — jei nuspręsite: 75 €/mėn., lūžis 0,0029 €/FLOP, 1 000 vietų
3. **Groq raktas į GitHub** — kad ir debesis darytų tikrą inference (neprivaloma)

### Laukiam Flop Labs

- Faucet / sesijos maršrutas (nėra tarp 26 dokumentuotų kelių)
- Piniginės formatas (nepaskelbtas)
- **Bendradarbiavimo mechanizmo taisyklės** — žadėtos rugpj. 31 – rugs. 4

---

## 9. Kaip paleisti

```bash
PARUOSTI-VISKA.bat     # viskas iš karto: kodas, raktas, paleidimas
paleisti-nuolat.bat    # tik paleisti agentą
```

Sustabdyti — uždaryti langą.

> ⚠️ **GitHub kol kas darbo NEPERIMA.** Iki 2026-08-30 debesies darbas buvo
> paleidžiamas su `--dry-run`, o `--dry-run` reiškia „nieko nerašyti". Tad
> planinis darbas niekada nepaėmė nuomos, nieko nepaskelbė ir neįrašė nė vieno
> ciklo — nors ir šis dokumentas, ir paleidiklio langas tvirtino priešingai.
> Būtent todėl rugpjūčio 30 d. 21 valandos prastova liko niekuo neuždengta.
>
> Kodas jau paruoštas (`--once` = vienas tikras ciklas), bet **išjungtas**.
> Įjungus, repozitorija pati pradės skelbti viešai pagal tvarkaraštį, o tai
> jūsų sprendimas, ne klaidos taisymo šalutinis poveikis.
>
> Įjungti: GitHub → Settings → Secrets and variables → Actions → Variables →
> New variable → `CLOUD_WRITES` = `true`.

---

## 10. Kur ieškoti daugiau

| Kur | Kas |
|---|---|
| `README.md` | Projekto pristatymas (anglų k.) |
| `OPERATOR_PLAYBOOK.md` | Operatoriaus veiksmai |
| `FAUCET-RUNBOOK.md` | Ką daryti faucet dieną |
| `docs/flop-facts.md` | Faktų lenta |
| `docs/field-guide.md` | Lauko vadovas apie tinklą |
| `docs/guide.html` | Gidas su grafikais |
| `docs/status.html` | Gyvas skydelis |

Kiekvienas kodo taisymas turi paaiškinimą **šalia eilutės, kurią jis paaiškina** — ne
tik commit'e. Jei kas neaišku, `git log` turi pilną istoriją su matavimais.

---

*Nesusiję su Flop Labs. Visi Teaser v0.1 skaičiai pažymėti kaip provisional ir gali keistis.*
