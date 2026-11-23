#!/usr/bin/env node
/**
 * The daemon's paid FLOP lane: one LongSession on one named miner, served to the
 * daemon on loopback in the shape src/inference-backends.mjs flopSessionBackend
 * already speaks for a plain route.
 *
 *   node flop-lane.mjs [--config lane.json]
 *
 *   GET  /lane          200 while the lane can buy, 503 {reason} otherwise; the
 *                       daemon's backend selection treats 503 as "use Ollama".
 *   POST /lane          {model, prompt, max_tokens} -> {text, model, prompt_tokens,
 *                       completion_tokens, session_id, miner}
 *   GET  /lane/status   budget, today's spend, live channel, counters.
 *
 * Daemon side: FLOP_SESSION_URL=http://127.0.0.1:<port>/lane in .env.local.
 *
 * lane.json (beside this script), amounts in FLOP:
 *   { "agent": "scout", "miner": "<ss58>", "endpoint": "https://…", "enclaveKey": "0x…",
 *     "model": "qwen/qwen2.5-0.5b-instruct", "backendModel": "Qwen/Qwen2.5-0.5B-Instruct",
 *     "windowSeconds": 900, "channel": 1, "topUp": 0.1, "turnAtoms": 1000000, "turnTimeout": 60,
 *     "reserve": 2, "dayCap": null, "port": 8790, "maxTokens": 512 }
 *
 * Money: the SDK journal (data/local/flop-journal/<agent>) holds the lifetime debit.
 * The session budget is that debit plus what may still go today:
 * min(free balance - reserve, dayCap - spent today). When the session hits it, the
 * live channel is settled cooperatively and the lane answers 503 until a refresh
 * (every 10 minutes) finds new room, e.g. after the daily faucet grant. Unknown tx
 * outcomes freeze purchases in the SDK; the lane then stays 503 until a person runs
 * recover. Real daemon work only: the lane never invents a request.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeChannel } from '@flop-labs/sdk';
import { networkConfig, connect, agentSigner, logLine, DATA, flop, opt } from './net.mjs';
import { resolveModelIdentity } from './model-identity.mjs';

const args = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(fs.readFileSync(opt(args, 'config', path.join(here, 'lane.json')), 'utf8'));
const P = (flopAmount) => BigInt(Math.round(Number(flopAmount) * 1e6)) * 10n ** 12n;
const c = {
  agent: conf.agent ?? 'scout', miner: conf.miner, endpoint: conf.endpoint, enclaveKey: conf.enclaveKey ?? null,
  model: conf.model ?? 'qwen/qwen2.5-0.5b-instruct', backendModel: conf.backendModel ?? 'Qwen/Qwen2.5-0.5B-Instruct',
  windowSeconds: Number(conf.windowSeconds ?? 900), channel: P(conf.channel ?? 1), topUp: P(conf.topUp ?? 0.1),
  turnAtoms: BigInt(conf.turnAtoms ?? 1_000_000), turnTimeout: Number(conf.turnTimeout ?? 60), reserve: P(conf.reserve ?? 2),
  dayCap: conf.dayCap == null ? null : P(conf.dayCap), port: Number(conf.port ?? 8790), maxTokens: Number(conf.maxTokens ?? 512)
};
if (!c.miner || !c.endpoint) throw new Error('lane.json needs miner and endpoint');
if (c.enclaveKey && !/^0x[0-9a-fA-F]{64}$/.test(c.enclaveKey)) throw new Error('enclaveKey must be 0x + 64 hex');

const cfg = networkConfig();
const { api, info } = await connect(cfg);
const signer = await agentSigner(c.agent);
const modelIdentity = await resolveModelIdentity(api, c.model, c.backendModel);
const journal = new computeChannel.FileSpendJournal(path.join(DATA, 'data/local/flop-journal', c.agent), info.genesisHash, signer.address);
const submitter = new computeChannel.FlopChainSubmitter(api, signer, true);
const dayFile = path.join(DATA, 'data/local', `flop-lane-day-${c.agent}-${info.genesisHash.slice(2, 10)}.json`);

const st = { session: null, budget: 0n, reason: 'starting', served: 0, failed: 0, frozen: false, lastChannel: null, startedAt: new Date().toISOString() };
const free = async () => (await api.query.system.account(signer.address)).data.free.toBigInt();
const debited = () => { try { return BigInt(journal.state().debited ?? '0'); } catch { return null; } };

// Spend today = lifetime debit now minus the debit at the first sight of this UTC day.
function today(debit) {
  const day = new Date().toISOString().slice(0, 10);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(dayFile, 'utf8')); } catch { /* first run */ }
  if (!rec || rec.day !== day) { rec = { day, debitAtStart: debit.toString() }; fs.writeFileSync(dayFile, JSON.stringify(rec)); }
  return debit - BigInt(rec.debitAtStart);
}

async function open() {
  if (st.frozen) return;
  const opened = await computeChannel.LongSession.open({
    api, submitter, journal, miner: c.miner, endpoint: c.endpoint, modelIdentity,
    windowSeconds: c.windowSeconds, maxLockSeconds: Math.max(c.windowSeconds, 3600),
    maxChannelPlanck: c.channel, topUpPlanck: c.topUp, budgetPlanck: await sizeBudget(),
    maxTurns: 1024, worstCaseTurnPlanck: () => c.turnAtoms, turnTimeoutSeconds: c.turnTimeout,
    indexerUrl: cfg.indexer ?? undefined,
    ...(c.enclaveKey ? { enclaveKey: Uint8Array.from(Buffer.from(c.enclaveKey.slice(2), 'hex')) } : {})
  });
  st.session = opened;
  st.reason = null;
}

// Lifetime debit + today's room. The journal state is readable only under the lock
// LongSession.open takes, so until the first open the debit is unknown: that open is
// sized with zero room (it can buy nothing), read, closed (no channel, no tx) and
// reopened with the real figure. Only an authoritative debit may start a day record.
let knownDebit = 0n;
let debitKnown = false;
async function sizeBudget() {
  const d = debited() ?? knownDebit;
  if (debited() !== null) { knownDebit = d; debitKnown = true; }
  if (!debitKnown) { st.budget = d; return d; }
  const bal = await free();
  let room = bal > c.reserve ? bal - c.reserve : 0n;
  const spentToday = today(d);
  if (c.dayCap !== null) {
    const left = c.dayCap - spentToday;
    if (left < room) room = left > 0n ? left : 0n;
  }
  st.budget = d + room;
  return st.budget;
}

async function closeSession(why) {
  const s = st.session;
  st.session = null;
  st.reason = why;
  if (!s) return;
  try {
    const r = await s.close();
    knownDebit = r.debited ?? knownDebit;
    if (r.unresolved?.length) { st.frozen = true; st.reason = `frozen: unresolved ${r.unresolved.join(',')}`; }
    logLine('flop-lane.jsonl', { event: 'closed', agent: c.agent, why, debited: r.debited?.toString(), unresolved: r.unresolved, channels: r.channels?.map((x) => ({ channel: x.channel, state: x.state, turns: x.turns, escrow: x.escrow })) });
  } catch (err) {
    logLine('flop-lane.jsonl', { event: 'close-failed', agent: c.agent, why, error: err.message });
  }
}

async function refresh() {
  if (st.session || st.frozen) return;
  try {
    await open();
    if (!debitKnown) {
      const d = debited();
      if (d === null) throw new Error('journal debit unreadable after open');
      knownDebit = d; debitKnown = true;
      const s = st.session; st.session = null;
      await s.close();
      await open();
    }
    const room = st.budget - (debited() ?? knownDebit);
    if (room <= 0n) { await closeSession(`no room: budget ${flop(st.budget)} debited ${flop(debited() ?? knownDebit)}`); return; }
    logLine('flop-lane.jsonl', { event: 'open', agent: c.agent, miner: c.miner, model: c.model, budget: st.budget.toString(), room: room.toString() });
  } catch (err) {
    st.session = null;
    st.reason = `open refused: ${err.message}`;
    if (err instanceof computeChannel.SpendingFrozenError) st.frozen = true;
    logLine('flop-lane.jsonl', { event: 'open-refused', agent: c.agent, error: err.message });
  }
}

let chain = Promise.resolve();
function serialised(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

async function serve(body) {
  if (!st.session) throw Object.assign(new Error(st.reason ?? 'lane closed'), { status: 503 });
  const prompt = String(body.prompt ?? '');
  if (!prompt || prompt.length > 32_000) throw Object.assign(new Error('prompt empty or too long'), { status: 400 });
  const envelope = { version: 'flop.chat-turn.v1', model: c.model, messages: [{ role: 'user', content: prompt }], max_tokens: Math.min(Number(body.max_tokens) || c.maxTokens, c.maxTokens) };
  const requestId = crypto.randomUUID();
  try {
    const r = await st.session.turn(envelope, { requestId });
    const text = computeChannel.renderDirectChat(r.receipt, envelope).content;
    st.served += 1; st.lastChannel = r.channelId;
    logLine('flop-lane.jsonl', { event: 'turn', agent: c.agent, requestId, channel: r.channelId, promptChars: prompt.length, completionTokens: r.receipt.completionTokens?.toString() ?? null, gN: r.receipt.gN?.toString() ?? null });
    return { text, model: c.model, prompt_tokens: r.receipt.promptTokens != null ? Number(r.receipt.promptTokens) : null, completion_tokens: r.receipt.completionTokens != null ? Number(r.receipt.completionTokens) : null, session_id: r.channelId, miner: c.miner, fee_flop: null };
  } catch (err) {
    st.failed += 1;
    logLine('flop-lane.jsonl', { event: 'turn-failed', agent: c.agent, requestId, error: err.message, code: err.code ?? null });
    if (err instanceof computeChannel.SpendingFrozenError) { st.frozen = true; await closeSession(`frozen: ${err.message}`); }
    else if (err instanceof computeChannel.BudgetExceededError) await closeSession('budget spent');
    throw Object.assign(err, { status: 502 });
  }
}

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/lane') return st.session ? json(res, 200, { ok: true }) : json(res, 503, { ok: false, reason: st.reason });
    if (req.method === 'GET' && req.url === '/lane/status') {
      const d = debited() ?? knownDebit;
      return json(res, 200, { agent: c.agent, address: signer.address, chain: info.chain, miner: c.miner, model: c.model, open: Boolean(st.session), reason: st.reason, frozen: st.frozen, budget: flop(st.budget), debited: flop(d), today: debitKnown ? flop(today(d)) : null, served: st.served, failed: st.failed, lastChannel: st.lastChannel, startedAt: st.startedAt });
    }
    if (req.method === 'POST' && req.url === '/lane') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) return json(res, 413, { error: 'too large' }); }
      const out = await serialised(() => serve(JSON.parse(raw || '{}')));
      return json(res, 200, out);
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, err.status ?? 500, { error: err.message });
  }
});

await refresh();
server.listen(c.port, '127.0.0.1', () => console.log(`flop-lane ${c.agent} ${signer.address} on ${info.chain}: http://127.0.0.1:${c.port}/lane (${st.session ? 'open' : st.reason})`));
setInterval(() => { serialised(refresh); }, 10 * 60_000).unref();

const stop = async () => { server.close(); await serialised(() => closeSession('shutdown')); await api.disconnect(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
