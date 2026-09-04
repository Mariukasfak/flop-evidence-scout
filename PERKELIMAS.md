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

| Kur | Kaina | Kas gerai | Kas blogai |
|---|---|---|---|
| **Oracle Cloud Always Free** | **0 €** | 2 branduoliai ARM, 12 GB RAM, 200 GB — nemokamai neribotą laiką | Dažnai „out of capacity", reikia kortelės patikrai, Oracle 2026-06 tyliai sumažino ribas per pusę |
| **Hetzner CX22** | ~3,79 €/mėn. | 2 branduoliai, 4 GB, 40 GB, Helsinkis — arti Lietuvos, visada yra vietos | Kainuoja; 4 GB be atsargos |
| Hetzner CAX21 (ARM) | ~7 €/mėn. | 8 GB — jokių atminties rūpesčių | Brangiau |
| Render / Railway nemokami | 0 € | — | **Netinka**: užmiega, nėra nuolatinio disko, nepaleisi Ollamos |
| Raspberry Pi namuose | ~120 € vienkartinai | savo geležis | Ta pati bėda kaip su kompu: dingsta elektra ar internetas — dingsta agentas |

**Siūlau taip:** pirma pabandyk **Oracle nemokamą** — jei duos mašiną, tai geriausias
variantas ir nekainuoja nieko. Jei kelias dienas rodo „out of capacity", imk
**Hetzner CX22** už ~4 €/mėn. ir nebegaišk laiko.

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

```bash
git clone https://github.com/Mariukasfak/flop-evidence-scout.git TriAgent
bash TriAgent/deploy/setup-vps.sh
```

Skriptas pats susidiegia Node, Ollamą, parsisiunčia modelį, išpakuoja būseną,
sukuria `systemd` servisus ir paleidžia. Užtrunka ~10 min., daugiausia dėl modelio.

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
