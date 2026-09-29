#!/usr/bin/env node
/**
 * FLOP-telegram-bot: the read-only Telegram operator console for close-1 (long polling).
 * A separate process from the close-1 runtime: if it dies or Telegram is down, monitoring,
 * archive reconciliation, the GitHub watcher and the dashboard carry on untouched.
 *
 *   node tools/telegram-bot.mjs
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment or in .env.local.
 * It never prints the token; every log line is scrubbed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTelegramEnv } from '../src/close1/host.mjs';
import { pollOnce, tgDir, scrub } from '../src/close1/telegram-bot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/local/close1');
const ENV_FILE = path.join(ROOT, '.env.local');
let env = loadTelegramEnv({ file: ENV_FILE });
const LOG = path.join(tgDir(DIR), 'bot.log');
const log = (m) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${scrub(m, env)}\n`); } catch { /* logging never stops the bot */ } };

/** Read-only: the forensics tool fetches the archive index and rewrites forensics.json; it cannot sign or post. */
function runForensics() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'tools/close1-forensics.mjs'), '--quiet'], { cwd: ROOT, timeout: 5 * 60_000, windowsHide: true }, (err) => {
      if (err) return reject(new Error(String(err.message).split('\n')[0]));
      try { resolve(JSON.parse(fs.readFileSync(path.join(DIR, 'forensics.json'), 'utf8'))); } catch (e) { reject(e); }
    });
  });
}

// Until the operator has put a fresh token and chat id into .env.local, wait (no fake values, no exit loop).
while (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
  log('NOT_CONFIGURED: waiting for TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.local');
  await new Promise((r) => setTimeout(r, 60_000));
  env = loadTelegramEnv({ file: ENV_FILE });
}
const ctx = { dataDir: DIR, env, busy: { forensics: false }, runForensics };
let delay = 1000;
log('bot started');
for (;;) {
  try {
    await pollOnce(ctx, { timeoutSec: 25 });
    delay = 1000;
  } catch (err) {
    log(`poll failed: ${String(err.message).slice(0, 160)}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60_000);
  }
}
