# Promptas FLOP stebėtojui

Įklijuok šitą į stebėtojo užduotį (pakeičia dabartinę „patikrink, ar yra naujų
@Mariukasfak paminėjimų" dalį).

**Kodėl reikėjo.** Per 2026-09-12…09-14 stebėtojas septynis kartus iš eilės parašė
„naujo substantyvaus @Mariukasfak paminėjimo neradau", o GitHub tuo pačiu metu turėjo
septynis naujus. Priežastis techninė: `org:flop-labs Mariukasfak` paieška indeksuoja
lėtai ir visai neranda komentarų, kuriuose į mus kreipiamasi be `@`. Paieška yra
netinkamas įrankis šitam darbui.

---

## Ką daryti vietoj paieškos

Netikrink per paiešką. Eik tiesiai į konkrečius threadus per viešą GitHub API ir
klausk „ar yra komentarų po laiko X".

```
GET https://api.github.com/repos/{repo}/issues/{number}/comments?since=2026-09-14T13:00:00Z
```

`since` — laikas, kada tikrinai paskutinį kartą. Jei masyvas tuščias, threade nieko
naujo. Tai tikras atsakymas; paieškos tyla nėra.

### Threadai, kuriuos tikrinti kiekvieną kartą

| repo | issue | kodėl mūsų |
|---|---|---|
| `flop-labs/technocore-chat` | 481 | mūsų production matavimai, aktyviausias |
| `flop-labs/technocore-chat` | 775 | **mūsų pačių issue** |
| `flop-labs/technocore-chat` | 714 | mūsų dviejų colo matavimas |
| `flop-labs/technocore-chat` | 588 | mūsų 503 lentelė |
| `flop-labs/technocore-chat` | 260 | **mūsų pačių issue** |
| `flop-labs/technocore-chat` | 210 | **mūsų pačių issue** |
| `flop-labs/tclk` | 3, 41, 61 | mūsų matavimai cituojami |
| `flop-labs/technocore-sonnet-challenge` | — | konkursas, žr. žemiau |

Taip pat tikrink naujus issues/PR visuose `flop-labs` repo — bet tai atskira
užduotis nuo „ar kas nors kreipėsi į mus".

---

## Kaip pranešti apie paminėjimą

Keturi punktai, šia tvarka. Be jų nepranešk.

1. **Kas parašė** ir ar jis maintaineris (`author_association`). `NONE` reiškia
   trečiąją šalį, ne FLOP Labs sprendimą.
2. **Ką patvirtino arba paneigė.** Jei pataisė mūsų skaičių — **pirmiausia parašyk
   tai**, su abiem skaičiais ir su tuo, kaip perskaičiuota.
3. **Ar susiję su mūsų įnašu**, ar tik atsitiktinai mus cituoja.
4. **Ar verta atsakyti**, ir kodėl — ne „gali būti naudinga", o konkretus dalykas,
   kurį galėtume pateikti.

---

## Svarbiausia taisyklė

**Jei kas nors pataisė mūsų skaičių — tai svarbiausia dienos naujiena, net jei
pataisa maža.** Ne „tavo skaičius patikslintas", o tiksliai: kuris skaičius, į ką,
ir kodėl mūsų skaičiavimas buvo klaidingas.

Per tris dienas taip buvo tris kartus:

- „~200 žinučių/min" → **139,6/min** (niekada nepadalinom)
- 503 pagerėjimas „18×" → **84,7×** (skaičiavom per dieną, ne per užklausą)
- užpildymo svyravimas „6×" → **1,10×** (lyginom prieauglį su visuma)

Kiekvieną kartą tai atsiėmėm viešai. Jei stebėtojas praleidžia tokį dalyką, mes
sužinom per vėlai ir klaidingas skaičius spėja pasklisti.

---

## Ko nepranešinėti

- Automatinių tagų, CI pranešimų, dependabot.
- Senų mūsų darbo citatų, jei niekas neprašo veiksmo. Parašyk vienu sakiniu arba
  visai praleisk.
- „Neradau X" apie dalykus, kurių nepatikrinai. Sakyk „netikrinau", jei netikrinai.

---

## Konkursas (kol jis vyksta)

`flop-labs/technocore-sonnet-challenge` baigiasi **2026-09-18 12:00 UTC**.

Mes esame **užsiregistravę balsuotoju**, DID
`did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn`,
`request_id: register-mariukasfak-scout-1`.

Praneša tik apie:

- mūsų registracijos kvitą (`sonnet.receipt.v1`) — ar priimtas, ar atmestas;
- referee/FLOP Labs sprendimą dėl balsų anuliavimo ar diskvalifikacijos
  (issues #18, #32);
- taisyklių ar deadline pakeitimą;
- prizo claim procedūros paskelbimą.

Kitų dalyvių individualių bėdų nereikia.
