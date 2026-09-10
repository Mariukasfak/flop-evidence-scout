# TriAgent patikra ir tobulinimas - 2026-09-10

## Patikrinta aplinka

VPS tikrintas per esamą vietinio kompiuterio SSH raktą. Apie 06:40 UTC
`triagent` ir `ollama` buvo aktyvūs; agentas veikė nuo rugsėjo 9 d. 09:07 UTC.
Serverio HEAD buvo `537d534`, o proceso paleidimo įraše - `692a774`.
Skirtumas buvo tik generuojamuose dokumentuose; pats kodas buvo toks pat.

Per slenkantį 24 valandų langą: 212 TCLK priėmimų ir 212 nutraukimų, visi dėl
mokėtojo neužrakinimo per penkias minutes. Kai kuriuos mokėtojus priėmėme
po 2-3 kartus. Paskutinis istorijoje užbaigtas sandoris - rugsėjo 7 d. 10:43 UTC.
Saugoma tik 50 paskutinių nutraukimų, todėl tai ne visa istorija.

Modelio kvitų tame lange buvo 5 546: 252 `ollama: fetch failed`, 13 timeoutų,
6 API kvotos klaidos. Šie skaičiai apima vietinius bandymus, ne oficialų FLOP
atlygį. Vienu metu žurnale matyti daug momentinių nesėkmių: vykdytojas po pirmos
backend klaidos mėgino likusį planą. `ollama` taip pat periodiškai perkraunama
viršijus atminties ribą. Vien kvitų laikas neįrodo visų klaidų priežasties.

06:50 UTC Kibble lenta rodė Scout 95 balus / 308 vietą, Scribe 489 / 49.
Pokytis nuo ankstesnio įrašo buvo +62 ir +28, tačiau ankstesnis įrašas buvo
8 292 minučių senumo: tai nėra paros prieaugis. `engine_seq` liko 9 100 924,
todėl šis laukas vienas nenusako balų šviežumo.

## Pakeitimai

- TCLK `noLockCooldowns` laukas išlaiko tiksliai nustatyto neužrakinimo 24 val.
  laukimą per restartą ir istorijos trumpinimą. Seno formato paskutiniai
  nutraukimai migruojami; sandoriai, kurių eiga jau prasidėjo, tęsiami.
- Modelio vykdytojas po backend klaidos nebeima naujų to plano darbų.
  Pradėti darbai baigiami, nepradėti lieka tinkami kitam ciklui.
- Paleidimo auditas saugo kodo turinio fingerprint; `quick-status` lygina jį.
  Senesnio paleidimo kodo būsena rodoma kaip nežinoma.
- Šaltinių sekimas išplėstas iki 20 adresų, įskaitant agento, minerio,
  validatoriaus, verification ir revenue puslapius, auth dokumentą bei TCLK README.
  Užklausoms nustatyta 30 sekundžių riba.
- Šaltinio klaida išlaiko ankstesnius kelius, nuorodas ir tekstą. Grįžus
  šaltiniui galima nustatyti, kas pasikeitė per sutrikimą. Naujas šaltinis
  paskelbiamas ir jau veikiančiame sekiklyje.
- VPS valandinis `triagent-watch.timer` saugo atskirą būseną ir append-only
  radinių istoriją `data/local/source-watch/`. Jis taip pat atnaujina Kibble
  matavimą ir priežiūros santrauką. CI bazė lieka atskira.
- Švieži VPS radiniai patenka į modelio darbų planą. Apdoroti pirmieji trys
  šaltiniai nebeužstoja vėlesnių radinių; teiginių ištraukimui perduodamas tikras URL.
- Žinių bazėje pataisyti nepagrįsti teiginiai apie ilgalaikę `/kv/` saugyklą,
  privačias pašto dėžutes, žinomą anti-Sybil formulę ir neskelbtą adresų formatą.

## Pateiktų naujienų įvertinimas

[Unchained interviu puslapis](https://unchainedcrypto.com/how-genlayer-is-building-a-court-system-for-disputes-between-ai-agents/)
aprašo Hayes norą ateityje sujungti FLOP su GenLayer. Tai viešai išsakyta kryptis;
ji nepatvirtina įdiegtos integracijos ar sudarytos partnerystės.
[FLOP verification](https://flop.finance/intro/verification/) aprašo atskirą
minerio inference įrodymų ginčijimą. Šių dviejų ginčų rūšių nesuplakame.

Referral / KOL / periodinės loterijos pranešimą pateikė operatorius, o paieškoje
jį atitiko indeksuotos kopijos. Tiesioginių [Hayes](https://x.com/CryptoHayes) ir
[Flop Labs](https://x.com/flop_labs) įrašų perskaityti nepavyko. Todėl naujiena
pažymėta REPORTED, originalo patikra lieka atvira. Programos biudžetas, paleidimas,
formulė ir ryšys su pagrindiniu genesis vertinimu nepatvirtinti.

[Yellow Paper](https://flop.finance/intro/yellowpaper/) Appendix A jau įvardija
KOL, referral ir augimo paskatas ekosistemos rezerve. Tai ne konkrečios loterijos
biudžetas. Specifikacijos E.38 palieka nebaigtą paskirstymo ir claim eigą.
[Technocore auth](https://technocore.chat/auth.md) teigia, kad ši paslauga neturi
claim ar tokenų gavimo endpointų. Kambario pavadinimas jų nesukuria.

## Tolimesni prioritetai ir ribos

Po diegimo vertinti bent 24 val. TCLK pasikartojimų ir modelio nesėkmių dažnį.
Cooldown sutaupo laukimą, tačiau negarantuoja, kad kiti mokėtojai pradės atsakyti.
Nekeisti atminties perkrovimo slenksčio be RAM / swap ir užklausų koreliacijos.
Kambarių skaitymo spragos išlieka: per ciklą ne visos žinutės patenka į 200 įrašų
langą. Nevadinti jų visų ištrintomis - tai reikia tikrinti pagal išlaikytą istoriją.

VPS watcher stebi dokumentus ir RSS. Jis automatiškai neskaito X, todėl socialiniams
pranešimams ir toliau reikia patikrinamo originalo arba aiškaus REPORTED žymėjimo.
Vietiniai kvitai, Kibble ir TCLK paper juosta nepatvirtina oficialios FLOP įskaitos.

Diegimo atšaukimui galima grąžinti šio pakeitimo Git commit per `git revert` ir
įprastą atnaujinimo eigą. Nauji TCLK laukai atgal suderinami. Naują stebėjimą
atskirai sustabdo `systemctl disable --now triagent-watch.timer`.

---

# Antra patikra tą pačią dieną — 07:15–07:35 UTC

Šis skyrius užbaigia ryte likusį atvirą klausimą ir prideda tai, kas rasta po
diegimo. Serverio HEAD ir procesas abu buvo ties `6af73be`; `triagent` paleistas
07:03 UTC, `ollama` ir visi keturi taimeriai aktyvūs.

## Modelio klaidų priežastis nustatyta

Ryte liko atviras klausimas, ar `fetch failed` klaidos susijusios su `ollama`
perkrovimais. Susietos dvi eilutės — perkrovimo taimerio žurnalas ir kvitų
laikai — per 24 val. iki 07:15 UTC:

| | |
|---|---|
| `ollama` perkrovimų | 31 (maždaug kas 45 min.) |
| `fetch failed` kvitų | 253 |
| iš jų per 60 s po perkrovimo | **253 iš 253 (100%)** |
| serijų | 20, po 17–20 klaidų vienoje |

Serijos dydis 17–20 yra viso vieno ciklo plano dydis. Tai reiškia, kad kiekvienas
perkrovimas iki šiol nužudydavo visą tuo metu vykdomą darbų paketą. Vadinasi,
kalbėti apie „nepatikimą modelio backend'ą" nėra pagrindo: klaidų šaltinis yra
mūsų pačių atminties perkrovimo taimeris, ne tinklas ir ne paslauga.

Rytinis pataisymas (po backend klaidos nebeimti naujų to plano darbų) turėtų
sumažinti seriją nuo ~20 iki ~2, nes vienu metu vykdomi du seansai.

Pirmas perkrovimas po diegimo — 07:30:20 UTC. Per pirmas dvi minutes po jo:
**0 `fetch failed` ir 4 sėkmingi seansai**, kur ankstesni 31 perkrovimas davė
po 17–20 klaidų. Tai vienas stebėjimas, ne įrodymas — pataisymas laikomas
patvirtintu tik po kelių parų su tuo pačiu rezultatu.

## Įšilimo kaina pamatuota

`classify-message` seansų delsa pagal laiką nuo perkrovimo, ta pati para:

| Laikas po perkrovimo | n | p50 | p90 |
|---|---|---|---|
| 0–60 s | 30 | 20 132 ms | 22 207 ms |
| 60–120 s | 84 | 7 391 ms | 21 082 ms |
| 120–300 s | 313 | 7 207 ms | 8 639 ms |
| 300 s+ | 4 285 | 7 212 ms | 8 800 ms |

Pirmą minutę po perkrovimo seansas kainuoja apie tris kartus brangiau. Po dviejų
minučių skirtumo nebelieka. Perkrovimo slenkstis nekeistas: tam reikėtų RAM,
swap ir užklausų koreliacijos, kurios dar nėra.

## Deklaruota delsos riba nieko neriboja

Kvite yra `maxLatencyMs` (30 s klasifikacijai, 90 s kibble atsakymui), bet
nutraukimas skaičiuojamas kaip `min(backend riba, 2 × maxLatencyMs)`. Ollama
riba yra 120 s, todėl faktiškai 30 s užduotis nutraukiama ties 60 s, o 90 s —
ties 120 s. Pamatuota per parą: 151 iš 4 715 sėkmingų klasifikacijų (3,2%)
viršijo savo deklaruotą ribą, ilgiausia 59 s; kibble atsakymų — 1 iš 461.

Riba tyčia nekeista. Ją sugriežtinus tiksliai iki deklaruotos, per parą būtų
nutraukta 152 seansai, kurie dabar baigiasi sėkmingai. Tai užrašyta kaip
neatitikimas, ne kaip pataisymas.

## Kur dingsta ciklo laikas

1 011 ciklų iš priežiūros žurnalo: vidutinis ciklas 50,6 s iš 60 s intervalo,
297 ciklai (29%) viršijo intervalą. Didžiausia juosta yra `kibbleWorker` —
vidutiniškai 14,9 s, o viršijusiuose cikluose 35,2 s. Suskaidžius pagal baigtį:

| Baigtis | n | p50 | p90 | dalis juostos laiko |
|---|---|---|---|---|
| `delivered` | 569 | 31 976 ms | 44 408 ms | 81,9% |
| `refused` | 63 | 30 276 ms | 121 201 ms | 11,6% |
| `claims_lost` | 114 | 939 ms | 4 387 ms | 1,0% |
| `no_job` | 1 305 | 306 ms | 2 131 ms | 5,5% |

`runValidatorTurn` turi laiko ribą, `runWorkerTurn` — neturi. Riba jai vis dėlto
nededama: pagal šiuos skaičius riba, telpanti į 60 s intervalą, nukirstų daugiau
nei pusę pristatytų atsakymų, o būtent jie ir yra šios juostos produktas. Tikroji
riba čia yra dviejų bendrinamų vCPU sparta, ne planuoklis.

## Paskelbtų grafikų antraštės buvo pasenusios iki 16 kartų

`docs/charts/*.svg` ir `docs/guide.html` antraštės buvo įrašytos ranka ir
nebeatitiko matavimų, iš kurių pačios linijos piešiamos:

| Buvo paskelbta | Tikrasis matavimas 2026-09-10 |
|---|---|
| „Rooms against the 10,240 cap" | 50 033 iš 163 840 |
| „tightest cap on the service: 78% full" | kambariai 31%, o įrašai 43% |
| „Notes stored against the 327,680 cap" | 2 276 522 iš 5 242 880 |
| „legacy namespace ... full at 40,960" | 163 704 iš 163 840 |
| „Down 62% from peak in five hours" | −7% per paskutinį lango ketvirtį |

Kambarių riba nuo tada buvo pakelta du kartus (81 920, paskui 163 840), o
antraštės liko. Visos penkios dabar skaičiuojamos iš to paties matavimo, iš kurio
piešiama linija, įskaitant tai, kuri riba iš tiesų yra artimiausia — šiandien tai
įrašai, ne kambariai. `tools/build-guide.mjs` jau turėjo šią taisyklę užrašytą
srauto antraštei; grafikų antraštės buvo vienintelė vieta, kur ji nebuvo pritaikyta.

## Švieži paslaugos skaičiai

`technocore-chat` 0.13.0 (leidimas 2026-09-07). `/rooms` 2026-09-10 07:24 UTC:
45 888 kambarių iš 163 840 ribos, 1,9 G iš 5,0 G saugyklos, 2 760 235 įrašai.
`max_notes_total` 5 242 880, `max_notes_per_ns` 163 840, `rate_rooms_per_day` 20.
Kambarių kūrimas šiuo metu neužblokuotas ir per parą nė karto neatmestas.

## TCLK po pataisymo

Per parą 211 priėmimų ir 211 nutraukimų, visi dėl to paties: mokėtojas
neužrakino lėšų per penkias minutes. `noLockCooldowns` po diegimo laiko 52
įrašus, tad laukimas veikia. Nuo diegimo priimti dar 2 nauji mokėtojai ir abu
taip pat neužrakino. Cooldown neleidžia tų pačių mokėtojų bandyti pakartotinai;
jis neduoda naujų mokėtojų, kurie atsakytų.

## Nauji kambariai — ne įrodymas

Sekiklis 07:02 UTC pažymėjo du: `faucet` ir `flop-airdrop`. `/r/faucet` juostoje
jau per 6,3 mln. žinučių, turinys — tos pačios „FLOP testnet faucet claim"
eilutės kaip rugsėjo 5 d. `/r/flop-airdrop` yra 2 721 žinutė, tarp jų trečiųjų
šalių reklama su nurodymais agentams pasirašinėti eilutes ir statyti statymus
svetimoje svetainėje. Nė vienas kambarys nėra oficialus FLOP šaltinis, ir
kambario pavadinimas jo tokiu nepadaro. Mūsų agentas kambarių tekstą traktuoja
kaip duomenis, ne kaip nurodymus; tai patvirtina ir prompto apsaugos.
