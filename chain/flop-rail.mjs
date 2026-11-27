#!/usr/bin/env node
/**
 * Local tclk settlement service for the flop-htlc rail on FLOP Testnet.
 *
 *   node flop-rail.mjs            serve on 127.0.0.1:8791 (FLOP-rail task)
 *   node flop-rail.mjs --status   print the Scribe balance, journal tail and policy, then exit
 *
 * The daemon in C:\TriAgent has no Polkadot dependencies, so the tclk payer lane asks
 * this process to move FLOP. It wraps the official @flop-labs/tclk-flop rail (built in
 * C:\FlopChain\tclk), pins the Testnet genesis and signs only what rail-policy.mjs
 * allows:
 *
 *   POST /rail/lock    {terms}            payer key (Scribe) opens an escrow  -> {ref}
 *   POST /rail/verify  {terms, ref}       read-only                           -> {ok}
 *   POST /rail/refund  {ref}              payer key, only once the chain allows it
 *   POST /rail/claim   {ref, secret}      payee key (Scout), only escrows paying the Scout
 *   GET  /rail/status
 *
 * Every submission is journalled BEFORE signing (data/local/flop-rail-journal.jsonl,
 * `lock-pending` from tclk-flop's persistPending), so a lost answer can never lead to a
 * second deposit for the same contract: the policy refuses any contract with an attempt
 * in the journal. A failure before chain.open is journalled `lock-unsent` and voids it.
 * The Scribe's free balance must cover the amount plus a fee reserve before any lock, and
 * the RPC's finalized head must be within 30 blocks of testnet.flopscan.io's. Requests are handled one at a
 * time. Never retried automatically (the rail's own rule).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentSigner, agentIdentity, DATA } from './net.mjs';
import { checkLock, checkClaim, checkFunds, checkChainHealth, lockedInDay, DEFAULT_POLICY } from './rail-policy.mjs';

const PORT = Number(process.env.FLOP_RAIL_PORT || 8791);
const RPC = process.env.FLOP_RAIL_RPC || 'wss://testnet.flop.network/';
const GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const TCLK_FLOP = process.env.TCLK_FLOP_DIST || 'C:/FlopChain/tclk/flop/dist/index.js';
const INDEXER = process.env.FLOP_RAIL_INDEXER || 'https://testnet.flopscan.io';
const JOURNAL = path.join(DATA, 'data/local', 'flop-rail-journal.jsonl');

const payerDid = agentIdentity('scribe').did;
const payeeDid = agentIdentity('scout').did;
const ownDids = [payerDid, payeeDid];

function journal() {
  try { return fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function note(entry) {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
/** The public terms inside a flop1. reference (no secret is ever in one). */
export function refTerms(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('flop1.') || ref.length > 3500) throw new Error('malformed reference');
  return JSON.parse(Buffer.from(ref.slice(6), 'base64url').toString('utf8')).terms;
}

const { connectFlopRail } = await import(pathToFileURL(TCLK_FLOP).href);
async function withRail(agent, fn, pendingEntry = {}) {
  const opts = { network: 'testnet', rpcUrl: RPC, expectedGenesisHash: GENESIS };
  if (agent) {
    opts.signer = await agentSigner(agent, 42);
    // tclk-flop calls this just before it signs: from here on the lock may exist.
    opts.persistPending = async (pendingRef) => note({ kind: 'lock-pending', agent, ...pendingEntry, pendingRef });
  }
  const c = await connectFlopRail(opts);
  try { return await fn(c); } finally { await c.disconnect().catch(() => {}); }
}

/**
 * The agent's free balance (base units) and the health of the RPC it was read from:
 * the RPC's finalized height against the indexer's, from a genesis-checked connection.
 */
async function chainView(agent) {
  const { ApiPromise, WsProvider } = await import('@polkadot/api');
  const provider = new WsProvider(RPC);
  const api = await ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
  try {
    if (api.genesisHash.toHex() !== GENESIS) throw new Error('genesis mismatch');
    const pair = await agentSigner(agent, 42);
    const free = (await api.query.system.account(pair.address)).data.free.toBigInt();
    const rpcFinalized = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
    const syncing = (await api.rpc.system.health()).isSyncing.isTrue;
    let indexerFinalized = null;
    try {
      const r = await fetch(`${INDEXER}/api/stats`, { signal: AbortSignal.timeout(20_000) });
      indexerFinalized = (await r.json())?.finality?.finalizedBlock ?? null;
    } catch { /* unknown, so unhealthy */ }
    const health = checkChainHealth({ rpcFinalized, indexerFinalized, syncing });
    return { free, rpcFinalized, indexerFinalized, syncing, health };
  } finally { await api.disconnect().catch(() => {}); }
}

async function handle(method, url, body) {
  if (method === 'GET' && url === '/rail/status') {
    const j = journal();
    let view = null; let balanceError = null;
    try { view = await chainView('scribe'); } catch (err) { balanceError = err.message; }
    const payerFree = view ? view.free : null;
    // Funded: one more deal at the per-deal cap fits, with the fee reserve left over,
    // and the RPC is in sync enough to anchor it. The payer offers nothing otherwise.
    const funded = payerFree !== null && checkFunds(payerFree, DEFAULT_POLICY.maxLockPlanck).ok && view.health.ok;
    return { payer: payerDid, payee: payeeDid, payerFree: payerFree === null ? null : String(payerFree), funded, balanceError,
      chain: view ? { rpcFinalized: view.rpcFinalized, indexerFinalized: view.indexerFinalized, syncing: view.syncing, health: view.health.why } : null,
      policy: Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([k, v]) => [k, String(v)])),
      lockedToday: String(lockedInDay(j, Date.now())), journal: j.slice(-10) };
  }
  if (method !== 'POST') return { status: 404, error: 'not found' };

  if (url === '/rail/verify') {
    const ok = await withRail(null, (c) => c.rail.verifyLock(body.terms, body.ref));
    return { ok };
  }
  if (url === '/rail/lock') {
    const terms = body.terms;
    const verdict = checkLock(terms, { payerDid, ownDids, journal: journal(), now: Date.now() });
    if (!verdict.ok) { note({ kind: 'lock-refused', contract: terms?.contract, why: verdict.why }); return { status: 403, error: verdict.why }; }
    let view;
    try { view = await chainView('scribe'); } catch (err) { return { status: 503, error: `balance check failed: ${err.message}` }; }
    if (!view.health.ok) return { status: 503, error: `chain not ready: ${view.health.why}` };
    const funds = checkFunds(view.free, terms.amount);
    if (!funds.ok) { note({ kind: 'lock-refused', contract: terms.contract, why: funds.why }); return { status: 409, error: funds.why, unfunded: true }; }
    const entry = { contract: terms.contract, amount: terms.amount, payee: terms.payee };
    try {
      const ref = await withRail('scribe', (c) => c.rail.lock(terms), entry);
      note({ kind: 'lock', ...entry, ref });
      return { ref };
    } catch (err) {
      if (!err.pendingRef) {
        // tclk-flop failed before chain.open (connect, stale anchor, window closed):
        // nothing was signed, so this attempt is void and the deal may try again.
        note({ kind: 'lock-unsent', contract: terms.contract, error: err.message });
        return { status: 503, error: err.message };
      }
      note({ kind: 'lock-error', ...entry, error: err.message, txHash: err.txHash ?? null, pendingRef: err.pendingRef });
      return { status: 502, error: err.message, uncertain: true };
    }
  }
  if (url === '/rail/refund') {
    let terms; try { terms = refTerms(body.ref); } catch (err) { return { status: 400, error: err.message }; }
    if (terms.payer !== payerDid) return { status: 403, error: 'not a Scribe escrow' };
    try {
      await withRail('scribe', (c) => c.rail.refund(body.ref));
      note({ kind: 'refund', contract: terms.contract, amount: terms.amount });
      return { ok: true };
    } catch (err) {
      const waiting = /window is not open/.test(err.message);
      if (!waiting) note({ kind: 'refund-error', contract: terms.contract, error: err.message });
      return { status: waiting ? 409 : 502, error: err.message, waiting };
    }
  }
  if (url === '/rail/claim') {
    let terms; try { terms = refTerms(body.ref); } catch (err) { return { status: 400, error: err.message }; }
    const verdict = checkClaim(terms, { payeeDid });
    if (!verdict.ok) return { status: 403, error: verdict.why };
    try {
      await withRail('scout', (c) => c.rail.claim(body.ref, body.secret));
      note({ kind: 'claim', contract: terms.contract, amount: terms.amount, payer: terms.payer });
      return { ok: true };
    } catch (err) {
      note({ kind: 'claim-error', contract: terms.contract, error: err.message });
      return { status: 502, error: err.message };
    }
  }
  return { status: 404, error: 'not found' };
}

if (process.argv.includes('--status')) {
  console.log(JSON.stringify(await handle('GET', '/rail/status'), null, 2));
  const ok = await withRail(null, (c) => c.chain.snapshot()).then((s) => `testnet finalized #${s.finalizedNumber}`).catch((e) => `rail connect failed: ${e.message}`);
  console.log(ok);
  process.exit(0);
}

let queue = Promise.resolve();
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; if (raw.length > 20_000) req.destroy(); });
  req.on('end', () => {
    queue = queue.then(async () => {
      let out;
      try { out = await handle(req.method, req.url, raw ? JSON.parse(raw) : {}); } catch (err) { out = { status: 500, error: err.message }; }
      const { status = 200, ...rest } = out;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rest));
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log(`flop-rail on 127.0.0.1:${PORT} | testnet ${GENESIS.slice(0, 10)}… | payer scribe, payee scout`));
