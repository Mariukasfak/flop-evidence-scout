#!/usr/bin/env node
/**
 * One faucet request for one agent's own address, once per UTC day.
 *
 *   node faucet-claim.mjs [--agent scout] [--check]
 *
 * The faucet's /limits decides the route: a published `agent.claimPath` (testnet,
 * 2026-11-25) gets a signed agent claim, otherwise POST <faucet>/fund. Nothing is
 * requested while the faucet reports a status other than `open` (low_balance etc.).
 * Never retries a claim that may have paid: an `unknown` outcome is logged and
 * left for the next day. Only a 401 bad-signature refusal (checked before any
 * cooldown) moves on to the next signing form. The faucet's /chain genesis must
 * match the RPC before anything is requested. Results append to
 * data/local/flop-faucet.jsonl.
 *
 * Rules: only our agents' own addresses, never extra wallets to multiply grants
 * (common control is one participant). The verified (Self) grant is the user's
 * action in the faucet page; this script does not touch it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { networkConfig, connect, agentSigner, logLine, flop, opt, getJson, DATA } from './net.mjs';
import { claimPlan, agentClaimMessage, wrapBytes, isSignatureRefusal, claimedToday } from './faucet-lib.mjs';

const args = process.argv.slice(2);
const agent = opt(args, 'agent', 'scout');
const cfg = networkConfig();
const { api, info } = await connect(cfg);
const pair = await agentSigner(agent);
const free = async () => (await api.query.system.account(pair.address)).data.free.toBigInt();
const before = await free();
console.log(`${new Date().toISOString()} ${agent} ${pair.address} on ${info.chain} free ${flop(before)} FLOP`);
const done = async (code) => { await api.disconnect(); process.exit(code); };
if (args.includes('--check')) await done(0);
// A chain read through the pin alone has no faucet to ask (and must not ask one on another chain).
if (!info.faucetLive) { console.log(`no faucet for this chain yet: ${info.faucetError}`); await done(2); }

const logFile = path.join(DATA, 'data/local', 'flop-faucet.jsonl');
const lines = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  : [];
if (claimedToday(lines, { agent, genesis: info.genesisHash })) {
  console.log(`already claimed (accepted or unknown) for ${agent} on this chain today (UTC); not repeating`);
  await done(2);
}

let limits = null;
try {
  const r = await getJson(`${cfg.faucet}/limits`);
  if (r.status === 200 && r.body?.faucet) limits = r.body; else console.log(`faucet /limits answered ${r.status}`);
} catch (err) { console.log(`faucet /limits unreadable: ${err.message}`); }
const plan = claimPlan(limits);
// Without readable limits the route is unknown (testnet closed /fund): request nothing.
if (!limits) plan.ready = false;
if (!plan.ready) {
  console.log(`faucet not ready (status ${plan.status}); nothing requested`);
  logLine('flop-faucet.jsonl', { agent, address: pair.address, chain: info.chain, genesis: info.genesisHash, mode: plan.mode, outcome: 'not-ready', error: plan.status });
  await done(3);
}

async function post(body) {
  const res = await fetch(`${cfg.faucet}${plan.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  });
  let json = {};
  try { json = await res.json(); } catch { json = {}; }
  const refusal = res.headers.get('x-flop-refusal-reason');
  if (refusal) json.refusalReason = refusal;
  return { status: res.status, retryAfter: res.headers.get('retry-after') ?? json.retryAfterSeconds ?? null, body: json };
}

let status = 0; let body = {}; let retryAfter = null; let outcome; let form = null;
try {
  if (plan.mode === 'agent-claim') {
    const nonce = String(Date.now());
    const msg = agentClaimMessage(info.genesisHash, pair.address, nonce);
    for (const f of ['raw', 'bytes-wrapped']) {
      form = f;
      const signed = new TextEncoder().encode(f === 'raw' ? msg : wrapBytes(msg));
      const signature = `0x${Buffer.from(pair.sign(signed)).toString('hex')}`;
      ({ status, body, retryAfter } = await post({ address: pair.address, nonce, signature }));
      if (!isSignatureRefusal(status, body)) break;
    }
  } else {
    ({ status, body, retryAfter } = await post({ address: pair.address, client: 'flop-evidence-scout' }));
  }
  outcome = status >= 200 && status < 300 && body.success !== false ? 'accepted' : (status === 503 || status >= 500 ? 'unavailable' : 'refused');
} catch (err) {
  outcome = 'unknown';
  body = { error: err.name === 'TimeoutError' ? 'timeout' : err.message };
}
await new Promise((r) => setTimeout(r, outcome === 'accepted' ? 20_000 : 0));
const after = await free();
const entry = {
  agent, address: pair.address, chain: info.chain, genesis: info.genesisHash, mode: plan.mode, form, status, outcome,
  amount: body.amount ?? body.amountFlop ?? null, tier: body.tier ?? null, txHash: body.txHash ?? body.tx ?? null,
  error: body.error ?? body.reason ?? body.refusalReason ?? null, reason: body.reason ?? null, retryAfter,
  freeBefore: before.toString(), freeAfter: after.toString()
};
logLine('flop-faucet.jsonl', entry);
console.log(`${outcome} (${status}) ${plan.mode}${form ? `/${form}` : ''} amount ${entry.amount ?? '-'} ${entry.error ? `reason ${entry.error}` : ''}${retryAfter ? ` retry-after ${retryAfter}s` : ''} free now ${flop(after)} FLOP`);
await done(outcome === 'accepted' ? 0 : 2);
