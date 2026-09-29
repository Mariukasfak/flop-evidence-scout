#!/usr/bin/env node
/**
 * One-shot helper: find the chat id of the person who wrote to the bot.
 * Send any message to your bot in a private chat first, then run:
 *
 *   node tools/telegram-chatid.mjs
 *
 * Prints ONLY chat id, username and chat type (never the token, never the message).
 * It changes nothing: copy the id into .env.local yourself as TELEGRAM_CHAT_ID=...
 */
import path from 'node:path';
import { loadTelegramEnv } from '../src/close1/host.mjs';

const env = loadTelegramEnv({ file: path.resolve('.env.local') });
if (!env.TELEGRAM_BOT_TOKEN) { console.log('TELEGRAM_BOT_TOKEN is not set in .env.local (create a fresh token in BotFather first).'); process.exit(3); }
let body;
try {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }) });
  body = await r.json();
  if (!r.ok) { console.log(`Telegram said HTTP ${r.status} (${body?.description ?? 'error'}). If the bot service is running, stop it first: only one reader at a time.`); process.exit(1); }
} catch (err) { console.log(`Could not reach Telegram: ${String(err.message).split(env.TELEGRAM_BOT_TOKEN).join('[token]').slice(0, 120)}`); process.exit(1); }
const seen = new Map();
for (const u of body.result || []) {
  const c = u.message?.chat; if (!c) continue;
  seen.set(c.id, { id: c.id, username: c.username ? `@${c.username}` : '(nėra)', type: c.type });
}
if (!seen.size) console.log('Atnaujinimų nėra. Parašykite botui bet ką (privačiame pokalbyje) ir paleiskite dar kartą.');
for (const c of seen.values()) console.log(`chat id: ${c.id} · username: ${c.username} · type: ${c.type}${c.type === 'private' ? '' : '  (NE privatus: netinka)'}`);
