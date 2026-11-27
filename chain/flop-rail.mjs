#!/usr/bin/env node
/**
 * Local tclk settlement service for the flop-htlc rail on FLOP Testnet.
 *
 *   node flop-rail.mjs            serve on 127.0.0.1:8791 (FLOP-rail task)
 *   node flop-rail.mjs --status   print balances, journal tail and policy, then exit
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
 * Every submission is journalled BEFORE signing (data/local/flop-rail-journal.jsonl),
 * so a lost answer can never lead to a second deposit for the same contract: the
 * policy refuses any contract already in the journal. Requests are handled one at a
 * time. Never retried automatically (the rail's own rule).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentSigner, agentIdentity, DATA } from './net.mjs';
import { checkLock, checkClaim, lockedInDay, DEFAULT_POLICY } from './rail-policy.mjs';

const PORT = Number(process.env.FLOP_RAIL_PORT || 8791);
const RPC = process.env.FLOP_RAIL_RPC || 'wss://testnet.flop.network/';
const GENESIS = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const TCLK_FLOP = process.env.TCLK_FLOP_DIST || 'C:/FlopChain/tclk/flop/dist/index.js';
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
async function withRail(agent, fn) {
  const opts = { network: 'testnet', rpcUrl: RPC, expectedGenesisHash: GENESIS };
  if (agent) {
    opts.signer = await agentSigner(agent, 42);
    opts.persistPending = async (pendingRef) => note({ kind: 'pending-ref', agent, pendingRef });
  }
  const c = await connectFlopRail(opts);
  try { return await fn(c); } finally { await c.disconnect().catch(() => {}); }
}

async function handle(method, url, body) {
  if (method === 'GET' && url === '/rail/status') {
    const j = journal();
    return { payer: payerDid, payee: payeeDid, policy: Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([k, v]) => [k, String(v)])),
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
    note({ kind: 'lock-pending', contract: terms.contract, amount: terms.amount, payee: terms.payee });
    try {
      const ref = await withRail('scribe', (c) => c.rail.lock(terms));
      note({ kind: 'lock', contract: terms.contract, amount: terms.amount, payee: terms.payee, ref });
      return { ref };
    } catch (err) {
      note({ kind: 'lock-error', contract: terms.contract, error: err.message, txHash: err.txHash ?? null, ref: err.ref ?? null });
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
