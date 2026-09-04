# Agento perkėlimas į serverį

Kodėl apskritai: 2026-09-03 vakare kompiuteris nulūžo ir agentas stovėjo **apie 20
valandų**. Niekas nesugedo — tiesiog nebuvo kam suktis. Serveris tokios pertraukos
nedaro.

---

## Ko agentui iš tikrųjų reikia

Ne spėjimai — išmatuota šitame kompiuteryje 2026-09-04:

| Kas | Kiek | Iš kur skaičius |
|---|---|---|
| Atmintis: pats agentas | 492 MB | veikiantis `node` procesas |
| Atmintis: modelis `qwen2.5:3b` | ~2,3 GB kai įkeltas | 1,8 GB diske + įkėlimo priedas |
| **Iš viso su sistema** | **~3,5 GB** | reiškia: 4 GB minimum, 8 GB ramu |
| Diskas | ~5 GB | 1,8 GB modelis + 133 MB būsena + kodas + augantys žurnalai |
| Tinklas | tik išeinantis HTTPS | jokių atidarytų prievadų, jokio domeno nereikia |
| Procesorius | nuolatinis, bet lėtas | ciklas kas 60 s; sunkiausia dalis — modelis |

Vaizdo plokštės **nereikia** — modelis sukasi procesoriumi.

---

## Kur dėti

**Sprendimas: Hetzner CX23, Helsinkis, 7,25 €/mėn. su PVM** (6,64 € serveris +
0,61 € IPv4 adresas).

Hetzner yra vokiečių firma, nuomojanti kompiuterius duomenų centruose. CX23 — tos
nuomos dydžio pavadinimas: 2 branduoliai, 4 GB atminties, 40 GB disko. Helsinkis —
kur ta mašina fiziškai stovi.

Norėjom CX33 (4 branduoliai, 8 GB). **Jo nėra** — patikrinta 2026-09-04 konsolėje,
ne iš kainoraščio: CX33 Helsinkyje pilkas, o Falkenstein'e ir Nurnberge Hetzner
atsako raudona juosta „Preselected server type is not available". Tas pats ir su
ARM CAX21. Tad CX23 yra ne pasirinkimas iš kelių, o vienintelis esamas.

Tai nėra aklavietė: Hetzner leidžia **padidinti serverį vėliau** (*Rescale*) be
perdiegimo. Kai CX33 atsilaisvins, pereinam į jį per perkrovimą. Iki tol 4 GB
atlaiko dėl swap, kurį susikuria diegimo skriptas.

Kaip prie to prieita (2026-09-04, kainos po Hetzner birželio pabrangimo):

| Kur | Kaina | Verdiktas |
|---|---|---|
| Oracle Cloud Always Free | 0 € | **Bandyta 2026-09-04 — nepavyko.** Nemokamų ARM mašinų nuolat nėra |
| Hetzner CX23 (2 br., 4 GB) | 5,49 €/mėn. | Tilptų, bet be atsargos: mums reikia ~3,5 GB iš 4 |
| **Hetzner CX33 (4 br., 8 GB)** | **8,49 €/mėn.** | **Šitą.** Mėnesinis mokėjimas, be įsipareigojimo |
| Hostinger KVM 2 (2 br., 8 GB) | 7,99 € → **14,99 €** | Lietuviška firma ir pagalba lietuviškai. Bet: pusė branduolių, ~192 € iš karto už 2 metus, po to dviguba kaina |
| Hostinger KVM 1 (1 br., 4 GB) | 5,49 € → 11,99 € | **Ne.** Vienas branduolys modelio nepatemps |
| Hetzner CAX21 (ARM, 8 GB) | 10,49 €/mėn. | Tas pats, tik brangiau |
| Render / Railway nemokami | 0 € | **Netinka**: užmiega, nėra nuolatinio disko, nepaleisi Ollamos |
| Raspberry Pi namuose | ~120 € vienkartinai | Ta pati bėda kaip su kompu: dingsta elektra — dingsta agentas |

Hostinger nėra blogas — 8 GB atminties tiek pat, kiek CX33, o pagalba lietuviškai
yra tikra vertė. Nuo jo atkalbėjo du dalykai. Pirma, **2 branduoliai vietoj 4**:
tai tiesiai pablogintų būtent tą vėlavimą, kurį bandom taisyti. Antra, **kainos
forma**: 7,99 € galioja tik sumokėjus ~192 € iš karto už dvejus metus, o paskui
tampa 14,99 € — beveik dvigubai daugiau nei Hetzner. Hetzner ima už valandas, be
jokio įsipareigojimo, tad jei perkėlimas nepasiteisintų po savaitės, sumokėtum
apie 2 € ir ištrintum. Kol dar nežinom, ar viskas suksis, būtent tai ir svarbu.

Kodėl ne pigesnis CX23, o CX33 už 3 € daugiau: mūsų ciklas **jau dabar vėluoja**
(45–114 s, nors taikinys 60 s), o sunkiausia jo dalis yra modelis, kurį gena
procesorius. Du branduoliai vietoj keturių tą vėlavimą tik pagilintų. Trys eurai
per mėnesį už dvigubai greitesnį darbą yra pigu.

Ir viena netikėta smulkmena: šitame kompiuteryje yra 16 GB atminties, bet
**laisvos šiuo metu tik 1,8 GB** — agentas dalinasi mašina su naršykle ir viskuo
kitu. Serveryje, kur nieko daugiau nesisuka, jam realiai atiteks daugiau atminties
negu turi dabar.

---

## Kaip užsisakyti tą serverį (pirmą kartą)

1. **Registracija:** [console.hetzner.com](https://console.hetzner.com) → *Register*.
   Naujos paskyros Hetzner kartais paprašo asmens dokumento nuotraukos — tai
   normalu, patvirtinimas trunka nuo kelių minučių iki paros.
2. **Projektas:** paspaudi *New Project*, pavadini kaip nori, pvz. `triagent`.
3. **Serveris:** *Add Server*, ir renkiesi keturis dalykus:
   - **Location** → *Helsinki*
   - **Image** (kokia sistema) → *Ubuntu 24.04*
   - **Type** → skiltis *Shared vCPU*, eilutė **CX33**
   - **SSH key** → čia pauzė, žiūrėk kitą punktą
4. **SSH raktas** — tai slaptažodžio pakaitalas, kuriuo tavo kompiuteris
   prisijungia prie serverio. Windows'e pasidarai jį taip (atidaryk PowerShell):

   ```
   ssh-keygen -t ed25519
   ```

   Spaudi Enter tris kartus. Tada parodai, ką jis sukūrė:

   ```
   type $env:USERPROFILE\.ssh\id_ed25519.pub
   ```

   Tą vieną eilutę nukopijuoji ir įklijuoji į Hetzner langelį *Add SSH key*.
5. *Create & Buy now*. Po minutės sąraše atsiras serverio **IP adresas** —
   keturi skaičiai su taškais. Jo prireiks kitame žingsnyje.

Prisijungimas prie serverio (iš PowerShell, `SERVERIO-IP` pakeisk savuoju):

```
ssh root@SERVERIO-IP
```

---

## Svarbiausia: perjungti nereikia iš karto

Agente jau yra **nuomos (lease) mechanizmas** — jis kaip tik tam ir parašytas:
kelios mašinos gali turėti tą pačią tapatybę, bet kalbėti serveryje leidžiama tik
vienai. Kita laukia ir perima per kelias minutes, kai pirmoji nutyla.

Todėl:

1. Serveris paleidžiamas **greta** veikiančio kompiuterio. Nieko stabdyti nereikia.
2. Kelias dienas jie sukasi kartu, tu stebi, ar serveris tvarkosi.
3. Kai patikėsi — kompiuteryje tiesiog nebepaleidi `paleisti-nuolat.bat`, ir viskas.

Jei serveris pasirodys blogesnis — išjungi jį, kompas dirba toliau. Nieko neprarandi.

### Vienas dalykas, kurio negalima nukopijuoti

Failas `data/local/lease-holder-id` yra **šitos mašinos vardas** toje nuomoje.
Kompiuteryje jame parašyta `local-sol7mx`. Jei tą patį failą nuneši į serverį, abi
mašinos vadinsis vienodai, kiekviena skaitys kitos nuomą kaip savo ir **abi
rašys vienu metu** — būtent tai, ko nuoma neleidžia.

Ir pakavimo `.bat`, ir `setup-vps.sh` tą failą sąmoningai praleidžia. Nedėk jo ranka.

---

## Žingsniai

**Kompiuteryje:**

1. Dukart spusteli `SUPAKUOTI-PERKELIMUI.bat`. Ant darbastalio atsiranda
   `perkelimas.zip` — jame raktai, nustatymai ir išsaugota būsena.
2. Nusiunti jį į serverį:

```bash
scp ~/Desktop/perkelimas.zip vartotojas@serverio-ip:~/perkelimas.zip
```

**Serveryje (Ubuntu 24.04):**

Jei užsakant į laukelį *Cloud config* buvo įdėtas [deploy/cloud-init.yaml](deploy/cloud-init.yaml),
serveris **pats** pirmo paleidimo metu susidiegia Node, Ollamą, parsisiunčia modelį,
susikuria swap ir parsisiunčia kodą — kol tu nieko nedarai. Eiga matoma:

```bash
cat /root/PARUOSIMAS.txt
```

Kai ten pasirodo `PARUOSTA` (apie 5–10 min. po sukūrimo), lieka vienas žingsnis:

```bash
bash TriAgent/deploy/setup-vps.sh
```

Skriptas idempotentiškas — tai, ką cloud-init jau padarė, jis praleidžia, ir
atlieka tik likusią dalį: išpakuoja būseną, sukuria `systemd` servisus, paleidžia.
Be cloud-init tas pats skriptas padaro viską nuo nulio, tik užtrunka ilgiau.

**Patikrinimas:**

```bash
journalctl -u triagent -f
```

Turi matytis tos pačios eilutės kaip kompiuterio konsolėje: `[Scout #...]`,
`[Kibble/Worker] delivered`, `[tclk] ...`. Būseną kaip visada rodo:

```bash
cd ~/TriAgent && npm run brief
```

---

## Kas kur atsiduria serveryje

| Kompiuteryje | Serveryje |
|---|---|
| `paleisti-nuolat.bat` | `systemctl start triagent` (paleidžiamas automatiškai po perkrovimo) |
| `PERKRAUTI-DAEMON.bat` | `sudo systemctl restart triagent` |
| Windows užduotis „tclk mokėtojų skenavimas" kas 6 val. | `triagent-scan.timer` (00:15, 06:15, 12:15, 18:15) |
| `data\local\daemon-console.log` | `journalctl -u triagent` (failas irgi lieka) |

---

## Saugumas

`perkelimas.zip` viduje yra **agento privatūs raktai**. Jo negalima siųsti paštu,
Discordu ar dėti į debesį — tik tiesiai `scp` į savo serverį. Panaudojus ištrink
ir iš darbastalio, ir iš serverio namų katalogo.
