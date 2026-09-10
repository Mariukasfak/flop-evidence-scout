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
