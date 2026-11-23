#!/usr/bin/env node
/**
 * One faucet request for one agent's own address: the anonymous daily grant.
 *
 *   node faucet-claim.mjs [--agent scout] [--check]
 *
 * POST <faucet>/fund { address } once. Never retries: an `unknown` outcome may
 * have paid, so it is logged and left for the next day's run. A refusal with
 * Retry-After is logged as such. The faucet's /chain genesis must match the RPC
 * before anything is requested. Results append to data/local/flop-faucet.jsonl.
 *
 * Rules: only our agents' own addresses, never extra wallets to multiply grants
 * (common control is one participant). The verified (Self) grant is the user's
 * action in the faucet page; this script does not touch it.
 */
import { networkConfig, connect, agentSigner, logLine, flop, opt } from './net.mjs';

const args = process.argv.slice(2);
const agent = opt(args, 'agent', 'scout');
const cfg = networkConfig();
const { api, info } = await connect(cfg);
const pair = await agentSigner(agent);
const free = async () => (await api.query.system.account(pair.address)).data.free.toBigInt();
const before = await free();
console.log(`${new Date().toISOString()} ${agent} ${pair.address} on ${info.chain} free ${flop(before)} FLOP`);
if (args.includes('--check')) { await api.disconnect(); process.exit(0); }

let status = 0; let body = {}; let retryAfter = null; let outcome;
try {
  const res = await fetch(`${cfg.faucet}/fund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: pair.address, client: 'flop-evidence-scout' }),
    signal: AbortSignal.timeout(120_000)
  });
  status = res.status;
  retryAfter = res.headers.get('retry-after');
  const refusal = res.headers.get('x-flop-refusal-reason');
  try { body = await res.json(); } catch { body = {}; }
  if (refusal) body.refusalReason = refusal;
  outcome = res.ok && body.success !== false ? 'accepted' : (status === 503 || status >= 500 ? 'unavailable' : 'refused');
} catch (err) {
  outcome = 'unknown';
  body = { error: err.name === 'TimeoutError' ? 'timeout' : err.message };
}
await new Promise((r) => setTimeout(r, outcome === 'accepted' ? 20_000 : 0));
const after = await free();
const entry = {
  agent, address: pair.address, chain: info.chain, genesis: info.genesisHash, status, outcome,
  amount: body.amount ?? null, tier: body.tier ?? null, txHash: body.txHash ?? null,
  error: body.error ?? body.reason ?? body.refusalReason ?? null, retryAfter,
  freeBefore: before.toString(), freeAfter: after.toString()
};
logLine('flop-faucet.jsonl', entry);
console.log(`${outcome} (${status}) amount ${entry.amount ?? '-'} tier ${entry.tier ?? '-'} ${entry.error ? `reason ${entry.error}` : ''}${retryAfter ? ` retry-after ${retryAfter}s` : ''} free now ${flop(after)} FLOP`);
await api.disconnect();
process.exit(outcome === 'accepted' ? 0 : 2);
