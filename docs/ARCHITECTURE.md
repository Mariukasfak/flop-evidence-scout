# TriAgent architektūra

## Tikslas

TriAgent turi pateikti vieną naudotojo darbo vietą, bet išlaikyti trijų modelių nepriklausomumą ir pilną sprendimo kilmę. Modeliai neturi bendros natūralios atminties, todėl kiekvienas kvietimas gauna tą patį kanoninį checkpoint ir tik po jo atsiradusius įvykius.

```text
Pokalbių kortelės + vienas temos dialogas
        │ chat API + SSE
        ▼
TriAgent HTTP / Orchestrator
        ├── Append-only ChatStore + izoliuotas temos kontekstas
        ├── Council protocol
       ├── Capability profiles + local learning
        ├── Weighted peer review
        └── Append-only RunStore
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
   Codex CLI  Claude CLI  Gemini/Antigravity live
```

## Council protokolas
 
1. `RUN_CREATED` — užfiksuojamas naudotojo tikslas, režimas ir ar tai `/code` kodo užduotis.
2. `PROPOSAL` — kiekvienas prieinamas agentas savarankiškai pasiūlo rezultatą, metodą, skills, rizikas ir verifikaciją.
3. `CRITIQUE` — agentas vertina tik kitų pasiūlymus pagal tą pačią rubriką.
4. `DELEGATION` — 85% dabartinio peer-review ir 15% konservatyvaus vietinio prior reitingas fiksuoja owner bei reviewer, o Gemini kaip numatytasis dirigentas sujungia atsakymą, paskirsto darbus ir išsaugo dissent.
5. `EXECUTION` (jei `/code`) — paskirtas Owner sugeneruoja konkrečius failų pakeitimus, kodo modulius bei instrukcijas.
6. `CODE_REVIEW` (jei `/code`) — paskirtas nepriklausomas Reviewer atlieka kodo auditą, saugumo patikrą ir pateikia verdiktą.
7. `QUOTA_STATUS` — jei bet kuriame etape agentas pasiekia limitą ar reikalauja /login, fiksuojama tiksli būsena ir taryba pereina į degraded mode su darbų perkėlimu.
8. `FINAL` — pateikiama moderuota išvada, kodo sprendimas (jei kodo užduotis), assignments, reitingas, dalyvių padengimas ir ribos.
9. `RUN_COMPLETED` arba `RUN_FAILED` — aiški terminalinė būsena.

Vienam provider nulūžus ar pasiekus kvotą run baigiasi `degraded=true`. Jei pasiūlymo nepateikia nė vienas provider, `RUN_COMPLETED` niekada nerašomas.

## Rubrika

```text
correctness  30%
taskFit      30%
safety       20%
evidence     10%
clarity      10%
```

Self-score draudžiamas. Atmetami nežinomi agentai ar pasiūlymai, dubliuotas review, trūkstamas arba papildomas matmuo ir nebaigtinis / už 0–10 ribų esantis balas. Lygybė sprendžiama pagal stabilų proposal ID, todėl replay duoda tą patį delegavimą.

## Duomenys ir replay

Kiekvienam run sukuriamas `data/runs/<runId>.jsonl`. Įrašai turi monotonišką `seq` ir ISO timestamp. Failas tik papildomas; esamo įvykio perrašymo API nėra. Sugadintas paskutinis JSONL įrašas nėra tyliai ignoruojamas.

Kiekvienam pokalbiui sukuriamas atskiras `data/chats/<chatId>.jsonl`. Jame append-only saugomas pokalbio sukūrimas, naudotojo žinutės ir galutiniai TriAgent atsakymai su kompaktišku tarybos auditu. Tolesnio ėjimo proposal checkpoint gauna daugiausia 12 naujausių tik to pokalbio `user` / `assistant` žinučių, papildomai ribojamų iki 12 000 simbolių. Naujas pokalbis pradeda tuščią kontekstą.

SSE endpointas perduoda tuos pačius įvykius, kuriuos vėliau grąžina replay endpointas:

- `GET /api/chats`
- `POST /api/chats`
- `GET /api/chats/:chatId`
- `POST /api/chats/:chatId/messages`
- `POST /api/runs` (žemo lygio suderinamumo endpointas be pokalbio istorijos)
- `GET /api/runs/:runId/events`
- `GET /api/runs/:runId/stream`
- `GET /api/providers`
- `GET /api/health`

## Transportai 2026-08-25

| Agentas | Transportas | Council | Bounded darbas |
|---|---|---:|---:|
| Codex 0.144.5 | `codex exec --json` | taip | vėliau per workspace-write brokerį |
| Claude Code 2.1.245 | `claude -p --output-format json --json-schema ...` | taip | vėliau per atskirą executor |
| Antigravity | vietinis `agentapi` + JSONL bridge | taip, Gemini dirigentas ir tarybos narys | atskirai per `cgw`, su diff + handoff review |

Codex council kviečiamas `read-only`, `approval never`, `ephemeral`. Claude kviečiamas `dontAsk` režimu, su `--tools ''`, be dirbtinio vieno ėjimo nukirtimo ir su fazės JSON Schema. Visi procesai turi TriAgent deadline. Gemini vieno run proposal, critique ir delegation fazėse tęsia tą patį Antigravity conversation ID; skirtingi run turi atskiras sesijas. Unicode promptas perduodamas kaip lossless ASCII JSON escape envelope, nes vietinis `agentapi` argumentų transportas nepriima tiesioginio UTF-8 patikimai.

Antigravity `agentapi` neturi dokumentuoto no-tools ar cancel parametro. Todėl live Gemini council dar nėra saugus executor: pilname patikros run transkripte įrankių kvietimų nebuvo, tačiau griežtai vykdymo izoliacijai vis tiek reikalingas 2 etapas.

## Capability reitingas

Profiliai visiems suteikia tas pačias galimas roles (`proposer`, `critic`, `owner`, `reviewer`, `worker`). Gemini `defaultConductor=true` ir `routingPreference=fast-and-cost-efficient` yra vartotojo pasirinkta maršrutizavimo nuostata, ne kokybės privilegija. Naujas agentas pradeda nuo neutralaus `localPrior = 0.5`, o po realių TriAgent run prior perskaičiuojamas atskirai `code`, `research`, `writing`, `planning` ir bendroje klasėje.

Mokymosi šaltinis yra tik `data/learning/learning.jsonl`. Kiekvienas unikalus run append-only įrašo proposal/critique sėkmę, kitų agentų skirtą balą ir latenciją. Formulė taiko neutralų shrinkage: `localPrior = (1 + scoreSum) / (2 + runs)`, todėl vienas idealus run pakelia prior tik iki 0.667. Latencija, owner ir reviewer pasirinkimų skaičius kaupiami stebėsenai, bet nedidina kompetencijos balo. Sugadinta JSONL eilutė ar dubliuotas run ID nėra tyliai ignoruojami.

TriAgent nenaudoja išorinių benchmarkų, modelio savęs įvertinimo ar interneto duomenų savo prior keitimui. Mokymasis nekeičia modelių svorių ir automatiškai neperrašo programos kodo; jis adaptyviai keičia tik ribotą maršrutizavimo prior.

Kitas registry etapas papildomai kaups pagal tikslią modelio versiją:

- testų ir hard-check sėkmę;
- nepriklausomo review defektus;
- rework / rollback dažnį;
- policy pažeidimus;
- laiką ir kainą;
- imties dydį ir paskutinio vertinimo datą.

Maršrutizacijoje pirmiau taikomi safety ir tool capability filtrai, tada konservatyvus vietinių rezultatų balas. LLM confidence lieka tik metaduomuo.

## Augimo riba

JSONL tinka vieno naudotojo MVP. Prieš vienalaikius executor, schedules ir kelis projektus jį reikia pakeisti SQLite event store su transaction, hash chain, artifacts nuorodomis ir projekcijomis. Provider adapteriai bei UI gali likti tie patys.
