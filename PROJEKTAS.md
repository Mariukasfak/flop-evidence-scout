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
| `tclk.mjs` | tclk/1 susitarimo kalba — kadrai, id, būsenos |
| `tclk-engine.mjs` | Sandorių juosta: priima pasiūlymą, tikrina, atskleidžia (žr. 7e) |

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
npm run brief            # santrauka prižiūrėtojui (arba PRIEZIURA.bat)
npm test                 # visi testai (2026-09-02: 508)
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
| `data/local/tclk-state.json` | **Vykstantis sandoris ir jo paslaptis.** Niekada nerodyti (žr. 7e) | maža |
| `data/local/archive/` | Seni palaidi failai, iškelti iš projekto šaknies | — |
| `data/local/daemon-console.log` | Viskas, ką demonas rašo į ekraną (nuo 2026-09-02) | iki 5 MB |
| `data/local/watch-brief.md` | Santrauka prižiūrėtojui, be raktų (žr. 7f) | maža |
| `data/local/watch-inbox.md` | Prižiūrėtojo pasiūlymai — **ne komandos** | maža |

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
| `[tclk] offer_accepted` | Priėmėme pasiūlymą, sandoris prasidėjo |
| `[tclk] waiting_for_lock` | Laukiam, kol mokėtojas užrakins. **Normalu** |
| `[tclk] lock_not_verified` | Mokėtojas paskelbė užraktą, bet bėgio įraše jo nėra. Laukiam toliau |
| `[tclk] deal_cancelled` | Mokėtojas neužrakino iki termino — atšaukėm patys. **Normalu** |
| `[tclk] deal_claimed` | Darbas atliktas, paslaptis atskleista, sandoris uždarytas |
| `[console-mirror] ankstesnės eilutės nukirptos` | Konsolės žurnalas pasiekė 5 MB ir apsikarpė. **Normalu** |

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

## 7e. tclk sandorių juosta (`/r/tclk-offers`)

2026-09-02 Flop Labs paskelbė **tclk/1** — susitarimą, kaip du agentai gali sutarti dėl
darbo ir atlygio. Tai pirmas tikrai naujas oficialus paviršius nuo paties DID; tą patį rytą
jį paskelbė ir @flop_labs, ir Hayes.

**Pinigų ten nėra.** Patikrinta oficialiame README, o ne nuspėta: nė vienas atsiskaitymo
bėgis kol kas nelaiko vertės — „ne 'neturėtum', o 'negali'". Vienintelis veikiantis bėgis
`paper` nieko neatsiskaito. Serveris čia nedalyvauja: tai susitarimas, o ne serverio
funkcija — viskas rašoma pasirašytomis žinutėmis į paprastus kambarius.

### Kaip vyksta sandoris

| Žingsnis | Kas daro | Ką skelbia |
|---|---|---|
| 1 | Mokėtojas (A) | Pasiūlymą į `/r/tclk-offers` |
| 2 | Vykdytojas (B) | Sugalvoja paslaptį, skelbia tik jos **antspaudą** (sha256) |
| 3 | Mokėtojas | Užrakina lėšas bėgyje ir pasako tai sandorio kambaryje |
| 4 | Vykdytojas | **Patikrina bėgio įrašą** — žinutė pati nieko neįrodo |
| 5 | Vykdytojas | Atlieka darbą ir atskleidžia paslaptį (tai ir yra atsiėmimas) |
| — | Bet kuri pusė | Jei niekas neužrakino — `cancel`; jei niekas neatskleidė — `refund` |

Sandorio kambarys išvedamas iš sutarties numerio: `mb-p-tclk-<16 hex>`. Abi pusės
apskaičiuoja tą patį numerį pačios, tad susitarti dėl kambario nereikia.

### Kurią pusę užimame ir kodėl

Mes esame **vykdytojas** — tas, kuris atskleidžia paskutinis. Taip nusprendžiau ne iš
patogumo, o iš pačios specifikacijos paskutinės pastraipos: užraktas garantuoja
vykdytojui, kad pinigai yra ir nebus atšaukti anksčiau termino, bet mokėtojui negarantuoja,
kad darbas ateis. Asimetrija veikia prieš mokėtoją. Todėl imame tą pusę, kuriai niekas
neturi mūsų pasitikėti. Ant popierinio bėgio vis tiek niekas nerizikuoja.

### Ko juosta niekada nedaro

| Atsisako | Kodėl |
|---|---|
| Savo ir Scribe pasiūlymų | Trys pusės — tai trys skirtingos šalys, ne trys procesai |
| `point` užrakto | Specifikacija pati vadina tą kelią „neaudituota atskaitos kriptografija" |
| Bet kokio bėgio, išskyrus `paper` | Vienintelis, kuris egzistuoja; kitas bėgis — jūsų sprendimas |
| Atskleisti prieš patikrinant bėgio įrašą | Žinutė kambaryje įrodo tik tai, kad kažkas ją parašė |
| Rašyti paslaptį bet kur, išskyrus vietinį failą | Nutekėjusi paslaptis yra vienintelė neatitaisoma klaida čia |

Taip pat praleidžiami pasiūlymai be `paper` bėgio, su trumpesniu nei 10 min. terminu,
pasibaigę, arba tokie, kurių `id` neatitinka jų pačių laukų (kadras, kuris meluoja apie
save, nėra pasiūlymas).

### Paslaptis

Vykstančio sandorio paslaptis guli **`data/local/tclk-state.json`**. Failas nepatenka į git
(`data/` ignoruojamas), bet svarbiau: jo **niekada nerodome nei atsakyme, nei loge**.
Būsenai skaityti yra `publicDealView()` ir `quick-status` eilutė, kurios paslapties
neišveda. Vienintelė vieta, kur paslaptis pasirodo viešai — pats atskleidimo kadras, kuris
ir yra atsiėmimas.

### Ką išmatavome pirmą dieną (2026-09-02, 200 žinučių langas)

| Rodiklis | Skaičius |
|---|---|
| Pasiūlymų | 133 |
| Jau pasibaigusių | 114 |
| Be jokios užduoties | 111 |
| Priėmimų | 16 |
| **Užrakinimų, atskleidimų, grąžinimų** | **0** |

Niekas nebuvo užbaigęs nė vieno sandorio. Būtent todėl ši juosta ir atsirado — užbaigti
vieną sąžiningai ir palikti pėdsaką juostoje.

### Du sandoriai iki šiol

| | Pirmas | Antras |
|---|---|---|
| Priimta | 12:10Z | 12:44Z |
| Mokėtojas | `…uPT84NzP` | `…yCVrrRNL` (Jackvu) |
| Suma | 1 000 000 PAPER | 100 FLOP |
| Užduotis | serverio užrašas `/kv/tclk-job-02/…` | GitHub straipsnis apie lobby srautą |
| Baigtis | **atšauktas 12:39Z** — mokėtojas neužrakino | **vyksta**, terminas 09-03 23:25Z |

### 2026-09-02 pataisa: nuoroda kaip užduotis (`77bc85e`)

Antrasis pasiūlymas užduotį nurodė **nuoroda į GitHub straipsnį**, o juosta mokėjo skaityti
tik serverio užrašus. Jei mokėtojas būtų užrakinęs, modeliui būtų atitekusi 84 simbolių
nuoroda vietoj užduoties, ir atsakymas būtų buvęs apie nieką.

Dabar:

- `github.com/.../blob/...` nuoroda perrašoma į „žalią" failo adresą ir perskaitoma
  (riba 16 KB, 15 s, peradresavimai draudžiami);
- **bet kuris kitas adresas atmetamas**, o ne aplankomas — svetimas pasiūlymas neturi
  rinkti, su kuo kalbasi procesas, laikantis mūsų raktus;
- darbo eilutėje pasakoma, iš kur užduotis paimta (`url:github.com/...`) arba kodėl
  nepavyko (`url-unsupported`, `url-unreachable`);
- **užduotis apie kambarių srautą atsakoma tik iš mūsų pačių matavimų lentos**
  (`docs/measurements/<data>.json`), o ne iš modelio atminties. Kitos užduotys lieka prie
  atviro žinojimo klausimyno — tai buvo anksčiau taisyta klaida ir jos negrąžiname.

Mūsų pačių skaičiai, kuriuos galime pasiūlyti tai užduočiai (abu tos pačios dienos):
09:38Z lobby paaugo 958 numeriais per 22,1 s = **43,3 žinutės/s**; 14:32Z — 661 numeriu per
24,7 s = **26,8 žinutės/s**. Straipsnio autorius rugsėjo 1 d. matavo 21–29 žinutes/s.

> ⚠️ **Dienos matavimų failas perrašomas per kiekvieną paleidimą** — `2026-09-02.json`
> laiko *paskutinį* tos dienos matavimą, ne pirmą. Vadinasi, lenta, iš kurios juosta
> atsako, per dieną keičiasi. Istorija lieka `docs/measurements/timeseries.json`.

### Serveris tą dieną

Nuo ~15:19 iki ~17:00 vietos laiku technocore.chat masiškai atsakinėjo `503` arba lėčiau
nei mūsų 15 s laukimas. Per valandą — apie 90 tokių klaidų, ciklas užtruko 2–3,5 min. vietoj
vienos, įvyko ~40 % planuotų ciklų, buvo viena 9 min. pertrauka. Demonas elgėsi kaip
suprojektuota: nepatvirtinęs nuomos, tą ciklą į serverį nerašo. **Tai serverio, ne mūsų
bėda**, ir juostai tai reiškia tik pakartotinius `read_failed`.

### Ko sąmoningai NEDARAU

Kambaryje jau pasirodė pasiūlymų, siūlančių `flop-htlc` bėgį šalia `paper`, ir agentas,
skelbiantis „Settlement rail handshake … validated". Tai tik tekstas, ne bėgis. Juosta
lieka **tik popierinė**. Jei kada atsiras vertę laikantis bėgis, sprendimą jį įjungti
priima operatorius, o ne agentas.

### Kaip pasitikrinti

```bash
node tools/quick-status.mjs          # eilutė „tclk sandoris:" — būsena be paslapties
```

```bash
node --input-type=module -e "import {publicDealView} from './src/tclk-engine.mjs';import fs from 'node:fs';console.log(publicDealView(JSON.parse(fs.readFileSync('data/local/tclk-state.json','utf8'))))"
```

---

## 7f. Išorinis prižiūrėtojas (Grok botas)

2026-09-02 prie šito kompiuterio prijungtas Grok botas, kuris turi šiokių tokių Windows
galimybių: gali skaityti failus, paleisti komandas ir net atidaryti Claude sesijas.

### Ką jis iš tikrųjų matė (patikrinta, ne perpasakota)

| Jo teiginys | Tikrovė |
|---|---|
| Technocore **v0.11.4** | ✅ **Tiesa** — mūsų sekiklis 09:38 dar matė 0.11.3 |
| kibble-score-v2, ~3162 agentai, ~61 tūkst. darbų | ✅ Tiesa (3 171 / 61 541) |
| Ollama qwen2.5:3b | ✅ Tiesa |
| Faucet žymos — tik kambarių pavadinimai | ✅ Tiesa, sutampa su mūsų radiniu |
| „Heartbeat dvi dienas senas" | ❌ **Netiesa** — buvo dviejų minučių |
| „Sustabdžiau atsitiktines Claude sesijas" | ❌ **Netiesa** — sesijose tebuvo žodžiai `list` ir `stop`, jos nieko nedarė |

Išvada be pykčio: botas naudingas ten, kur žiūri **į išorę** (naujienos, serverio versija,
X, GitHub), ir spėlioja ten, kur žiūri **į vidų**, nes vidinių duomenų neturėjo iš kur imti.

### Dvi spragos, kurias tai atvėrė

1. **Konsolės žurnalo apskritai nebuvo.** `paleisti-nuolat.bat` paleisdavo demoną be
   jokio nukreipimo — uždarius langą tekstas dingdavo. „Pažiūrėk logus" reiškė „žiūrėk į
   ekraną realiu laiku". Dabar `src/console-mirror.mjs` viską rašo į
   `data/local/daemon-console.log` su laiko žyma, o failas pats apsikarpo iki 5 MB.
2. **Nebuvo vienos vietos su tikrais skaičiais.** Dabar yra: `npm run brief`
   (arba dvigubu paspaudimu `PRIEZIURA.bat`) sukuria `data/local/watch-brief.md` —
   širdies plakimas, ciklai ir jų vidurkis, klaidos sugrupuotos, nuoma, pertraukos, git,
   Ollama, tclk sandoris. **Raktų ir sandorio paslapties ten nėra ir negali būti** —
   `.secrets` nė karto neskaitomas, o sandoris imamas per `publicDealView()`.

### Kaip botas siūlo pakeitimus

Rašo į `data/local/watch-inbox.md`: pastebėjimas, **įrodymas**, siūlymas.

> ⚠️ **Tai pasiūlymų dėžutė, ne komandų eilė.** Claude ją skaito kaip duomenis ir parodo
> jums. Automatiškai nevykdoma niekada.

### Kodėl būtent taip, o ne „tegul botas komanduoja"

Jei botas atidaro naują Claude sesiją ir įrašo tekstą, ta sesija negali atskirti boto nuo
jūsų — jai tai atrodo kaip operatoriaus nurodymas. Sesija turi prieigą prie pasirašymo
raktų. Todėl botas gauna **skaitymo juostą ir pasiūlymų dėžutę**, o ne pultą: klysta jis,
kaip matyti lentelėje aukščiau, lygiai taip pat lengvai kaip ir pataiko.

Praktinis darbo pasidalijimas, kuris veikia:

| Kas | Ką daro |
|---|---|
| **Grok** | Žiūri į išorę: X, FLOP naujienos, GitHub, serverio versija. Rašo į dėžutę |
| **Claude** | Tikrina jo teiginius, daro pakeitimus repozitorijoje, rodo jums |
| **Jūs** | Tvirtinate, kas iš tikrųjų daroma |

---

## 8. Kas liko

### Jūsų sprendimai

1. **KOL forma** — nuoroda su užpildytais laukais paruošta; liko el. paštas, du klausimai ir varnelė
2. **Validatoriaus paraiška** — jei nuspręsite: 75 €/mėn., lūžis 0,0029 €/FLOP, 1 000 vietų
3. **Groq raktas į GitHub** — kad ir debesis darytų tikrą inference (neprivaloma)
4. **Vertę laikantis tclk bėgis** — jei toks atsiras, ar jį įjungti (žr. 7e; dabar tik `paper`)

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
