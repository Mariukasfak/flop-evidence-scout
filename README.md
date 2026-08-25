# TriAgent

TriAgent yra vietinis trijų AI agentų orkestratorius: atskiri išsaugomi pokalbiai, nuosekli kiekvienos temos istorija, nepriklausomi pasiūlymai, tarpusavio kritika, darbų paskyrimas ir compact log.

Tai nėra ketvirtas modelis. TriAgent yra valdymo sluoksnis, kuris kiekvienam modeliui perduoda tą patį patikrintą konteksto checkpoint ir išsaugo jų atsakymus vienoje atkuriamoje istorijoje.

## Kas jau veikia

- vietinė UI adresu `http://127.0.0.1:4317`;
- pokalbių kortelės ir „Naujas pokalbis“: kiekviena tema turi atskirą patvarią istoriją bei izoliuotą modelių kontekstą;
- pagrindiniame lange rodomas įprastas „Jūs ↔ TriAgent“ dialogas, o pasiūlymai, kritika, reitingas ir delegavimas lieka išskleidžiamame „Tarybos svarstymas“ audite;
- vienas užduoties įvedimo laukas su `/code` kodo kūrimo ir savitobulos režimu;
- tikras trijų agentų Live council be imitacinių provider;
- realūs Codex, Claude ir Gemini / Antigravity live council adapteriai;
- Gemini kaip greitas numatytasis dirigentas, bet visi trys gali būti proposer, critic, owner, reviewer ir worker;
- proposal → critique → Gemini moderuojama delegation → execution (`/code`) → code review → final protokolas;
- realaus laiko kvotų ir autorizacijos limitų sekimas (`QUOTA_STATUS`) su aiškiais statusais UI;
- vienoda svertinė rubrika ir draudimas vertinti savo pasiūlymą;
- append-only JSONL įvykių logas, replay ir SSE srautas;
- append-only mokymosi registras, kuris po kiekvieno tikro run kaupia patikimumą, peer-review balą ir greitį pagal užduoties klasę;
- konservatyvus adaptyvus reitingas: sukaupta istorija sudaro tik 15% owner balo, o dabartinės užduoties peer-review - 85%;
- provider gedimų ir limitų degraded mode su sklandžiu darbų perkėlimu;
- child procesų timeout ir išvalyta aplinka be API raktų;
- automatiniai branduolio, adapterių, HTTP ir UI contract testai.

## Paleidimas

Reikia Node.js 24 ar naujesnio.

```powershell
cd C:\Users\mariu\TriAgent
npm test
npm run build
npm start
```

Atidarykite `http://127.0.0.1:4317`.

TriAgent turi tik Live režimą: kiekviena užduotis realiai kviečia Codex, Claude ir Gemini, todėl naudoja visų trijų kvotas ir gali trukti kelias minutes. API atmeta bet kokį ne-Live režimą.

Ryšį galima patikrinti terminale paleidus:
```powershell
npm run check:connections
```
Diagnostika naudoja tuos pačius produkcinius adapterius ir siunčia po vieną tikrą proposal užklausą visiems trims. Jei Claude sesija pasibaigtų, terminale paleiskite `claude`, įvykdykite `/login` ir pakartokite patikrą.

## FLOP / Technocore Evidence Scout agentas

Projekte veikia autonominis agentas, integruotas į `https://technocore.chat`:
- **W3C DID tapatybė:** `did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn`
- **Kriptografinis pasirašymas:** Ed25519 parašai kiekviename check-in ir kambario atsakyme.
- **Ilgalaikė atmintis:** Būsena saugoma per `/kv/` notes.
- **Stebėsena:** `npm run scout:monitor` atidaro realaus laiko terminalo srautą.
- **24/7 debesis:** GitHub Actions `.github/workflows/flop-scout-daemon.yml` vykdo periodinius ciklus kas 15 min.

Komandos:
```bash
# Paleisti vietinį agentą tiesiogiai į technocore.chat:
npm run scout:live

# Atidaryti gyvą terminalo stebėjimo skydelį:
npm run scout:monitor

# Vienkartinė bandomoji patikra:
npm run scout -- --dry-run
```

## Patikrintas live rezultatas

2026-08-25 run `run-mt8fxwfs-3e0e8278e570` sukūrė pirmą realų mokymosi įrašą: Codex ir Gemini proposal pavyko, Claude proposal nepavyko, bet jo critique pavyko. Kitas run `run-mt8g4fjn-992147f7b4d0` panaudojo ankstesnius planning prior, užbaigė 3/3 proposal, 3/3 critique ir Gemini delegation, įrašė antrą patirtį bei baigė `degraded=false`. Abu paleidimai buvo pririšti prie Antigravity projekto `27a49571-a7a3-41c4-93e2-a82a20d0cd78`.

`cgw.ps1` lieka atskiras bounded coding worker transportas realiems failų pakeitimams su diff ir handoff patikra. Live council nuomonėms naudojamas projekto `tools/antigravity_council.py` bridge ir Antigravity JSONL transkriptas. Tai dvi skirtingos paskirtys, bet Gemini gali dalyvauti abiejose.

## Svarbi saugos riba

Modelių nuomonė ar trijų balsų sutarimas nėra leidimas vykdyti komandą, valdyti darbalaukį, naudoti secret, siųsti žinutę, kurti schedule, pushinti ar deployinti. Codex council yra read-only, Claude įrankiai išjungti. Dabartinis Antigravity `agentapi` neturi dokumentuoto griežto no-tools jungiklio, todėl Gemini council transportas dar nėra OS sandbox ir negali būti naudojamas neprižiūrimam kompiuterio valdymui. Vykdymo brokeris ir approval tokenai yra kitas etapas.

UI rodomi darbų paskyrimai kol kas yra planas, ne automatiškai įvykdyti darbai.

## Vietinis mokymasis

Po kiekvieno tikro run `data/learning/learning.jsonl` išsaugo kiekvieno agento proposal ir critique sėkmę, kitų agentų skirtą peer-review balą, bendrą atsako laiką bei owner/reviewer pasirinkimus. Kitas tos pačios klasės run gauna konservatyvius vietinius prior; jei tos klasės istorijos dar nėra, naudojama bendra TriAgent istorija.

Mokymasis naudoja tik paties TriAgent įvykius. Jis nesisiunčia viešų benchmarkų, nekeičia modelių svorių ir automatiškai neperrašo savo kodo. Owner/reviewer pasirinkimų skaičius bei greitis rodomi ataskaitoje, bet nekelia kompetencijos balo, todėl sistema pati nesukuria „visada laimi tas pats“ ciklo.

## Pokalbių istorija

Kiekvienas pokalbis saugomas atskirame append-only `data/chats/<chatId>.jsonl` faile. Pirmoji žinutė automatiškai suteikia kortelei temos pavadinimą. Tolesniam tos pačios temos atsakymui agentai gauna ribotą ankstesnių `user` ir `assistant` žinučių kontekstą; kito pokalbio žinutės į checkpoint nepatenka.

Pagrindiniai pokalbių API endpointai:

- `GET /api/chats`;
- `POST /api/chats`;
- `GET /api/chats/:chatId`;
- `POST /api/chats/:chatId/messages`;
- `GET /api/runs/:runId/stream` realaus laiko tarybos eigai.

Išsamiau:

- [Architektūra](docs/ARCHITECTURE.md)
- [Saugos modelis](docs/SECURITY.md)
- [Roadmap](docs/ROADMAP.md)

## Patikros

```powershell
npm run check
```

`npm run check` paleidžia visus testus ir build. Produkcinis deploy, commit ar push šiame MVP neatliekami.
