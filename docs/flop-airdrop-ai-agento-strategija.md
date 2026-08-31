# FLOP airdrop AI agento strategija

Operatorius: Asmeninis. Kodą rašo Claude Code CLI, ne Grok Bot.
Repo: `C:\Users\mariu\TriAgent` (public: github.com/Mariukasfak/flop-evidence-scout).
Šaka, kurią galiausiai turi turėti daemon: `main`.

## Tikslas

Turėti patikrinamą, naudingą Technocore/FLOP agentą (uptime + tikras darbas), ne spamą.
Nauji DID iš to paties IP yra anti-Sybil minusas. Lieka tik esami du raktai.

- Scout: `did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn`
- Scribe: `did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW`

Daemon: `node src/daemon.mjs --url=https://technocore.chat --interval-ms=60000 --data-dir=data/local --docs-dir=data/local/docs`
(Paleidžia `paleisti-nuolat.bat`. Stabdyti tik `daemon.mjs` node PID, ne bat langą.)

## Ko NELIESTI

- `.secrets/`, identity pem, vault, `POST /api/keygen`, nauji DID
- `CLOUD_WRITES` (neįjungti)
- force-push, rewrite of published history
- `DELIVER v1` (kibble rašo tik `RESULT v1`)
- self-ATTEST, useful ATTEST be `rh:`
- lenktynės dėl visų atvirų JOB (claim langas ~0.3–1s)
- lobby 2/val cap (palikti)

## Kas jau yra (2026-08-31 ~18:02 Vilnius)

- Kibble įjungtas daemone (`src/kibble-engine.mjs`). Commit eilėje: `cca08f2`.
- Audit: RESULT `k8b3472dd77` (resultsDelivered:2) ir attested_not `k91db24929f` (attestsPosted:2). Anksčiau dar RESULT `k3771db6f40`, ATTEST `k714beaedec`.
- `/api/score` abiem DID vis dar `found:false` / score 0. `/api/stats` kartais 503, `engine_warm:false`. Tai gali būti šaltas score engine, ne būtinai broken write.
- Faucet detektorius jau du kartus suklydo (kambario pavadinime „faucet/testnet“, turinys — rinka): `flop-aave-v4-testnet-goes-live-flz9`, `flop-testnet-faucet-inference-spend-a-xoum`. Oficialių FLOP faucet nėra.
- Po daemon restart skaitikliai `kibbleResultsDelivered` / `kibbleAttestsPosted` nukrenta į 0 (būsena nepersistinama).

Spec: https://flop-kibble.onrender.com/llms.txt
Juosta: `GET /r/kibble`. Overheard kortelės: https://overheard-five.vercel.app/ (tik viešas DID).

## Kaip Claude --bg turi dirbti

`--bg` sesija PRIVALO turėti izoliuotą git worktree. Tai normalu, ne klaida.

1. Dirbk savo worktree. Nestabdyk ir nenaikink worktree guard.
2. Nerašyk tiesiai į `C:\Users\mariu\TriAgent` checkout (ten sukasi daemon).
3. Bazė: dabartinis `origin/main`, ne sena šaka ir ne tuščias worktree.
4. Nedaryk `git push`. Komitinti worktree šakoje galima, jei testai žali.
5. Operatorius po to merge į `main`, `git pull` lokale, restart daemon (tik node PID).

## Dabar daryti (ši banga)

Mažiausi pakeitimai esamame kibble engine, testai jei yra ką laužyti.

1. Persistinti worker/validator būseną (`resultsDelivered`, `attestsPosted`, `refusedJobIds`) į `data/local` failą ir/ar KV, kad daemon restart nenužudytų skaitiklių.
2. Po kiekvieno RESULT ir ATTEST: `GET /r/kibble` ir patvirtinti, kad mūsų DID/jobId tikrai juostoje, ir tik tada skaičiuoti success. Jei lokalus audit sako ok, o juostos nėra — taisyti write kelią/schemą, ne spaminti daugiau JOB.
3. Kai Scout turi bent vieną scored RESULT: Scribe gali siųsti **useful** ATTEST su `rh:` (ne tik `attested_not`). Be franchise RESULT — useful nesiųsti.
4. Faucet detektorius: kambario pavadinimo žodžiai `faucet`/`testnet` NEPAKANKA. Rinkos komentarai (Aave V4, funding, 3:1 unlock kaip naujiena) nėra oficialus FLOP faucet. Oficialių signalų ieškoti flop.finance, technocore openapi/claim route, @flop_labs / Hayes. Su nepatikrintu kambariu neinteractinti.

Nebūtina šioje bangoje: naujos grupės, nauji raktai, Overheard UI, lobby cap keitimas.

## Baigta, kai

- Worktree turi diffą su 1–4.
- Testai, kuriuos palietei, žali.
- Trumpa ataskaita: kokie failai, ar tape read-back jau kode, ar faucet filtras atmeta tuos du kambarius, ar persist failas/kelias.
- Jokio push į origin.
