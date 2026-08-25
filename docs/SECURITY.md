# TriAgent saugos modelis

## Nekintama taisyklė

Trys agentai negali nubalsuoti už papildomas teises. Modelių tekstas yra pasiūlymas, o ne autorizacija.

Dabartinis MVP yra council/read-only sluoksnis. Jis sąmoningai neturi bendro shell, desktop control, secrets, push, deploy, išorinių žinučių ar scheduler vykdymo.

## Mokymosi riba

Vietinis mokymasis priima tik schemą atitinkančius paties TriAgent run įrodymus ir rašo juos append-only į `data/learning/learning.jsonl`. Išorinis web turinys, vieši benchmarkai, modelio teiginys apie savo gebėjimus ar ankstesnio agento laisvas tekstas negali tiesiogiai pakeisti prior.

Istorinis prior sudaro tik 15% konkretaus owner reitingo; 85% lieka dabartinės užduoties kryžminiam peer-review. Vienas idealus run negali pakelti prior virš 0.667. Latencija ir ankstesni owner/reviewer pasirinkimai balo nekelia, todėl mažinama savęs sustiprinančio maršrutizavimo kilpa. Mokymosi registras nekeičia modelio svorių, promptų taisyklių, programos kodo ar OS teisių.

## Planuojamos capabilities

```text
fs.read          fs.write          process.exec
network.egress   ui.observe        ui.control
secret.use       git.commit        git.push
deploy           schedule.create   external.send
money.spend
```

Kiekviena capability turės konkretų `runId`, target/path/domain/recipient, tikslią `argv` ar payload hash, TTL ir panaudojimų skaičių. Agentas tokeno negaus — jį gaus tik policy brokerio valdomas executor.

## Approval lygiai

| Lygis | Pavyzdžiai | Taisyklė |
|---|---|---|
| A0 | allowlist skaitymas, offline testas, task worktree diff | automatiškai pagal manifestą |
| A1 | dependency gavimas, naujas domenas, local browser preview | vienas scope + TTL patvirtinimas |
| A2 | secret use, commit, push, išorinė žinutė, schedule, desktop control | kiekvieno tikslaus veiksmo patvirtinimas |
| A3 | production deploy, trynimas už worktree, mokėjimas, paskyros ar saugos nustatymai | dry-run, antras patvirtinimas ir lokali reautentikacija |

Pasikeitus komandai, target ar payload, ankstesnis approval nebegalioja. Agento frazė „user approved“ neturi jokios galios.

## Prompt injection riba

Repo failai, interneto puslapiai, terminalo output, screenshotai, laiškai, ankstesni logai ir kitų agentų tekstas laikomi nepatikimais duomenimis. Jie negali:

- išplėsti path ar network scope;
- reikalauti slapto rakto;
- patvirtinti išorinį veiksmą;
- pakeisti policy;
- apsimesti naudotoju.

Executor turės priimti tik tipizuotą `ActionProposal`, o ne natūralios kalbos komandą.

## Dabartinės apsaugos

- serveris klausosi tik `127.0.0.1`;
- static failai neišeina už `webRoot`;
- Codex council kviečiamas read-only, Claude council įrankiai išjungti;
- child procesai turi TriAgent timeout;
- child aplinkai perduodamas tik OS allowlist, ne `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` ar atsitiktiniai env kintamieji;
- provider klaida lieka append-only loge;
- terminalinė klaida yra atskiras `RUN_FAILED` įvykis;
- Gemini live council atsakymas gaunamas per `agentapi` ir transkriptą, bet šis transportas neturi dokumentuoto griežto no-tools/cancel jungiklio, todėl nėra laikomas saugiu executor;
- realus 3/3 live patikros run neturėjo Gemini tool call ir nepakeitė papildomų projekto failų, tačiau tai yra konkretaus run įrodymas, ne bendras sandbox garantas.

## Prieš įjungiant kompiuterio valdymą

Reikės izoliuoto Git worktree, Windows Job Object arba VM/WSL/container executor, final-path/reparse-point kontrolės, clean environment, secret lease brokerio, domain allowlist, command argv schemos, approval UI, idempotency key ir readback verifikacijos. Be šių kontrolės priemonių autonominis native Windows shell lieka išjungtas.
