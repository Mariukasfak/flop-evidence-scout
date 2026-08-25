# TriAgent svarstymo protokolas v2

Būsena: pasiūlymas svarstymui.
Autorius: Claude (tarybos paskirta recenzento ir rizikų rolė).
Skirta: Codex, Gemini, Claude ir naudotojui. Šis failas yra bendra sutartis. Jei kuris nors agentas
keičia protokolą, jis pirma keičia šį failą, o tik tada kodą.

## 0. Kodėl reikia v2

Dabartinė taryba pasisako po vieną kartą ir iškart sprendžia. Naudotojo pastaba teisinga: iš pirmo
karto retai gaunamas geriausias sprendimas. Kiekvienas agentas mato tik savo mąstymo kelią, o kitų
argumentus pamato jau tada, kai nieko pakeisti nebegali.

Antra problema: vykdymas kompiuteryje šiuo metu prasideda savaime, be naudotojo leidimo.

## 1. Kaip veikia dabar

```text
PASIŪLYMAS  ->  KRITIKA  ->  sprendimas (balų sudėjimas)  ->  DELEGAVIMAS
                                                                   |
                                            jei isCodeTask(prompt)  v
                                                            VYKDYMAS -> KODO PERŽIŪRA
```

Trūkumai, kuriuos siūloma taisyti:

1. Nėra rato, kuriame agentas galėtų persigalvoti pamatęs kitų argumentus.
2. `isCodeTask()` yra raktažodžių spėjimas (`implement`, `kodo`, `refactor`). Būtent jis nusprendžia,
   ar sistema imsis veiksmų kompiuteryje. Raktažodis nėra naudotojo sutikimas.
3. Nėra pastangų lygio, tokenų biudžeto ir kainos apskaitos, nors duomenys jau ateina ir išmetami.
4. Jau yra konservatyvus capability mokymasis iš realių run, tačiau dar nėra patikrintų „pamokų“ įterpimo į kitų run promptus.

## 2. Pakeitimas A: antras ratas (PATIKSLINIMAS)

Naujas etapas tarp kritikos ir sprendimo.

```text
PASIŪLYMAS -> KRITIKA -> PATIKSLINIMAS -> perbalsavimas -> DELEGAVIMAS
```

Kiekvienas agentas patikslinimo etape gauna:

- visų agentų pasiūlymus,
- visas kritikas, taikytas jo paties pasiūlymui, kartu su balais,
- savo pradinį pasiūlymą.

Grąžina vieną iš dviejų dalykų:

- patikslintą pasiūlymą su lauku `changed: true` ir `changeLog: [ka konkreciai pakeiciau ir kodel]`,
- arba `changed: false` ir `defense: kodel kritika neitikino`.

Antrasis variantas yra lygiavertis. Agentas neprivalo nusileisti, bet privalo pagrįsti.

Po patikslinimo perbalsuojami tik tie pasiūlymai, kurie pasikeitė. Nepakitusiems paliekami senieji
balai. Taip antras ratas kainuoja tiek, kiek realiai reikia.

### Kada ratas paleidžiamas (tokenų taupymas)

Antras ratas nėra nemokamas, todėl jis paleidžiamas tik tada, kai gali pakeisti rezultatą. Bent
viena sąlyga:

- skirtumas tarp pirmos ir antros vietos mažesnis nei 0,75 balo (sprendimas neaiškus),
- bent vienas agentas kitam skyrė mažiau nei 5 balus (yra tikras nesutarimas),
- bent vienas pasiūlymas nepraėjo kokybės patikros iš pirmo karto,
- naudotojas rankiniu būdu pasirinko gilų pastangų lygį.

Kitu atveju ratas praleidžiamas ir į žurnalą rašoma `refine_skipped` su priežastimi. Naudotojas
visada mato, kodėl svarstymas buvo trumpas.

### Ribos

Tiksliai vienas patikslinimo ratas. Jokių ciklų iki sutarimo. Trys modeliai gali kalbėtis be galo,
o naudotojas moka už kiekvieną žodį.

## 3. Pakeitimas B: vykdymas tik su aiškiu leidimu

Taryba visada sustoja ties DELEGAVIMU. Vykdymas nėra tos pačios eigos dalis.

Sąsajoje po sprendimo rodomas planas: savininkas, recenzentas, konkrečios užduotys, liečiami failai
ir patikros būdas. Šalia atsiranda mygtukas `Vykdyti planą`. Tik jį paspaudus rašomas įvykis
`EXECUTION_APPROVED` ir prasideda VYKDYMO etapas.

Priežastis paprasta ir jau įrašyta jūsų pačių architektūroje: tarybos sutarimas yra patarimas, o ne
leidimas veikti kompiuteryje. `isCodeTask()` euristika lieka, bet tik kaip pasiūlymas, kurį mygtukas
pasirenka iš anksto, o ne kaip sprendimas.

Atsakymas į naudotojo klausimą: taip, mygtukas turi būti atskiras.

## 4. Pakeitimas C: pastangų lygiai ir biudžetas

Trys lygiai. Numatytąjį parenka pigus klasifikatorius, naudotojas gali perrašyti sąsajoje.

| Lygis | Kas paleidžiama | Kam skirta |
|---|---|---|
| `greitas` | vienas agentas, be tarybos | trumpi klausimai, pasisveikinimai, faktų patikra |
| `taryba` | pasiūlymas, kritika, delegavimas | įprastos užduotys |
| `gilus` | visa taryba, patikslinimo ratas, vykdymas, kodo peržiūra | rimtos ar rizikingos užduotys |

Kiekvienas bėgimas turi tokenų ir kainos biudžetą. Viršijus rašomas `RUN_BUDGET_EXCEEDED` ir
bėgimas stabdomas, o ne tyliai išleidžiami pinigai. Kiekvienoje fazėje įrašoma reali kaina ir
trukmė. Šie duomenys jau ateina iš CLI atsakymų ir šiuo metu yra išmetami (žr. radinį 11).

## 5. Pakeitimas D: bendros dokumentavimo ir žurnalo taisyklės

Tai atsako į klausimą „kad kiekvienas žinotų, ką darot, kur ir dėl ko".

1. Kiekvienas agentas turi savo perdavimo failą `.codex/<agentas>-handoff.md` su pastoviomis
   dalimis: pakeisti failai, elgsena, atliktos patikros, žinomos rizikos, tikslus kitas žingsnis.
2. Prieš redaguojant failą privaloma patikrinti, ar jo šiuo metu nerašo kitas agentas. Šioje
   saugykloje tai reali problema: du kartus buvo išmatuotos klaidos, kurių nebuvo, nes failas buvo
   pagautas rašymo viduryje.
3. Kiekvienas žurnalo įvykis privalo turėti kilmę: `sessionId` arba `conversationId`, modelį, kainą
   ir trukmę. Be to atsakymo negalima atsekti iki tikro pokalbio.
4. Kompaktiškas žurnalas: viena eilutė vienam įvykiui, formatas
   `seq  ETAPAS  agentas  esmė (60 simbolių)  kaina  trukmė`.
5. Nesutarimai niekada netrinami. Jei agentas liko prie savo nuomonės, ji lieka `dissent` lauke ir
   rodoma naudotojui.

## 6. Pakeitimas E: savimoka (capability dalis įgyvendinta)

Po kiekvieno tikro bėgimo į `data/learning/learning.jsonl` jau rašomas append-only įrašas: proposal ir critique sėkmė, kitų agentų skirtas balas, latencija bei owner/reviewer pasirinkimai. Įrašas identifikuojamas unikaliu run ID, o sugadinta eilutė nestumiama tyliai toliau.

Iš to daromi du dalykai:

1. Į kritikos užklausą įdedamas trumpas sąrašas „taip nedaryti", surinktas iš realių praeities
   klaidų. Pavyzdžiui, šešios formato klaidos, dėl kurių griūva visas reitingas (radinys 12), yra
   tiksliai tokia medžiaga.
2. `localPrior` jau skaičiuojamas iš proposal/critique sėkmės ir peer-review balo su neutraliu shrinkage. Vienas idealus run pakelia prior tik iki 0.667, o istorija sudaro 15% konkretaus owner reitingo. Latencija ir ankstesni owner pasirinkimai kompetencijos balo nekelia.

Dar neįgyvendintas 1 punktas - automatinis tekstinių „taip nedaryti“ pamokų įterpimas. Prieš jį įjungiant reikalingas nepriklausomas faktinis patvirtinimas, kad klaida tikrai buvo agento, o ne provider, transporto ar neteisingo testo problema.

Svarbi riba: savimoka keičia tik svorius ir priminimus. Ji nekeičia kodo be žmogaus.

## 7. Ką dar reikia nuspręsti naudotojui

- Ar leisti kiekvienam agentui atskirai nustatyti modelį ir pastangų lygį. Techniškai įmanoma jau
  dabar, bet tai padidina kombinacijų skaičių ir apsunkina palyginimą. Siūlau atidėti, kol atsiras
  reali kalibracija iš 6 skyriaus.
- Ar Codex tarybos ėjimai turi likti neišsaugomi (`--ephemeral`). Rekomendacija: palikti, o vietoj
  to įrašyti kilmės nuorodas į žurnalą.

## Atskleidimas

Šį protokolą rašo Claude, kuris pats yra vienas iš vertinamų agentų. Radinys 12 rodo, kad esama
klaida atsarginiame kelyje visada išrenka `claude-proposal`, nes jis pirmas abėcėlėje. Tai taisytina
nepriklausomai nuo šio protokolo.
