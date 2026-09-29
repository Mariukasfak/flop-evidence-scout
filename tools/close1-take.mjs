#!/usr/bin/env node
/**
 * close-1 agent run: verify the contest, follow the referee, rebuild our
 * ledger, alert on changes, and — only with --go and only through the risk
 * gate — post one offer or one re-post probe.
 *
 * Flop Labs' launch note (2026-09-25) says what close-1 is for: "whether
 * autonomous software can find a counterparty and settle a deal on its own".
 * That is this tool's whole ambition: a few small trades with keys that are not
 * ours, one owner key, never a farm. The score is beside the point.
 *
 * Responsibilities live in src/close1/: contest-source (what the rules are),
 * stream-watcher (the only room reader), evidence-store (append-only raw
 * records), ledger (what happened, with evidence strength), strategy (pure
 * decision), risk-gate (every write), executor (the only key holder), runtime
 * (snapshot + alerts), archive (the official per-sweep records, trusted only
 * where their bytes hash to what the referee signed).
 *
 *   node tools/close1-take.mjs            dry run: verify, rebuild, show what it would do
 *   node tools/close1-take.mjs --check    report only
 *   node tools/close1-take.mjs --go       post: due probes first, then one offer if the gate allows
 *   CLOSE1_ALLOW_OPEN_TAKE=1 … --take     take a stranger's open offer instead (off by default)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TechnocoreClient } from '../src/technocore-client.mjs';
import {
  SEASON, checkedTerms, checkedTrade, makerPayload, takerPayload, tradeText, safeVerify, sweepFor
} from '../src/close1/protocol.mjs';
import { buildContestConfig, verifyRefereeMessage, PINNED } from '../src/close1/contest-source.mjs';
import { EvidenceStore, SIG_STATUS, SOURCE } from '../src/close1/evidence-store.mjs';
import { RoomStream } from '../src/close1/stream-watcher.mjs';
import { buildLedger, termsOf, STATUS } from '../src/close1/ledger.mjs';
import { decide, ACTION } from '../src/close1/strategy.mjs';
import { approveTrade, approveProbe, DEFAULT_POLICY } from '../src/close1/risk-gate.mjs';
import { Executor } from '../src/close1/executor.mjs';
import { buildSnapshot, alertsBetween, deliverAlerts, withEvidenceReport, baselineStatus, gateEvidenceAlerts } from '../src/close1/runtime.mjs';
import { readOperatorLock, makeWriteGuard, lockAlerts, recordWrite, readWrites, foreignWrites, setWatchSince, WritesBlocked } from '../src/close1/operator-lock.mjs';
import { hostHealth, loadTelegramEnv, telegramOnlineTest, telegramConfigured } from '../src/close1/host.mjs';
import { forensicRows, decide as recommend, run as runForensics } from './close1-forensics.mjs';
import { watchUpstream } from '../src/close1/upstream.mjs';
import { corroboratedAccount, compareAccounts } from '../src/close1/corroborated.mjs';
import { standingOf } from '../src/close1/runtime.mjs';
import { reconcileArchive, archiveVerdict, archiveMint } from '../src/close1/archive.mjs';

export { checkedTerms, makerPayload, takerPayload, tradeText, SEASON };
export const REFEREE = PINNED.refereeDid;
/** POLICY, not protocol: the rules set no maximum quantity. See risk-gate.mjs. */
export const MAX_TAKE_QTY = DEFAULT_POLICY.maxTakeQty;
export const MAX_DRIFT = DEFAULT_POLICY.maxDrift;

const BASE = 'https://technocore.chat';
const ROOM = 'close1';
const DIR = path.resolve('data/local/close1');
const STATE = path.resolve('data/local/close1-trades.json');
const REGISTRATION = path.resolve('data/local/close1-registration.json');
const IDENTITY = path.resolve('.secrets/scout-identity.json');
const SIBLING = path.resolve('.secrets/scribe-identity.json');
const MAX_PROBES_PER_RUN = 2;
const HALT = /contest|referee|stream|stale|reference|signature|canonical|not_read/;

/** An open offer we may take, or the reason we may not. Protocol shape first, then our policy. */
export function judgeOffer(msg, { ours, ref, nextSweep, maxQty = MAX_TAKE_QTY, maxDrift = MAX_DRIFT }) {
  let o;
  try { o = JSON.parse(msg.text); } catch { return { ok: false, why: 'not json' }; }
  if (o?.t !== 'offer' || o.season !== SEASON) return { ok: false, why: 'not an offer' };
  const terms = checkedTerms(o.terms);
  if (!terms) return { ok: false, why: 'shape' };
  if (msg.from !== terms.maker) return { ok: false, why: 'posted by someone other than the maker' };
  if (ours.has(terms.maker)) return { ok: false, why: 'ours' };
  if (terms.taker !== 'any') return { ok: false, why: 'named taker' };
  if (terms.until < nextSweep) return { ok: false, why: 'expires before the next sweep' };
  if (Number(terms.qty) > maxQty) return { ok: false, why: 'too large' };
  if (Math.abs(Number(terms.px) / ref - 1) > maxDrift) return { ok: false, why: 'too far from the reference' };
  if (!safeVerify(makerPayload(terms), o.maker_sig, terms.maker)) return { ok: false, why: 'maker signature does not verify over the terms' };
  return { ok: true, terms, makerSig: o.maker_sig, seq: msg.seq };
}

/** Our own offer's terms, canonical. */
export function makerTerms({ did, px, side, until, id, qty = '0.50' }) {
  return checkedTerms({ id, maker: did, px: Number(px).toFixed(2), qty, side, taker: 'any', until });
}

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); };

/** The seed: kept once, re-verified every run by buildContestConfig. */
async function loadSeed() {
  const f = path.join(DIR, 'seed.json');
  const saved = readJson(f, null);
  if (saved) return saved;
  const r = await fetch(`${BASE}/r/${PINNED.seedRoom}/export`);
  if (!r.ok) throw new Error(`seed export: HTTP ${r.status}`);
  const first = JSON.parse((await r.text()).split('\n')[0]);
  if (first.seq !== PINNED.seedSeq) throw new Error(`seed export starts at seq ${first.seq}`);
  writeJson(f, first);
  return first;
}

/** First run: the whole referee room from /export, verified, into the evidence store. */
async function backfill(stream, evidence, room, verify) {
  if (stream.state[room].cursor > 0) return;
  const r = await fetch(`${BASE}/r/${room}/export`);
  if (!r.ok) throw new Error(`${room} export: HTTP ${r.status}`);
  const msgs = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const head = await stream.client.readRoom(room, { limit: 1, format: 'json' });
  const generation = head.generation ?? null;
  evidence.append(msgs.map((m) => { const v = verify(m); return evidence.record(room, m, { generation, sigStatus: v.sigStatus, source: v.source }); }));
  const s = stream.state[room];
  s.cursor = msgs.at(-1)?.seq ?? 0;
  s.generation = generation;
  s.lastOkAt = Date.now();
  stream.save();
}

/** Verified referee bodies from the evidence store, by sweep. */
export function refereeBodies(evidence, room) {
  const out = new Map();
  let latest = null;
  for (const r of evidence.read(room)) {
    if (r.source !== SOURCE.REFEREE_SIGNED) continue;
    let b; try { b = JSON.parse(r.text); } catch { continue; }
    if (Number.isInteger(b.n)) { out.set(b.n, b); if (!latest || b.n >= latest.body.n) latest = { body: b, ts: r.ts }; }
  }
  return { byN: out, latest };
}

export async function run(argv = process.argv.slice(2)) {
  const go = argv.includes('--go');
  const checkOnly = argv.includes('--check');
  const take = argv.includes('--take');
  const policy = { ...DEFAULT_POLICY, mode: take ? 'take' : 'make', allowOpenTake: process.env.CLOSE1_ALLOW_OPEN_TAKE === '1' };
  const nowMs = Date.now();
  // The updater is swapping the code under us: skip this run rather than run a half-updated tree.
  try {
    const u = JSON.parse(fs.readFileSync(path.join(DIR, 'update.lock'), 'utf8'));
    if (Date.now() - Date.parse(u.at) < 10 * 60_000) { console.log('no run: an update is in progress'); return null; }
  } catch { /* no lock: the normal case */ }
  const client = new TechnocoreClient({ evidenceDir: path.resolve('data/local/evidence') });
  const evidence = new EvidenceStore({ dir: path.join(DIR, 'evidence') });
  const registration = readJson(REGISTRATION, null);
  const state = readJson(STATE, { trades: [] });
  const ourDid = registration?.did ?? null;
  let writeErrors = 0;

  // 1. The contest, verified from the pinned package and the signed seed.
  let contest = null; let contestError = null;
  try { contest = buildContestConfig({ seedMsg: await loadSeed() }); } catch (err) { contestError = `${err.code ?? 'error'}: ${err.message}`; }
  const refereeDid = PINNED.refereeDid;

  // 2. The referee's rooms, through the one stream reader.
  const observedAuthors = new Set();
  let sigFailures = 0;
  const refVerify = (room) => (m) => {
    observedAuthors.add(m.from);
    const v = verifyRefereeMessage(m, room, refereeDid);
    if (!v.ok && m.from === refereeDid) sigFailures += 1;
    return v.ok ? { sigStatus: SIG_STATUS.VERIFIED, source: SOURCE.REFEREE_SIGNED, body: v.body }
      : { sigStatus: m.sig ? SIG_STATUS.INVALID : SIG_STATUS.UNSIGNED, source: SOURCE.UNVERIFIED };
  };
  const mine = (m) => Boolean(ourDid) && (m.from === ourDid || String(m.text).includes(ourDid) || state.trades.some((t) => String(m.text).includes(t.id)));
  const stream = new RoomStream({
    client, evidence, cursorFile: path.join(DIR, 'cursors.json'),
    rooms: {
      'd-close1-price': { wait: 0, verify: refVerify('d-close1-price') },
      'd-close1-flow': { wait: 0, verify: refVerify('d-close1-flow') },
      'd-close1-pnl': { wait: 0, verify: refVerify('d-close1-pnl') },
      [ROOM]: { wait: 0, keep: mine }
    }
  });
  for (const room of ['d-close1-price', 'd-close1-flow']) {
    try { await backfill(stream, evidence, room, refVerify(room)); } catch (err) { console.log(`${room}: backfill failed (${err.message})`); }
  }
  for (const room of ['d-close1-price', 'd-close1-flow', 'd-close1-pnl']) {
    const r = await stream.poll(room);
    if (!r.ok) console.log(`${room}: read failed (${r.error})`);
    if (r.gap) console.log(`${room}: GAP ${JSON.stringify(r.gap)}`);
  }

  // 3. The ledger, from verified referee posts only.
  const flows = refereeBodies(evidence, 'd-close1-flow');
  const prices = refereeBodies(evidence, 'd-close1-price');
  const pnl = refereeBodies(evidence, 'd-close1-pnl').latest?.body ?? null;
  const prev = readJson(path.join(DIR, 'runtime.json'), null);

  // 3a. The official archive: only the sweeps our trades and mint need, each checked against the signed `file`.
  let archiveHealth = null; const verdicts = new Map(); let mintEvidence = null;
  if (ourDid) {
    try {
      const signedFiles = new Map();
      for (const [n, b] of prices.byN) if (typeof b.file === 'string') signedFiles.set(n, b.file);
      for (const [n, b] of flows.byN) if (typeof b.file === 'string') signedFiles.set(n, b.file);
      const a = await reconcileArchive({
        trades: state.trades, registration, ourDid, signedFiles, liveLatest: prices.latest?.body.n ?? null,
        cacheDir: path.join(DIR, 'archive'), cfg: contest, prevHealth: prev?.archive ?? null, nowMs
      });
      archiveHealth = a.health;
      for (const t of state.trades) verdicts.set(t.id, archiveVerdict(t, { records: a.records, ourDid, cfg: contest }));
      mintEvidence = archiveMint({ records: a.records, regSweep: sweepFor(Date.parse(registration.postedAt), contest) });
      archiveHealth.mint = { verified: mintEvidence.verified, corroborated: mintEvidence.corroborated };
    } catch (err) {
      archiveHealth = { archive_status: 'UNAVAILABLE', archive_error: String(err.message).slice(0, 200), archive_last_success: prev?.archive?.archive_last_success ?? null };
    }
  }
  const ledger = ourDid ? buildLedger({
    trades: state.trades, registration, flows: flows.byN, prices: prices.byN, ourDid, cfg: contest,
    archive: verdicts, archiveMint: mintEvidence, roomPosts: state.roomPosts ?? []
  }) : null;
  if (ledger) for (const t of state.trades) t.resolution = ledger.resolutions.get(t.id);
  writeJson(STATE, state);
  const price = prices.latest ? { ...prices.latest.body, postedAt: prices.latest.ts } : null;

  // Integrity of what we pinned: one seed only, and no author but the referee in its rooms.
  const integrity = { seedRecords: 0, foreignAuthors: [], sigFailures };
  for (const room of ['d-close1-price', 'd-close1-flow', 'd-close1-pnl']) {
    for (const r of evidence.read(room)) {
      if (r.from !== refereeDid && !integrity.foreignAuthors.includes(r.from)) integrity.foreignAuthors.push(r.from);
      if (r.from === refereeDid && r.source !== SOURCE.REFEREE_SIGNED) integrity.sigFailures += 1;
      if (room === 'd-close1-price') { try { if (JSON.parse(r.text).t === 'seed') integrity.seedRecords += 1; } catch { /* not json */ } }
    }
  }

  // The official repo, for rule changes, a launch record, draft status, and watched issues.
  const upstreamFile = path.join(DIR, 'upstream.json');
  const upstreamPrev = readJson(upstreamFile, null);
  // At most every 30 min, never while rate limited, never fatal: a blind watcher is not a trading failure.
  const watch = await watchUpstream({ prev: upstreamPrev, nowMs, pinned: PINNED });
  const upstream = watch.obs; const upstreamError = watch.error ?? null; const upstreamNotes = watch.notes;
  if (watch.ran || watch.obs !== upstreamPrev) writeJson(upstreamFile, upstream);

  // The corroborated account: a separate model from officially published redacted records.
  // NOT USED FOR SIGNING OR RISK APPROVAL — it goes to the snapshot only, never into snapIn below.
  let corroborated = null; let comparison = null;
  if (ledger) {
    corroborated = corroboratedAccount({
      trades: state.trades, resolutions: ledger.resolutions, prices: prices.byN,
      marks: { reference: price?.ref?.px != null ? Number(price.ref.px) : null, pnl_mark: pnl?.mark != null ? Number(pnl.mark) : null }
    });
    comparison = compareAccounts({ ledger, corroborated, standing: standingOf(pnl?.top, ourDid), pnl });
  }
  // The forensics recommendation, every run, for the snapshot and the evidence report only.
  let decision = null;
  if (ledger && corroborated) {
    try {
      const rows = forensicRows({ trades: state.trades, ledger, verdicts, corroborated, ourDid, cfg: contest });
      decision = recommend({ rows, ledger, comparison, archive: archiveHealth, attempts: state.trades.length });
    } catch (err) { console.log(`recommendation failed: ${err.message}`); }
  }
  // The operator's lock is read again before every write; this read is for the snapshot and the report.
  const lock = readOperatorLock(DIR);
  const baseline = baselineStatus(archiveHealth);
  const tgEnv = loadTelegramEnv();
  const telegram = checkOnly ? { status: telegramConfigured(tgEnv) ? 'CONFIGURED' : 'NOT_CONFIGURED' } : await telegramOnlineTest({ env: tgEnv, dir: DIR });
  // Posts under OUR key in the close-1 room that this host did not make: another machine is signing with it.
  let writerAlerts = [];
  if (ourDid) {
    const fw = foreignWrites({ records: evidence.read(ROOM), ourDid, writes: readWrites(DIR) });
    if (fw.initialised) { if (!checkOnly) setWatchSince(DIR, fw.since); }
    else if (fw.foreign.length) writerAlerts = [{ kind: 'foreign_writer_detected', text: `CRITICAL close-1: post(s) at seq ${fw.foreign.slice(0, 5).join(', ')} were signed with our key in the close-1 room but not by this host (${lock.host ?? 'unknown host'}). A second machine may be writing.` }];
  }

  // 4. What the strategy would do, and whether the gate would allow it — computed
  //    on every run, so the snapshot always says whether writes are open.
  const ref = Number(price?.ref?.px);
  const nextSweep = price ? (price.for ?? price.n + 1) : null;
  const snapIn = {
    contest: contest ? { verified: true, refereeDid: contest.refereeDid, lockSweep: contest.lockSweep } : { verified: false },
    observedRefereeDids: [...observedAuthors], refereeSigFailures: sigFailures,
    streams: stream.stats(), price, ledger, attempts: state.trades.length
  };
  let candidate = null;
  if (!checkOnly && go && ledger && price && policy.mode === 'take' && policy.allowOpenTake) {
    candidate = await followOffers(stream, { ours: ourKeys(ourDid), ref, nextSweep, state });
  }
  const proposal = ledger && price
    ? decide({ ourDid, ref, nextSweep, netPosition: ledger.replay.netPosition, candidate, idHint: `mfk-${crypto.randomBytes(5).toString('hex')}` }, policy)
    : { action: ACTION.NO_ACTION, why: contest ? 'no verified reference yet' : 'contest not verified' };
  const gate = proposal.action === ACTION.NO_ACTION
    ? { ok: false, reasons: [proposal.why] }
    : approveTrade(snapIn, proposal, policy, nowMs);
  if (!contest && !gate.reasons.includes('contest_unverified')) gate.reasons.push('contest_unverified');
  gate.kind = gate.ok ? 'open' : gate.reasons.some((r) => HALT.test(r)) ? 'halt' : 'hold';

  // 5. Snapshot and alerts.
  const snapshot = buildSnapshot({ contest, contestError, streams: stream.stats(), price, ledger, pnl, ourDid, trades: state.trades, gate, nowMs, writeErrors5m: writeErrors, upstream, upstreamError, integrity, archive: archiveHealth, corroborated, comparison, decision,
    host: hostHealth({ dir: DIR, prev, nowMs, cycleOk: Boolean(contest) && !contestError, telegram, baseline, archive: archiveHealth }) });
  const alerts = withEvidenceReport(prev, snapshot, gateEvidenceAlerts(prev, snapshot, [...alertsBetween(prev, snapshot), ...lockAlerts(prev, snapshot), ...writerAlerts, ...upstreamNotes]));
  await deliverAlerts(alerts, { logFile: path.join(DIR, 'alerts.jsonl') });
  writeJson(path.join(DIR, 'runtime.json'), snapshot);
  // The first complete snapshot is the BASELINE: recorded once, and its appearance is not an event.
  const baselineFile = path.join(DIR, 'evidence-baseline.json');
  if (snapshot.evidence_baseline_ready && !fs.existsSync(baselineFile) && !checkOnly) {
    writeJson(baselineFile, {
      established_at: snapshot.generated_at, runtime_commit: snapshot.runtime_commit, host: snapshot.active_runtime_host,
      evidence_summary: snapshot.evidence_summary, exposure: [snapshot.exposure_low, snapshot.exposure_high, snapshot.proven_position],
      archive: { latest: snapshot.archive?.archive_latest_sweep, status: snapshot.archive?.archive_status, by_class: snapshot.archive?.records_by_class },
      trades: snapshot.trades.map((t) => ({ id: t.id, outcome: t.corroborated_outcome, settlement: t.corroborated_settlement, status: t.status }))
    });
    console.log('evidence baseline recorded (not an event)');
  }
  // A meaningful change: keep the previous forensics and write a fresh one to compare with.
  if (alerts.some((a) => a.kind === 'evidence_report')) {
    try {
      const cur = path.join(DIR, 'forensics.json');
      if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(DIR, 'forensics.prev.json'));
      await runForensics(['--quiet']);
    } catch (err) { console.log(`forensics refresh failed: ${err.message}`); }
  }
  printReport(snapshot, state, ledger, contestError);
  for (const a of alerts) console.log(`${a.logOnly ? `LOGGED ONLY${a.suppressed ? ` (${a.suppressed})` : ''}` : 'ALERT'} ${a.kind}: ${a.text}`);
  if (checkOnly || !go) {
    if (!checkOnly && gate.ok) console.log(`would: ${proposal.rationale}\ndry run; nothing signed or posted`);
    return snapshot;
  }

  // 6. Writes: probes first (they settle what we already did), then at most one new trade.
  if (!lock.writes_allowed) { console.log(`no writes: ${lock.reasons.join('; ')}`); return snapshot; }
  if (!contest || !ledger) { console.log('no writes: contest or ledger unavailable'); return snapshot; }
  const writesBefore = readWrites(DIR).actual;
  // The snapshot above was taken before any write; this stamps what this cycle actually wrote.
  const stampWrites = () => {
    const w = readWrites(DIR);
    Object.assign(snapshot, { last_write_attempt: w.last_attempt_at, last_actual_write: w.last_actual_write_at, writes_attempted_total: w.attempts, writes_actual_total: w.actual, writes_this_cycle: w.actual - writesBefore });
    writeJson(path.join(DIR, 'runtime.json'), snapshot);
  };
  const executor = new Executor({ identityPath: IDENTITY, client, room: ROOM, guard: makeWriteGuard(DIR), onWrite: (w) => recordWrite(DIR, w) });
  if (executor.did !== ourDid) throw new Error('the signing key is not the registered owner; refusing to write');
  let probes = 0;
  // Fewest probes first, newest first: an older offer that keeps losing its void must not starve a fresh one.
  const due = state.trades.filter((t) => t.resolution?.status === STATUS.PROBE_DUE)
    .sort((x, y) => ((x.probes?.length ?? 0) + (x.probe ? 1 : 0)) - ((y.probes?.length ?? 0) + (y.probe ? 1 : 0)) || Date.parse(y.postedAt) - Date.parse(x.postedAt));
  for (const t of due) {
    if (probes >= MAX_PROBES_PER_RUN) break;
    try {
      const valid = (t.takers || []).find((k) => k.valid && k.text);
      const record = t.role === 'maker'
        ? (valid ? { tradeObj: JSON.parse(valid.text) } : { terms: termsOf(t, ourDid) })
        : { tradeObj: JSON.parse(t.text) };
      const p = executor.probeText(record);
      const ok = approveProbe(snapIn, p, policy, Date.now());
      if (!ok.ok) { console.log(`${t.id}: probe held (${ok.reasons.join(', ')})`); continue; }
      const posted = await executor.post(p.text, { ok: true, text: p.text });
      (t.probes ||= []).push({ sweep: price.n, postedAt: new Date().toISOString(), mode: record.terms ? 'self' : 'rebuilt', seq: posted.seq, signed: [makerPayload(p.terms), takerPayload(p.terms, p.taker)] });
      probes += 1;
      console.log(`${t.id}: re-posted after its window to learn its fate`);
    } catch (err) { if (err instanceof WritesBlocked) { console.log(`${t.id}: ${err.message}`); break; } writeErrors += 1; console.log(`${t.id}: probe failed (${err.message})`); }
    writeJson(STATE, state);
  }
  if (writeErrors) await deliverAlerts([{ kind: 'write_failure', text: `close-1: ${writeErrors} probe write(s) failed` }], { logFile: path.join(DIR, 'alerts.jsonl') });
  if (!gate.ok) { console.log(`no trade: ${gate.reasons.join(', ')}`); stampWrites(); return snapshot; }
  console.log(`proposal: ${proposal.rationale}`);
  try {
    if (proposal.action === ACTION.MAKE_OFFER) await makeOffer({ executor, stream, state, proposal });
    else if (proposal.action === ACTION.TAKE_OFFER) await takeOffer({ executor, state, proposal, ourDid });
  } catch (err) {
    stampWrites();
    if (err instanceof WritesBlocked) { console.log(err.message); return snapshot; }
    await deliverAlerts([{ kind: 'write_failure', text: `close-1 write failed: ${err.message}` }], { logFile: path.join(DIR, 'alerts.jsonl') });
    throw err;
  }
  stampWrites();
  return snapshot;
}

function ourKeys(ourDid) {
  const s = new Set([ourDid]);
  try { s.add(JSON.parse(fs.readFileSync(SIBLING, 'utf8')).did); } catch { /* no sibling here */ }
  return s;
}

/**
 * Be the maker: post our own offer and watch, through the shared stream, who
 * countersigns it. Every countersignature is checked the rules' way before it
 * counts; a key that signs `…|<maker_sig>` instead of `…|<taker did>` (two bots
 * did, 2026-09-26) is recorded as invalid.
 */
async function makeOffer({ executor, stream, state, proposal }) {
  const { text, makerSig, signed } = executor.signOffer(proposal.terms);
  await stream.seekHead(ROOM);
  const posted = await executor.post(text, { ok: true, text });
  const t = proposal.terms;
  const rec = {
    role: 'maker', id: t.id, maker: t.maker, ourSide: proposal.ourSide, qty: t.qty, px: t.px, until: t.until,
    postedAt: new Date().toISOString(), seq: posted.seq, terms: t, signed: { maker: signed, makerSig }, takers: []
  };
  state.trades.push(rec);
  writeJson(STATE, state);
  console.log(`offered: we ${proposal.ourSide} ${t.qty} @ ${t.px}, open to anyone through sweep ${t.until}`);
  const end = Date.now() + 10 * 60_000;
  let failures = 0;
  while (Date.now() < end) {
    const r = await stream.poll(ROOM);
    if (!r.ok && ++failures >= 10) { console.log('close1 unreadable; stopping the watch (the ledger will probe later)'); break; }
    for (const m of r.messages || []) {
      let o; try { o = JSON.parse(m.text); } catch { continue; }
      if (o?.t !== 'trade' || o.terms?.id !== t.id) continue;
      const c = checkedTrade(o);
      const valid = c.ok && m.from === c.taker && JSON.stringify(c.terms) === JSON.stringify(t);
      rec.takers.push({ did: o.taker, seq: m.seq, ts: m.ts, valid, why: c.ok ? null : c.why, text: m.text });
      console.log(`taken by …${String(o.taker).slice(-8)} at seq ${m.seq}: countersignature ${valid ? 'valid' : `INVALID (${c.why})`}`);
    }
    if (r.gap) rec.watchGaps = (rec.watchGaps || 0) + 1;
    writeJson(STATE, state);
    if (rec.takers.some((k) => k.valid)) break;
    await new Promise((res) => setTimeout(res, 1200));
  }
  if (!rec.takers.length) console.log('nobody took it in ten minutes; the ledger will probe after its window');
}

async function takeOffer({ executor, state, proposal, ourDid }) {
  const { text, signed } = executor.signAccept(proposal.terms, proposal.makerSig);
  const posted = await executor.post(text, { ok: true, text });
  const t = proposal.terms;
  state.trades.push({
    id: t.id, maker: t.maker, ourSide: proposal.ourSide, qty: t.qty, px: t.px, until: t.until,
    postedAt: new Date().toISOString(), seq: posted.seq, text, signed: { taker: signed }, taker: ourDid
  });
  writeJson(STATE, state);
  console.log('posted; the referee settles it at the next sweep or voids it with a reason');
}

/**
 * The first fresh, unraced open offer, read through the shared stream. Our
 * 2026-09-26 races showed an open offer is taken within a second, and a maker
 * who offers more than its account (28,064 POLF across nine, against 10,000)
 * voids on `funds` — so the room is watched 45 s first and such makers skipped.
 */
async function followOffers(stream, { ours, ref, nextSweep, state }) {
  const FRESH_MS = 3_000; const WARM_MS = 45_000; const MAX_MAKER_OFFERED = 9_000;
  const broke = new Set(state.trades.filter((t) => t.resolution?.voidReason === 'funds').map((t) => t.maker));
  const taken = new Set(); const offered = new Map();
  await stream.seekHead(ROOM);
  const warmUntil = Date.now() + WARM_MS; const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const r = await stream.poll(ROOM);
    const batch = r.messages || [];
    for (const m of batch) {
      try {
        const o = JSON.parse(m.text);
        if (o?.t === 'trade' && o.terms?.id) taken.add(o.terms.id);
        if (o?.t === 'offer' && typeof o.terms?.maker === 'string') offered.set(o.terms.maker, (offered.get(o.terms.maker) || 0) + (Number(o.terms.qty) * Number(o.terms.px) || 0));
      } catch { /* chatter */ }
    }
    if (Date.now() >= warmUntil && r.ok) {
      const newest = Math.max(...batch.map((m) => Date.parse(m.ts)).filter(Number.isFinite), 0);
      for (const m of [...batch].reverse()) {
        if (newest - Date.parse(m.ts) > FRESH_MS) break;
        const j = judgeOffer(m, { ours, ref, nextSweep });
        if (!j.ok || taken.has(j.terms.id) || broke.has(j.terms.maker) || (offered.get(j.terms.maker) || 0) > MAX_MAKER_OFFERED) continue;
        stream.evidence.append([stream.evidence.record(ROOM, m, { sigStatus: SIG_STATUS.VERIFIED, source: SOURCE.PEER_SIGNED })]);
        return j;
      }
    }
    await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

function printReport(s, state, ledger, contestError) {
  console.log(`contest: ${s.contest_verified ? `verified (package ${String(s.package_sha256).slice(0, 8)}…, referee …${String(s.referee_did).slice(-8)})` : `NOT VERIFIED — ${contestError}`}`);
  console.log(`sweep ${s.current_sweep ?? '?'}: reference ${s.reference_price ?? '?'} (trade ${s.reference_age_seconds ?? '?'} s old, post ${s.price_post_age_seconds ?? '?'} s old)`);
  const c = s.flow_counts;
  if (c) console.log(`flow ${c.n}: listed settled ${c.listed.settled} / void ${c.listed.void} / mints ${c.listed.mints}; omitted settled ${c.omitted.settled} / void ${c.omitted.void} / mints ${c.omitted.mints}${c.missed ? `; missed ranges ${c.missed}` : ''}`);
  console.log(`owner: ${s.owner_state} (${s.owner_evidence}${s.evidence_confidence?.owner_assumption ? `, assumes ${s.evidence_confidence.owner_assumption}` : ''})`);
  if (ledger) {
    console.log(`proven position: ${s.proven_position}; possible range ${s.exposure_low} … ${s.exposure_high}; proven-ours settlements ${s.settled_proven_count}, id-only settlements ${s.id_settled_count}`);
    console.log(`POLF balance: ${s.balance_provable ? s.polf_balance : `not provable (worst-case free ${s.free_polf_worst_case})`}`);
    console.log(`board: ${s.official_score != null ? `score ${s.official_score}, display row ${s.leaderboard_display_row} (DID order), tie of ${s.tie_visible_count} visible, ${s.tie_complete ? 'complete' : 'may continue past the list'}; prize place ${s.prize_place_status}${s.prize_places ? ` [${s.prize_places.join(', ')}]` : ''}` : s.official_score_note}`);
  }
  for (const t of state.trades) {
    const r = t.resolution || {};
    const obs = (r.archiveObservations || []).map((o) => `${o.outcome}@${o.sweep}${o.ours ? '(our copy)' : ''}`).join(' ');
    console.log(`${t.postedAt}  ${t.role === 'maker' ? 'offer' : 'take '}  ${t.id}  ${t.ourSide} ${t.qty} @ ${t.px}  -> ${r.status ?? '?'}${r.voidReason ? ` (${r.voidReason})` : ''} [evidence ${r.evidence ?? '?'}, ownership ${r.ownership ?? '?'}]${r.sweep ? ` sweep ${r.sweep}` : ''}${obs ? `  archive(redacted, not proof): ${obs}` : ''}`);
  }
  const a = s.archive;
  if (a) console.log(`archive: ${a.archive_status}, ends at sweep ${a.archive_latest_sweep ?? '?'} (referee ${a.live_latest_sweep ?? '?'}, ${a.archive_lag_sweeps ?? '?'} behind); our sweeps checked ${a.checked_sweeps ?? 0}/${a.needed_sweeps ?? 0} ${JSON.stringify(a.records_by_class || {})}${a.pending_sweeps ? `, ${a.pending_sweeps} still to fetch` : ''}${a.archive_error ? ` — ${a.archive_error}` : ''}`);
  if (s.reference_warning) console.log(`reference: ${s.reference_warning} (trade ${s.reference_age_at_post_seconds} s old at the post; the published reference still stands, rule 11)`);
  if (s.upstream) console.log(`upstream: manifest ${String(s.upstream.manifest_sha256).slice(0, 8)}… (${s.upstream.manifest_status}), rules ${s.upstream.rules_version}, watched issues ${Object.keys(s.upstream.watched || {}).length}`);
  if (s.upstream_error) console.log(`upstream check failed: ${s.upstream_error}`);
  console.log(`github watcher: ${s.github_watch_status ?? '?'} (remaining ${s.github_remaining ?? '?'}, reset ${s.github_reset_at ?? '?'}, last success ${s.github_last_success ?? 'never'}${s.github_authenticated ? ', token' : ', no token'})`);
  console.log(`owner confidence: ${s.owner_confidence} [${(s.owner_evidence_sources || []).map((x) => `${x.evidence}${x.sweep ? `@${x.sweep}` : ''}`).join(', ')}]`);
  const acct = s.corroborated_account;
  if (acct) {
    console.log(`corroborated account (${acct.label}): position ${acct.net_position} (unknown range ${acct.unknown_range.low} … ${acct.unknown_range.high}), cash ${acct.cash}, fees ${acct.fees}, avg entry ${acct.average_entry}, score ${JSON.stringify(acct.score_at)}`);
    for (const x of s.account_comparison?.conflicts || []) console.log(`ACCOUNT CONFLICT ${x.kind}: ${x.detail}`);
  }
  const es = s.evidence_summary;
  if (es) console.log(`evidence: settled proven ${es.tally.proven_settled_ours}, corroborated ${es.tally.at_least_officially_corroborated}/${es.tally.attempts}, unknown ${es.tally.unknown} · RECOMMENDED_NEXT_MODE = ${es.recommended_next_mode} (for a person; not read by the agent)`);
  console.log(`gate: ${s.gate?.kind ?? '?'}${s.gate?.ok ? '' : ` — ${(s.gate?.reasons || []).join(', ')}`} · host ${s.active_runtime_host} · operator ${s.operator_mode ?? s.operator_mode_status} · writes allowed ${s.writes_allowed} (actual total ${s.writes_actual_total}, this cycle ${s.writes_this_cycle}) · evidence ${s.evidence_status} · telegram ${s.telegram_status} · updater ${s.updater_status} · commit ${String(s.runtime_commit).slice(0, 7)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
