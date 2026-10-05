#!/usr/bin/env node
/**
 * Scheduled on the mini PC every 15 minutes: pause the kibble lanes on the first
 * fresh not-useful verdict against our work, and say so on Telegram.
 * See src/kibble-guard.mjs for why the tape and not the score.
 *
 *   node tools/kibble-guard.mjs          check, pause if needed
 *   node tools/kibble-guard.mjs --arm    start counting from now (after resuming)
 *
 * Resuming is deliberate: delete data/local/kibble-paused.json, then --arm.
 */
import fs from 'node:fs';
import path from 'node:path';

import { freshMistakes, readPause, writePause, GUARD_STATE_FILE, PAUSE_FILE } from '../src/kibble-guard.mjs';
import { deliverAlerts } from '../src/close1/runtime.mjs';
import { loadTelegramEnv } from '../src/close1/host.mjs';

const dir = path.resolve(process.argv.find((a) => a.startsWith('--data-dir='))?.slice(11) || 'data/local');
const statePath = path.join(dir, GUARD_STATE_FILE);
const now = new Date().toISOString();

let state = null;
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
if (!state || process.argv.includes('--arm')) {
  state = { armedAt: now, seen: [] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  console.log(`${now} armed — counting not-useful verdicts on deliveries from now on`);
  process.exit(0);
}

let messages;
try {
  const res = await fetch('https://technocore.chat/r/kibble/export', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  messages = (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch (err) {
  // A tape we cannot read is not evidence of anything; the next run looks again.
  console.log(`${now} tape unreadable (${err.message}) — no change`);
  process.exit(0);
}

const mistakes = freshMistakes(messages, { since: state.armedAt, seen: new Set(state.seen) });
state.seen = [...state.seen, ...mistakes.map((m) => m.seq)].slice(-500);
state.lastCheckAt = now;
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

if (!mistakes.length) {
  console.log(`${now} clean — ${messages.length} tape lines, nothing against our work since ${state.armedAt}${readPause(dir) ? ' (still paused)' : ''}`);
  process.exit(0);
}

const wasPaused = Boolean(readPause(dir));
writePause(dir, { at: now, reason: `${mistakes.length} not-useful verdict(s) on our deliveries`, mistakes: mistakes.slice(0, 20) });
const lines = mistakes.slice(0, 5).map((m) => `• ${m.jobId}: ${String(m.reason).slice(0, 160)}`).join('\n');
const text = `Kibble ${wasPaused ? 'vis dar sustabdytas' : 'SUSTABDYTAS'}: ${mistakes.length} nauji „not useful" mūsų darbams.\n${lines}\n`
  + `Tęsti: ištrinti data/local/${PAUSE_FILE} ir paleisti node tools/kibble-guard.mjs --arm`;
await deliverAlerts([{ kind: 'kibble_paused', text }], { logFile: path.join(dir, 'close1', 'alerts.jsonl'), env: loadTelegramEnv() });
console.log(`${now} PAUSED — ${mistakes.length} fresh not-useful verdict(s)\n${lines}`);
