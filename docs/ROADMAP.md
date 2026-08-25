# TriAgent roadmap

## 0 etapas — integration spike (baigta)

- [x] inventorizuoti Codex, Claude ir Antigravity transportus;
- [x] prijungti projektą prie realaus Antigravity project ID;
- [x] realiai deleguoti Gemini bounded branduolio darbą;
- [x] peržiūrėti diff, handoff ir testus;
- [x] užfiksuoti oficialių CLI ir prenumeratų ribas.

## 1 etapas — council MVP (ši versija)

- [x] vienas localhost chat laukas;
- [x] patvarios pokalbių kortelės, „Naujas pokalbis“ ir griežta skirtingų temų konteksto izoliacija;
- [x] nuoseklus „Jūs ↔ TriAgent“ dialogas su išskleidžiamu tarybos svarstymo auditu;
- [x] Codex, Claude ir Gemini live council adapteriai;
- [x] tikras trijų agentų Live council be imitacinių provider;
- [x] proposal, critique, delegation ir final protokolas;
- [x] append-only log, replay ir SSE;
- [x] provider health bei degraded mode;
- [x] iš neutralaus 0.5 startuojančios ir iš realių run atsinaujinančios capability kortelės;
- [x] testai, build ir browser-ready UI;
- [x] struktūruotas Antigravity live council adapteris su tęstine run sesija, timeout ir projekto logu;
- [x] realus Codex live council smoke test (`RUN_COMPLETED`, degraded mode);
- [x] realus 3/3 live council run su proposal, critique ir Gemini delegation;
- [x] TriAgent-only append-only mokymosi registras ir 15% adaptyvus maršrutizavimo prior;
- [ ] izoliuoti Gemini council transportą nuo Antigravity įrankių OS lygiu arba pereiti į oficialų text-only API.

## 2 etapas — saugus coding executor

- atskiras task manifestas ir path allowlist;
- vienas Git worktree kiekvienai vykdymo užduočiai;
- tipizuotos komandos vietoje laisvo shell;
- hard process-tree deadline ir cancel;
- owner įgyvendina, kito provider reviewer tikrina;
- `completed` tik po realaus test/build/diff įrodymo;
- vartotojo approval prieš commit, push ar network.

## 3 etapas — vietinis capability registry (pradėta)

- [x] task klasifikacija (`code`, `research`, `writing`, `planning`, `general`);
- [x] proposal/critique patikimumo, peer-review, latency ir owner/reviewer skaitikliai;
- [x] konservatyvus shrinkage ir bendros istorijos fallback;
- [ ] tikslios provider/model/toolchain versijos kiekviename įraše;
- vietiniai eval ir golden užduotys;
- test pass, review defect, rework, safety, latency ir cost metrikos;
- conservative lower confidence bound maršrutizavimas;
- modelio atnaujinimo drift ir senų balų mažėjimas;
- 15–20 realių užduočių A/B palyginimas su geriausiu vienu agentu.

## 4 etapas — asmeninis agentas

- patvirtinta ilgalaikė asmeninė atmintis;
- failų, naršyklės ir desktop capabilities po vieną;
- Windows Task Scheduler integracija su iš anksto patvirtintu manifestu;
- task inbox, prioritetai, checkpoint ir recovery;
- išorinės žinutės, secrets, cloud write ir deploy tik A2/A3 approval lygiu.

## Sėkmės vartai

TriAgent verta plėsti tik jei vietiniame A/B rinkinyje jis:

1. padidina patikrintų pirmo bandymo rezultatų dalį; arba
2. sumažina kritines klaidas; ir
3. papildoma trijų agentų kaina bei trukmė yra pagrįsta.

Jei council tik sukuria daugiau teksto, bet ne daugiau patikrintos kokybės, maršrutizavimas turi grįžti prie vieno geriausiai su konkrečia task klase susitvarkančio agento.
