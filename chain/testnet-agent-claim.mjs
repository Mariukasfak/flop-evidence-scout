#!/usr/bin/env node
/**
 * The agent's signed Testnet faucet claim (10 test FLOP per wallet per rolling 24 h).
 *
 *   node testnet-agent-claim.mjs --agent scout [--check]
 *
 * Follows https://flop.network/llms.txt "Get Testnet FLOP" (2026-11-25):
 *   1. faucet GET /chain must report network testnet and the pinned genesis;
 *   2. GET /limits must show faucet.status open and agent.claimPath /v1/testnet/agent-claims;
 *   3. sign UTF-8 `flop-faucet-agent/v1|<genesis>|<address>|<nonce>` with the wallet's own key;
 *   4. POST {address, nonce, signature} to the claim path; keep txHash.
 * Repeating a request with the same nonce returns the same transaction and never pays
 * twice, so an unfinished claim is re-checked with its nonce; a new nonce is used only
 * after the previous claim reached a final result and 24 h have passed. Refusals are
 * logged, never retried in a loop. The TechnoCore room is NOT a Testnet claim path.
 *
 * User consent 2026-11-23: one official faucet request per agent (Scout, Scribe) per day.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getJson, agentSigner, logLine, DATA, opt } from './net.mjs';

const FAUCET = 'https://faucet.flop.network';
const GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const DAY_MS = 24 * 3600 * 1000;

const args = process.argv.slice(2);
const agent = opt(args, 'agent', 'scout');
const check = args.includes('--check');
if (!['scout', 'scribe'].includes(agent)) { console.log('agent must be scout or scribe'); process.exit(2); }

const get = (u) => getJson(u, 30_000).then((r) => r.body).catch((err) => { console.log(`faucet ${u} did not answer (${err.message}); nothing sent`); process.exit(2); });
const chain = await get(`${FAUCET}/chain`);
if (chain?.network !== 'testnet' || String(chain?.genesisHash).toLowerCase() !== GENESIS) {
  console.log(`faucet /chain is ${chain?.network} ${String(chain?.genesisHash).slice(0, 12)}…, not the pinned testnet; nothing sent`); process.exit(2);
}
const limits = await get(`${FAUCET}/limits`);
const claimPath = limits?.faucet?.agent?.claimPath;
if (limits?.faucet?.status !== 'open' || claimPath !== '/v1/testnet/agent-claims') {
  console.log(`faucet status ${limits?.faucet?.status}, claimPath ${claimPath}; nothing sent`); process.exit(2);
}

const signer = await agentSigner(agent, chain.ss58Format ?? 42);
const address = signer.address;

const stateFile = path.join(DATA, 'data/local', 'flop-testnet-claim-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first claim */ }
const prev = state[agent];
const prevFinal = prev && ['funded', 'refused'].includes(prev.result);
let nonce;
if (prev && !prevFinal) nonce = prev.nonce; // re-check the unfinished claim, never a second one
else if (prev && Date.now() - Date.parse(prev.at) < DAY_MS) {
  console.log(`${agent} ${address}: last claim ${prev.at} ended ${prev.result}; next one after 24 h; nothing sent`); process.exit(0);
} else nonce = String(Date.now());

console.log(`testnet ${GENESIS.slice(0, 10)}… faucet open (balance ${limits.faucet.balanceFlop} FLOP, pending ${limits.faucet.pendingGrants}) | ${agent} ${address} | nonce ${nonce}${prev && !prevFinal ? ' (re-check)' : ''}`);
if (check) { console.log('check only: nothing sent'); process.exit(0); }

const { u8aToHex, stringToU8a } = await import('@polkadot/util');
const signature = u8aToHex(signer.sign(stringToU8a(`flop-faucet-agent/v1|${GENESIS}|${address}|${nonce}`)));

// Record the nonce BEFORE sending: a lost answer is re-checked with the same nonce.
state[agent] = { at: prev && !prevFinal ? prev.at : new Date().toISOString(), nonce, address, result: 'sent' };
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

let status = null; let body = null; let error = null;
try {
  const res = await fetch(`${FAUCET}${claimPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, nonce, signature }), signal: AbortSignal.timeout(60_000),
  });
  status = res.status;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
} catch (err) { error = err.message; }

const txHash = body?.txHash ?? body?.tx ?? null;
// address_cooldown: this wallet was already paid in the last 24 h (an earlier claim), a final answer.
const result = error ? 'sent' : status >= 200 && status < 300 && txHash ? 'funded' : body?.reason === 'address_cooldown' ? 'refused' : status >= 400 && status < 500 && status !== 429 ? 'refused' : 'sent';
state[agent] = { ...state[agent], result, status, txHash, reason: body?.reason ?? null, retryAfterSeconds: body?.retryAfterSeconds ?? null };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
logLine('flop-testnet-claim.jsonl', { agent, address, nonce, status, result, txHash, body: body && JSON.stringify(body).slice(0, 600), error });
console.log(error ? `no answer (${error}); re-run later re-checks nonce ${nonce}` : `HTTP ${status}: ${JSON.stringify(body).slice(0, 500)}`);
console.log(`result: ${result}${txHash ? `, tx ${txHash} (spendable once finalized)` : ''}`);
