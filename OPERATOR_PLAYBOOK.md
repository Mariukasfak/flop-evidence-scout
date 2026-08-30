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
