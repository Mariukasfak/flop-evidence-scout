#!/usr/bin/env node
/**
 * Our agents and the FLOP gateway (api.flop.network), from the live checkout.
 *
 *   node tools/flop-gateway.mjs status   [--agent scout]   quota, expiry, receipts (no key printed)
 *   node tools/flop-gateway.mjs enroll   --agent scribe    ONE enrollment attempt, key saved to .secrets/
 *   node tools/flop-gateway.mjs ask "prompt" [--agent]     one paid request
 *   node tools/flop-gateway.mjs rehearse [--agent]         the scheduled devnet rehearsal (below)
 *
 * Exit codes: 0 done or nothing to do, 2 refused for now (daily cap, paused,
 * overloaded, timed out), 1 anything else. A key file that exists is never overwritten:
 * re-enrolling an address rotates the bearer without renewing the allowance,
 * so a second attempt buys nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { enrollWallet, gatewayStatus, GATEWAY } from '../src/flop-gateway.mjs';
import { flopSessionBackend, readSessionToken } from '../src/inference-backends.mjs';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const agent = opt('agent', 'scout');
const secrets = opt('secrets', path.resolve('.secrets'));
// The scout's first key predates this tool and kept its original name.
const keyPath = path.join(secrets, agent === 'scout' ? 'flop-gateway.json' : `flop-gateway-${agent}.json`);
const identityPath = path.join(secrets, `${agent}-identity.json`);
const logPath = path.resolve('data/local/flop-gateway-log.jsonl');
const REHEARSAL_SERVED = 3;
// Bounded enrollment retries: at most one attempt per scheduled run (task every 2 h).
// Cap refusals clear for wallets that keep retrying, without operator action
// (flop-labs/network#334); one try per UTC day was too sparse to land.
const ENROLL_RETRY_MS = 100 * 60 * 1000;
const REHEARSAL_PROMPT = 'In one sentence, what does a compute channel settle on the FLOP network?';

const log = (entry) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), agent, ...entry })}\n`);
};
const readLog = () => {
  try {
    return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.agent === agent);
  } catch { return []; }
};
const held = () => readSessionToken({ tokenFile: keyPath });
const live = (k) => Boolean(k.token) && (!k.expiresAt || k.expiresAt > Date.now() + 60_000);

async function enroll() {
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const out = await enrollWallet(identity);
  if (!out.ok) {
    log({ event: 'enroll_refused', stage: out.stage, status: out.status, code: out.code });
    console.log(`${agent}: enrollment refused at ${out.stage}: HTTP ${out.status} ${out.code ?? ''}`);
    return [0, 429, 503].includes(out.status) ? 2 : 1;
  }
  fs.writeFileSync(keyPath, JSON.stringify({ ...out.body, address: out.address, enrolledAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  log({ event: 'enrolled', address: out.address, model: out.body.model, quota: out.body.remaining_quota, expires_at: out.body.expires_at });
  console.log(`${agent}: enrolled ${out.address}, model ${out.body.model}, quota ${out.body.remaining_quota} (key saved, not printed)`);
  return 0;
}

async function ask(prompt) {
  // No model named: the backend asks for the one this key was enrolled for
  // (the gateway refuses any other with 401), else the smallest catalog model.
  const backend = flopSessionBackend({
    url: `${GATEWAY}/v1/chat/completions`, tokenFile: keyPath, model: held().model ?? 'qwen/qwen2.5-0.5b-instruct'
  });
  try {
    const out = await backend.generate({ prompt, request: { maxTokens: 64 } });
    log({ event: 'served', request_id: out.raw.requestId, id: out.raw.sessionId, cost_flop: out.raw.reportedFeeFlop, completion_tokens: out.completionTokens });
    console.log(out.text);
    console.log(`request ${out.raw.requestId} cost_flop ${out.raw.reportedFeeFlop}`);
    return 0;
  } catch (err) {
    log({ event: 'refused', error: err.message });
    console.log(err.message);
    return 2;
  }
}

async function status() {
  const s = await gatewayStatus(held().token);
  return { agent, keyExpires: held().expiresAt ? new Date(held().expiresAt).toISOString() : null, ...s };
}

/**
 * The devnet rehearsal, for a scheduled task. At most one enrollment attempt per
 * run (ENROLL_RETRY_MS apart) while the cap refuses (flop-labs/network#141), then one request
 * per run until three are served, then nothing. Devnet spend earns no airdrop
 * weight; the point is one end-to-end served-and-settled session before testnet,
 * where the same code spends the allowance that counts.
 */
async function rehearse() {
  const entries = readLog();
  const served = entries.filter((e) => e.event === 'served').length;
  if (served >= REHEARSAL_SERVED) { console.log(`${agent}: rehearsal done (${served} served)`); return 0; }
  const key = held();
  if (!key.token) {
    const last = entries.filter((e) => e.event.startsWith('enroll')).reduce((m, e) => Math.max(m, Date.parse(e.at) || 0), 0);
    if (Date.now() - last < ENROLL_RETRY_MS) {
      console.log(`${agent}: last enrollment attempt ${new Date(last).toISOString()}, next after ${new Date(last + ENROLL_RETRY_MS).toISOString()}`);
      return 0;
    }
    const code = await enroll();
    if (code !== 0) return code;
  } else if (!live(key)) {
    console.log(`${agent}: allowance expired with ${served} served`);
    return 0;
  }
  const code = await ask(REHEARSAL_PROMPT);
  try {
    const s = await status();
    log({ event: 'status', remaining_quota: s.remainingQuota, receipts: s.receipts, byState: s.byState, settled_spend_raw: s.settledSpendRaw });
  } catch (err) {
    log({ event: 'status_failed', error: err.message });
  }
  return code;
}

let exit = 1;
if (cmd === 'enroll') {
  const key = held();
  if (key.token) {
    console.log(`${agent}: key file exists (${live(key) ? 'live' : 'expired'}); not re-enrolling`);
    exit = live(key) ? 0 : 1;
  } else {
    exit = await enroll();
  }
} else if (cmd === 'rehearse') {
  exit = await rehearse();
} else if (!held().token) {
  console.log(`${agent}: no gateway key at ${keyPath}`);
} else if (cmd === 'status') {
  console.log(JSON.stringify(await status(), null, 2));
  exit = 0;
} else if (cmd === 'ask' && args[1] && !args[1].startsWith('--')) {
  exit = await ask(args[1]);
} else {
  console.log('commands: status | enroll | ask "prompt" | rehearse');
}
process.exit(exit);
