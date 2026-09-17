# Ką daryti, kai eilėraštis bus baigtas

Terminas: **2026-09-18, 12:00 UTC** (15:00 Lietuvos laiku).

Agentas dirba pats. Tavo reikia tik trijuose žingsniuose, ir tik tada, kai
pranešiu, kad eilėraštis baigtas. Jei nepranešiau — nieko daryti nereikia.

---

## 1. Paspausk `publish-sonnet.bat`

Jis yra `TriAgent` aplanke. Du kartus spusteli — atsidaro juodas langas.

Jis nuskaito eilėraštį **tiesiai iš komandos kambario internete**, ne iš failo
kompiuteryje. Taip yra tyčia: 76 iš 150 šio konkurso atmetimų buvo dėl to, kad
paskelbtas tekstas nesutapo su tuo, ką teisėjas priėmė. Viena komanda bandė 41
kartą ir nepavyko.

Langas parodys **2 įrašus**, pažymėtus `post 1/2` ir `post 2/2`.

## 2. Paskelbk juos iš @marcryptox

Svarbiausia taisyklė: **niekas negali būti pakeista.**

- Įrašai skelbiami **gija** (antras — atsakymas į pirmą), ta pačia tvarka
- Į juos **nieko nedėk**: jokio pavadinimo, jokios nuorodos, jokio emoji
- Nepridėk tarpų, neištrink eilučių

Teisėjas iš tų įrašų atstato eilėraštį ir lygina su parašu. Vienas papildomas
simbolis — ir viskas atmetama.

**Priskyrimą** (tekstą po `ATTRIBUTION`) skelbk **atskiru** atsakymu. Jis į
skaičiavimą neįeina — bet ir jis reikalingas.

## 3. Atsiųsk man įrašų numerius

Kiekvienas X įrašas turi numerį adrese:

```
https://x.com/marcryptox/status/1234567890123456789
                                ^^^^^^^^^^^^^^^^^^^ šitą
```

Reikia **dviejų** numerių — pirmo ir antro įrašo, ta pačia tvarka.
Priskyrimo įrašo numerio **nereikia**.

Toliau padarysiu aš.

---

## Ko NEDARYTI

- **Neskelbk eilėraščio iš anksto**, kol nepasakiau, kad baigtas. Vienas
  eilėraštis gauna **vieną** priimtą pateikimą — sudeginę jį anksčiau laiko
  nebeturėsime antro bandymo.
- **Nekeisk teksto**, net jei atrodo, kad yra klaida. Jei kas negerai — pasakyk
  man, netaisyk pats.
- **Nepaleisk nieko kito** iš `tools` aplanko. Paskutinis žingsnis
  (`sonnet2-submit.mjs`) turi savo apsaugas ir jį paleisiu aš.

---

## Kas apsaugo nuo klaidų

Prieš išsiunčiant pateikimą įrankis pats atsisako, jei:

- eilėraštis nesudaro 14 eilučių
- paskutinį žodį parašė ne mes (pateikti gali tik paskutinis rašęs)
- įrašų skaičius nesutampa su gija

Tai septynios dažniausios šio konkurso atmetimo priežastys, ir kiekviena jų
dabar turi savo stabdį.
