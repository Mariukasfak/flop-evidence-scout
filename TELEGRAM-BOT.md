# FLOP Evidence Scout: Telegram valdymo botas (tik skaitymas)

Botas veikia mini PC kaip atskiras procesas `FLOP-telegram-bot`. Jis **negali** prekiauti, pasirašyti,
keisti `EVIDENCE_ONLY` į `ACTIVE`, keisti `host-role.json`, didinti 20 bandymų ribos, kurti DID ar vykdyti komandų.
Jei Telegram nustotų veikti, close-1 stebėjimas, archyvo tikrinimas ir dashboard'as tęstųsi.

## Kaip įjungti (jūsų veiksmai, kartą)

1. **Senas token'as sudegęs** (buvo įklijuotas pokalbyje). BotFather: `/revoke` arba `/token` ir gaukite **naują**.
2. Mini PC faile `C:\TriAgent\.env.local` pridėkite eilutę (be kabučių):
   `TELEGRAM_BOT_TOKEN=<naujas token'as>`
3. Parašykite savo botui bet ką (privačiame pokalbyje), tada paleiskite `node tools\telegram-chatid.mjs`.
   Jis atspausdins tik chat id, username ir tipą (ne token'ą).
4. Tą chat id įrašykite į `.env.local`: `TELEGRAM_CHAT_ID=<skaičius>`. Daugiau nieko daryti nereikia:
   botas procesas ~1 min. laukia šio failo ir pats pasileidžia, o pirmas close-1 ciklas nusiųs vieną bandomąjį pranešimą.
5. BotFather → `/setcommands` → įklijuokite:

```
start - Boto būsena
status - Visa sistemos suvestinė
close1 - Close Call būsena
trades - 20 sandorių analizė
unknown - Neišspręsti sandoriai
archive - Oficialaus archyvo būsena
github - GitHub stebėjimas
host - Mini PC ir updateris
alerts - Naujausi perspėjimai
forensics - Perskaičiuoti įrodymus
settings - Stebėjimo nustatymai
mode - Operator režimas
help - Komandų sąrašas
```

## Kas leidžiama

Tik privatus pokalbis, kurio id lygus `TELEGRAM_CHAT_ID`. Kiti gauna `Unauthorized.` (grupės ir kanalai: nieko).
`/set` leidžia tik: `alert_level critical|normal|all`, `quiet_mode on|off`, `github_interval 15-360`,
`archive_threshold 10-500`. Pakeitimai saugomi `data/local/telegram/settings.json`, žurnalas `operator-audit.jsonl`.
Quiet mode niekada nenutildo kritinių pranešimų (antras rašytojas, hash neatitikimas, režimo pakeitimas, tikras įrašas, konfliktas).
