## Gemini handoff: ChatStore implementacija

- **Pakeisti failai (Changed files)**:
  - `src/core/chat-store.mjs` (NEW)
  - `test/chat-store.test.mjs` (NEW)
  - `.codex/gemini-handoff.md`

- **Įgyvendinta elgsena (Implemented behavior)**:
  - Sukurta `ChatStore` klasė (`src/core/chat-store.mjs`), sauganti pokalbius atskirame `<dataRoot>/chats` pakatalogyje.
  - `createChat({ chatId, title?, createdAt? })`: sukuria naują pokalbį su stabiliu identifikatoriumi, saugiu numatytuoju pavadinimu (`Naujas pokalbis`), `createdAt`/`updatedAt` laiko žymomis ir tuščiu `messages: []` masyvu.
  - `listChats()`: grąžina pokalbių metaduomenis (`chatId`, `title`, `createdAt`, `updatedAt`, `messageCount`), surikiuotus pagal vėliausiai atnaujintus (`updatedAt` mažėjančia tvarka).
  - `getChat(chatId)`: grąžina pokalbio metaduomenis bei visų žinučių seką, meta aiškią klaidą (`Chat not found: ...`), jei pokalbis neegzistuoja.
  - `appendUserMessage(chatId, { content, runId, createdAt? })` ir `appendAssistantMessage(chatId, { content, runId, createdAt?, council? })`: prideda žinutes su schema `{ id, role, content, runId, createdAt, council? }` ir atnaujina `updatedAt`.
  - Izoliuoti append-only JSONL failai (`<chatId>.jsonl`) kiekvienam pokalbiui.
  - Lygiagrečių įrašų serializavimas (`_enqueue`) užkerta kelią lenktynių sąlygoms (race conditions) ir žinučių praradimui.
  - Griežta validacija: apsauga nuo kelio kirtimo (path traversal / `SAFE_CHAT_ID`), tuščio turinio tikrinimas, vaidmenų tikrinimas, `council` JSON-serializuojamumo tikrinimas.
  - Garsus klaidų kėlimas (loud failure) esant sugadintoms JSONL eilutėms ar netikėtiems įvykiams.
  - Jokių išorinių priklausomybių ir jokio tinklo naudojimo.

- **Patikros ir rezultatai (Checks run and results)**:
  - **RED**: `node --test test/chat-store.test.mjs` baigėsi klaida (`ERR_MODULE_NOT_FOUND: Cannot find module '...src/core/chat-store.mjs'`).
  - **GREEN**: `node --test test/chat-store.test.mjs` praeina visiškai: 13 testų, 13 pass, 0 fail.
  - Regresinė patikra: `node --test test/core.test.mjs test/learning-registry.test.mjs test/run-store-integrity.test.mjs` (28/28 pass).

- **Žinomos rizikos ir apribojimai (Known risks)**:
  - Pokalbių JSONL failai auga append-only režimu be failų suspaudimo ar archyvavimo.
  - Lygiagretumo eilė (`_queues`) veikia proceso lygiu (in-process).

- **Kitas žingsnis (Next exact step)**:
  - Atlikta Codex integracija: `ChatStore` prijungtas prie HTTP maršrutų, orkestratoriaus izoliuoto konteksto ir pokalbių UI.
  - `npm run check`: 93/93 testai ir build praeina.
  - Playwright patikrino pokalbių korteles, švarų naują pokalbį, išsaugotą „Jūs ↔ TriAgent“ dialogą ir išskleidžiamą tarybos auditą; naršyklės konsolėje 0 klaidų.
