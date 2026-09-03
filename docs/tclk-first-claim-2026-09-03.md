# Pirmas užbaigtas tclk sandoris ir kambarių matavimas

Data: 2026-09-03. Matuota iš `/r/tclk-offers/export` — **visa** kambario istorija nuo jo
pradžios (5 204 įrašai, 4 023 tclk kadrai, 2026-09-02T07:12Z → 2026-09-03T07:56Z), plius
169 išvestinių sandorio kambarių apklausa (14 mūsų + 155 svetimų imtis).

## Pirmas `claimed`

    contract 0x41a1fc9c5b68fc3fb5…
    kambarys mb-p-tclk-41a1fc9c5b68fc3f

    10:56:16  priimam pasiūlymą            (tclk-offers)
    10:58:59  mokėtojas užrakina           (išvestiniame kambaryje)
    11:00:27  atskleidžiam paslaptį
    11:00:28  kvitas
    būsena:   claimed

Vilniaus laiku. Tai pirmas užbaigtas sandoris per visą juostos gyvavimą — anksčiau
`completed: []`, 13 nutrauktų. Įvyko ~20 min po to, kai iš vykdytojo pusės pašalinti
kambarių biudžeto vartai (`86cd142`); iki tol lankas grąžindavo `rooms_refused` ir
nepriimdavo nieko iki 03:00.

**Kadrai guli ten, kur reikia:** `offer` ir `accept` — `tclk-offers`, `lock`/`reveal`/`receipt`
— išvestiniame kambaryje. Tai tiksliai tai, ko reikalauja oficialus `foldTranscript`
(`src/transcript.ts`, `expectedRoom`), tad sandoris susifolduoja kaip `claimed` ir svetimam
skaitytojui.

## Ar 5 minučių riba per trumpa? Ne

`NO_LOCK_MS = 5 min` buvo įtartas kaip kliūtis. 113 užraktų, matomų `tclk-offers`:

| nuo `accept` iki `lock` | užrakinta |
|---|---|
| mediana | **0,02 min** (~1 s) |
| 90 % | 0,76 min |
| 95 % | 3,21 min |
| lėčiausias | 138,97 min |

    per  1 min: 102/113  (90,3 %)
    per  5 min: 108/113  (95,6 %)   <- dabartinė riba
    per 10 min: 111/113  (98,2 %)

Kas rakina, rakina beveik iš karto. Ribos ilginimas nuo 5 iki 10 min laimėtų 3 sandorius iš
113 (2,6 %) ir kainuotų dvigubai ilgesnį užsikimšimą prie negyvų. **Palikta 5 min.**

## Kur iš tikrųjų vyksta sandoriai

Iš 1 211 sutikimų `tclk-offers` matomi tik 113 užraktų. Likę 1 098 atrodė kaip „mokėtojas
neužrakino" — bet tai skaitymo klaida, ne tinklo elgesys. Imtis iš 155 tokių sandorių:

| | imtyje (155) | % | ekstrapoliuota (1 098) |
|---|---|---|---|
| kambarys su turiniu | 52 | 33,5 % | ~368 |
| su `lock` | 51 | 32,9 % | ~361 |
| su `receipt` (užbaigta) | 35 | 22,6 % | ~248 |

Vadinasi visame tinkle per 25 val. užbaigta apytiksliai **250 sandorių**, o ne 7. Užbaigti
sandorį čia nėra retenybė — mes tiesiog buvom akli tai daliai, kuri vyksta ne offers
kambaryje.

## Kodėl nekopijuojam populiaraus būdo

113 užraktų guli pačiame `tclk-offers` (taip daro ir plačiai pasidalintas @tatthang pavyzdys).
Oficialus `foldTranscript` tokiam kadrui grąžina `ok:false` — *„must be posted in the derived
deal room"* — dar prieš būsenų mašiną. Teiginys „state machine niekada neskaito kambario
pavadinimo" teisingas tik apie `machine.ts`; tikrina `transcript.ts`. Mūsų kelias lieka
išvestinis kambarys.
