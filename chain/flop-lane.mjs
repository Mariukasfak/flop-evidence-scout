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
 *     "windowSeconds": 900, "channel": 1, "topUp": 0.1, "turnGn": 1000000, "turnTimeout": 60,
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
  agent: conf.agent ?? 'scout',
  windowSeconds: Number(conf.windowSeconds ?? 900), channel: P(conf.channel ?? 1), topUp: P(conf.topUp ?? 0.1),
  // SDK 0.10: a turn is priced as BasePerTurn + price x G_n, so the ceiling is in G_n now (turnGn).
  // turnAtoms is the pre-0.10 name; on devnet one G_n cost one atom, so the number carries over.
  turnGn: BigInt(conf.turnGn ?? conf.turnAtoms ?? 1_000_000), turnTimeout: Number(conf.turnTimeout ?? 60), reserve: P(conf.reserve ?? 2),
  dayCap: conf.dayCap == null ? null : P(conf.dayCap), port: Number(conf.port ?? 8790), maxTokens: Number(conf.maxTokens ?? 512)
};
// Miners in order of preference: `miners: [{miner, endpoint, enclaveKey}]`, or the single
// top-level miner/endpoint/enclaveKey. A miner whose turn or open fails rests for
// `minerCooldownMinutes` and the lane moves to the next one: devnet 2026-11-23 the only
// miner went "signer is fenced" (503) mid-channel and the lane had nowhere else to go.
c.miners = (Array.isArray(conf.miners) && conf.miners.length ? conf.miners : [{ miner: conf.miner, endpoint: conf.endpoint, enclaveKey: conf.enclaveKey }])
  .map((m) => ({
    miner: m.miner, endpoint: m.endpoint, enclaveKey: m.enclaveKey ?? null,
    // Miners serve different models; each entry may name its own (registry name), else the top-level one.
    model: m.model ?? conf.model ?? 'qwen/qwen2.5-0.5b-instruct',
    backendModel: m.backendModel ?? (m.model ?? conf.backendModel ?? 'Qwen/Qwen2.5-0.5B-Instruct')
  }));
for (const m of c.miners) {
  if (!m.miner || !m.endpoint) throw new Error('lane.json needs miner and endpoint for every miner');
  if (m.enclaveKey && !/^0x[0-9a-fA-F]{64}$/.test(m.enclaveKey)) throw new Error(`enclaveKey of ${m.miner} must be 0x + 64 hex`);
}
c.cooldownMs = Number(conf.minerCooldownMinutes ?? 30) * 60_000;
let cur = 0;
const resting = new Map();
for (const k of ['miner', 'endpoint', 'enclaveKey', 'model', 'backendModel']) Object.defineProperty(c, k, { get: () => c.miners[cur][k], enumerable: true });
// The first miner in preference order that is not resting; null when all are.
function pickMiner() {
  const now = Date.now();
  const i = c.miners.findIndex((m) => (resting.get(m.miner) ?? 0) <= now);
  if (i >= 0) cur = i;
  return i >= 0 ? c.miners[i] : null;
}
function restMiner(why) {
  resting.set(c.miner, Date.now() + c.cooldownMs);
  logLine('flop-lane.jsonl', { event: 'miner-rest', agent: c.agent, miner: c.miner, minutes: c.cooldownMs / 60_000, why: String(why).slice(0, 300) });
}

const cfg = networkConfig();
const { api, info } = await connect(cfg);
const signer = await agentSigner(c.agent);
// Registry identity per model, resolved on first use (a wrong identity is a wrong purchase,
// so the resolver refuses anything ambiguous). Fails here at start for the first miner.
const identities = new Map();
async function identityFor(model, backendModel) {
  const k = `${model}|${backendModel}`;
  if (!identities.has(k)) identities.set(k, await resolveModelIdentity(api, model, backendModel));
  return identities.get(k);
}
await identityFor(c.model, c.backendModel);
const journal = new computeChannel.FileSpendJournal(path.join(DATA, 'data/local/flop-journal', c.agent), info.genesisHash, signer.address);
const submitter = new computeChannel.FlopChainSubmitter(api, signer, true);
const dayFile = path.join(DATA, 'data/local', `flop-lane-day-${c.agent}-${info.genesisHash.slice(2, 10)}.json`);

// The SDK retires a channel only when less than one turn timeout of window is left,
// and a cooperative close started that late did not finalize (2026-11-23, channel
// 0x608f… orphaned with 20 verified turns). The lane closes the session itself while
// `retireMargin` seconds are still left, so the miner has time to settle.
c.retireMargin = Number(conf.retireMarginSeconds ?? Math.max(300, 2 * c.turnTimeout));
if (c.retireMargin * 2 > c.windowSeconds) throw new Error(`windowSeconds ${c.windowSeconds} must be at least twice retireMarginSeconds ${c.retireMargin}`);
const blockMs = (() => {
  try {
    const babe = api.consts.babe?.expectedBlockTime;
    if (babe) return Number(babe.toString());
    const min = api.consts.timestamp?.minimumPeriod;
    if (min) return Number(min.toString()) * 2;
  } catch { /* fall through */ }
  return 6000;
})();

const st = { session: null, budget: 0n, reason: 'starting', served: 0, failed: 0, skipped: 0, frozen: false, lastChannel: null, turnStartedAt: null, pending: 0, startedAt: new Date().toISOString() };
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
    api, submitter, journal, miner: c.miner, endpoint: c.endpoint, modelIdentity: await identityFor(c.model, c.backendModel),
    windowSeconds: c.windowSeconds, maxLockSeconds: Math.max(c.windowSeconds, 3600),
    maxChannelPlanck: c.channel, topUpPlanck: c.topUp, budgetPlanck: await sizeBudget(),
    maxTurns: 1024, worstCaseTurnGn: () => c.turnGn, turnTimeoutSeconds: c.turnTimeout,
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
  // One atom: the SDK wants a positive budget, and no escrow fits in one atom.
  if (!debitKnown) { st.budget = d + 1n; return st.budget; }
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

// What one bare open on this miner locks now: capacity rate x window blocks x tariff
// (as long-session.mjs --check prints). Null when the chain does not say.
async function openFloor() {
  const head = await api.rpc.chain.getFinalizedHead();
  const cc = (await api.at(head)).consts.computeChannel;
  const cap = await computeChannel.readMinerCapacity(api, c.miner, head);
  const tariff = BigInt(cc.unconsentedReservationTariff?.toString() ?? '0');
  if (!cap || tariff <= 0n) return null;
  const maxBlocks = BigInt(cc.maxUnconsentedSessionBlocks?.toString() ?? '0');
  let wb = BigInt(Math.ceil(c.windowSeconds * 1000 / blockMs));
  if (maxBlocks > 0n && wb > maxBlocks) wb = maxBlocks;
  return cap.rate * wb * tariff;
}

async function refresh() {
  if (st.session || st.frozen) return;
  for (let tries = 0; tries < c.miners.length; tries++) {
    if (!pickMiner()) { st.reason = 'every miner is resting after a failure'; return; }
    const before = c.miner;
    await refreshOn();
    if (st.session || st.frozen || !st.reason?.startsWith('open refused') || resting.has(before) === false) return;
  }
}

async function refreshOn() {
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
    // Room below what one bare open locks buys nothing: stay 503 instead of failing each request.
    const floor = await openFloor().catch(() => null);
    if (floor !== null && room < floor) { await closeSession(`room ${flop(room)} below the open floor ${flop(floor)}`); return; }
    logLine('flop-lane.jsonl', { event: 'open', agent: c.agent, miner: c.miner, model: c.model, budget: st.budget.toString(), room: room.toString() });
  } catch (err) {
    st.session = null;
    st.reason = `open refused: ${err.message}`;
    if (err instanceof computeChannel.SpendingFrozenError) st.frozen = true;
    else if (!isBudgetRefusal(err) && !/budgetPlanck/.test(err.message)) restMiner(`open: ${err.message}`);
    logLine('flop-lane.jsonl', { event: 'open-refused', agent: c.agent, miner: c.miner, error: err.message });
  }
}

let chain = Promise.resolve();
function serialised(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

// The live channel is the journal's one `open` record; its endBlock is when the window ends.
async function windowLeftMs() {
  let live = null;
  try { live = journal.state().channels.find((x) => x.state === 'open' && x.endBlock); } catch { return null; }
  if (!live) return null;
  const head = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toBigInt();
  return { channel: live.channel, ms: Number(BigInt(live.endBlock) - head) * blockMs };
}

async function rollIfEnding() {
  if (!st.session) return;
  const left = await windowLeftMs().catch(() => null);
  if (!left || left.ms > c.retireMargin * 1000) return;
  logLine('flop-lane.jsonl', { event: 'roll', agent: c.agent, channel: left.channel, secondsLeft: Math.round(left.ms / 1000) });
  await closeSession(`window ending: ${left.channel.slice(0, 10)}… ${Math.round(left.ms / 1000)} s left`);
  await refresh();
}

// A failure on the miner's side of a turn: its endpoint answered an error or did not answer.
const minerFault = (err) => {
  const m = String(err?.message ?? '');
  return m.includes(c.endpoint) || /(?:^|[^0-9])5\d\d(?:[^0-9]|$)|timeout|timed out|aborted|ECONNREFUSED|ECONNRESET|fetch failed|info proof/i.test(m);
};

// The SDK refuses an open past the lifetime budget with a plain Error, not BudgetExceededError.
const isBudgetRefusal = (err) => err instanceof computeChannel.BudgetExceededError || /would pass the lifetime budget/.test(String(err?.message));

async function serve(body, gone) {
  if (!st.session) throw Object.assign(new Error(st.reason ?? 'lane closed'), { status: 503 });
  // The daemon gave up on this request while it queued: a turn now would be paid for and thrown away.
  if (gone()) { st.skipped += 1; throw Object.assign(new Error('client gone'), { status: 499 }); }
  await rollIfEnding();
  if (!st.session) throw Object.assign(new Error(st.reason ?? 'lane closed'), { status: 503 });
  const prompt = String(body.prompt ?? '');
  if (!prompt || prompt.length > 32_000) throw Object.assign(new Error('prompt empty or too long'), { status: 400 });
  const envelope = { version: 'flop.chat-turn.v1', model: c.model, messages: [{ role: 'user', content: prompt }], max_tokens: Math.min(Number(body.max_tokens) || c.maxTokens, c.maxTokens) };
  const requestId = crypto.randomUUID();
  st.turnStartedAt = Date.now();
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
    else if (isBudgetRefusal(err)) await closeSession('budget spent');
    else if (minerFault(err)) {
      // The SDK has already left the channel to the miner's force settlement; close the
      // session and buy from the next miner on the next request.
      restMiner(err.message);
      await closeSession(`miner ${c.miner.slice(0, 8)}… failed: ${err.message.slice(0, 160)}`);
      await refresh();
    }
    throw Object.assign(err, { status: 502 });
  } finally {
    st.turnStartedAt = null;
  }
}

// 503 while a turn has run longer than a normal turn (a rollover or a slow miner) or
// requests pile up, so the daemon's next selection uses Ollama instead of queueing.
function busy() {
  if (st.turnStartedAt && Date.now() - st.turnStartedAt > 45_000) return `busy: a turn has run ${Math.round((Date.now() - st.turnStartedAt) / 1000)} s`;
  if (st.pending > 2) return `busy: ${st.pending} requests waiting`;
  return null;
}

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/lane') {
      if (!st.session) return json(res, 503, { ok: false, reason: st.reason });
      const b = busy();
      return b ? json(res, 503, { ok: false, reason: b }) : json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/lane/status') {
      const d = debited() ?? knownDebit;
      return json(res, 200, { agent: c.agent, address: signer.address, chain: info.chain, miner: c.miner, model: c.model, open: Boolean(st.session), reason: st.reason, frozen: st.frozen, budget: flop(st.budget), debited: flop(d), today: debitKnown ? flop(today(d)) : null, served: st.served, failed: st.failed, skipped: st.skipped, pending: st.pending, busy: busy(), lastChannel: st.lastChannel, startedAt: st.startedAt });
    }
    if (req.method === 'POST' && req.url === '/lane') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) return json(res, 413, { error: 'too large' }); }
      const body = JSON.parse(raw || '{}');
      let gone = false;
      res.on('close', () => { if (!res.writableEnded) gone = true; });
      st.pending += 1;
      let out;
      try { out = await serialised(() => serve(body, () => gone)); } finally { st.pending -= 1; }
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
// Idle too: a channel must not reach its window end just because no request came.
setInterval(() => { serialised(rollIfEnding).catch(() => {}); }, 30_000).unref();

const stop = async () => { server.close(); await serialised(() => closeSession('shutdown')); await api.disconnect(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
