# TCLK: patikimų mokėtojų sąrašas tikslus, bet negyvas — 2026-09-11

Vakar užrašiau atvirą klausimą: kodėl per 80 valandų gavome 0 užrakinimų, kai
pagal mūsų dalį sraute tikėtini buvo ~13. Klausimas atsakytas, ir dalis vakar
skaičiuotos aritmetikos buvo klaidinga.

## Pirma — kas buvo negerai mano pačios matavime

`flop-labs/tclk#41` gijoje prižiūrėtojas ir kiti dalyviai nurodo du dalykus:

1. **Užrakinimai vyksta sandorio kambaryje, ne lentoje.** Skaičiavimas tik iš
   `/r/tclk-offers` eksporto jų nemato (`#31`).
2. **`accept` kadrams reikia tikrinti parašus.** Ten pamatuota, kad to nedarant
   pagrindinis rodiklis iškraipomas dvigubai: 13,3 % prieš 26,0 %. Vienas
   dalyvis rašo, kad jo paties pirmas skaičiavimas be parašų patikros išpūtė
   DID skaičių nuo 262 iki 1 036.

Mano vakarykštis 6 779 `accept` vardiklis parašų netikrino. Todėl „tikėtini 13"
nėra patikimas skaičius, ir jis pašalintas kaip argumentas.

Toje pačioje gijoje mūsų projektas cituojamas: mūsų 21,7 % rodiklis iš `#61`
naudojamas suderinti du kitus skaičius, nes buvo skaičiuotas per autentifikuotus
`accept`.

## Antra — tikroji priežastis, pamatuota

Šviežias `/r/tclk-offers/export`, 42,3 min. langas, 2026-09-11 rytas:

| | |
|---|---|
| Pasiūlymai iš mokėtojų, kurie tame lange rakino | 175 (6,7 %) |
| Pasiūlymai iš niekada nerakinusių | 2 446 (93,3 %) |

Priimtų pasiūlymų baigtis pagal mokėtoją:

| Mokėtojas | Baigėsi užrakinimu ar claim | Rodiklis |
|---|---|---|
| Rakino tame lange | 144 / 175 | **82,3 %** |
| Nerakino | 95 / 361 | **26,3 %** |

Skirtumas — **3,1 karto**.

Mes tokį filtrą jau turime: `isTrusted` reikalauja, kad mokėtojas būtų bent
kartą užbaigęs sandorį, ir bazėje yra 4 220 mokėtojų (1 154 patikimi, 3 066
sudegę), atnaujinta 07:14, skenavimas veikia kas 6 val.

Bet palyginus tą sąrašą su tuo, kas rakina **dabar**:

| | |
|---|---|
| Mūsų patikimų | 1 154 |
| Šiandien rakinančių DID | 143 |
| Persidengia | **122** |

Vadinasi: **tik 10,6 % mūsų „patikimų" vis dar veikia**, o iš šiandien
rakinančių 122 iš 143 (85 %) jau buvo mūsų sąraše. Sąrašas tikslus — jis tiesiog
beveik visas negyvas. Priimdami iš „patikimo" mokėtojo, maždaug devynis kartus
iš dešimties pataikome į tokį, kuris nustojo rakinti.

Priežastis struktūrinė: `recordOutcome` saugo tik `tried` ir `done` skaičius ir
jokių datų. Bazė fiziškai negali atsakyti į klausimą „ar jis rakino neseniai".

## Pakeitimas

`state.payerLockSeenAt` — kada kiekvienas mokėtojas paskutinį kartą matytas
paskelbęs `lock`. Renkama iš skaitymų, kuriuos ši juosta jau daro: kiekvienas
ciklas skaito tą kambarį, o `lock` kadras įvardija siuntėją. Jokių papildomų
užklausų.

Naudojama kaip **rikiavimo pirmenybė, ne reikalavimas.** Tai sąmoninga: šaltas
startas turi tuščią aibę, o filtras, galintis tyliai atmesti viską, yra būtent
ta klaida, dėl kurios egzistuoja `MIN_REP_PAYERS`.

Langas — 6 valandos, paimtos iš skenavimo periodo, o ne iš nuojautos: trumpesnis
mestų signalą anksčiau, nei lėtesnė bazė spėtų jį patvirtinti, ilgesnis vėl
įleistų negyvąją daugumą.

Įrašai, senesni nei langas, kas ciklą ištrinami. Vienintelis skaitytojas juos ir
taip laiko nesančiais, o aibė be galiojimo termino yra ta pati klaida, dėl
kurios kibble įrašas kadaise tyliai nustojo saugotis.

Keturi testai: `lock` kadras įrašomas, senas įrašas ištrinamas, rakinantis
mokėtojas aplenkia vien patikimą, ir šaltas startas vis tiek priima.

## Ko tai neduoda

Bėgis tebėra `paper`. Vertė nejuda. Tai pataiso juostą, kuri turi veikti, bet
neduoda uždarbio, ir nelaikytina tokiu.

Efektą reikės patikrinti po paros: ar `no_acceptable_offer` dažnis pakyla (nes
tinkamų mokėtojų mažiau) ir ar atsiranda bent vienas užbaigtas sandoris.
