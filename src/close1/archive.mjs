/**
 * The official per-sweep archive, reconciled against what the referee signed.
 *
 * FLOP Labs published the records behind each post's `file` hash on 2026-09-28
 * (flop-labs/technocore-close-call-challenge#12, comment 5863800939):
 * https://challenges.technocore.chat/close-1/, with `index.json` mapping each
 * sweep to its record. Two limits decide how far any record may be trusted:
 *
 *   Redaction. "Trades posted in private rooms are redacted." A redacted
 *   record no longer hashes to the `file` the referee signed, so nothing ties
 *   its bytes to the referee. It is a hint, never an authoritative record: it
 *   cannot prove a trade settled, that one did not, or whose copy it was. On
 *   2026-09-28 every sweep holding one of our trades (249-409) was redacted.
 *
 *   Freshness. The archive is not kept current (issue #15): at 19:25Z on
 *   2026-09-28 `index.json` ended at sweep 766 (Last-Modified 04:15Z) while
 *   the referee posted sweep 952. A sweep missing from the archive is
 *   unpublished, not empty; lag never turns UNKNOWN into NOT_SETTLED.
 *
 * Only ARCHIVE_VERIFIED_FULL — sha256(bytes) equals the `file` hash inside a
 * signed referee post for that sweep — may change a trade's status. The pure
 * functions below decide that; `reconcileArchive` fetches only the sweeps our
 * trades and our mint need, and caches each checked record as a small extract.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepFor } from './protocol.mjs';

export const ARCHIVE_BASE = 'https://challenges.technocore.chat/close-1/';
export const ARCHIVE_STATUS = Object.freeze({ CURRENT: 'CURRENT', LAGGING: 'LAGGING', UNAVAILABLE: 'UNAVAILABLE' });
export const RECORD = Object.freeze({
  VERIFIED_FULL: 'ARCHIVE_VERIFIED_FULL',   // bytes hash to the referee-signed `file`: authoritative
  REDACTED: 'ARCHIVE_REDACTED',             // bytes match the index's redacted hash; not referee-bound
  UNANCHORED: 'ARCHIVE_UNANCHORED',         // we hold no signed post for this sweep to compare against
  MISMATCH: 'ARCHIVE_HASH_MISMATCH'         // bytes or index disagree with the referee's signed hash
});
/** An hour of sweeps: the archive publishes in batches, so a small lag is not news. */
export const LAG_TOLERANCE_SWEEPS = 12;
export const MAX_FETCH_PER_RUN = 24;

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** `index.json`, checked entry by entry. Throws on anything malformed: an index we cannot read is UNAVAILABLE. */
export function parseIndex(json) {
  const body = typeof json === 'string' ? JSON.parse(json) : json;
  if (body?.contest !== 'close-1' || !Array.isArray(body.sweeps)) throw new Error('index: not a close-1 index');
  const out = new Map();
  for (const e of body.sweeps) {
    if (!Number.isInteger(e?.n) || e.n < 1 || !HEX64.test(e.file ?? '')) throw new Error(`index: malformed entry ${JSON.stringify(e).slice(0, 80)}`);
    if (!/^(sweeps|redacted)\/[0-9a-f]{64}\.json$/.test(e.path ?? '')) throw new Error(`index: unsafe path for sweep ${e.n}`);
    if (e.status === 'redacted' && !HEX64.test(e.sha256 ?? '')) throw new Error(`index: redacted sweep ${e.n} has no sha256`);
    out.set(e.n, { n: e.n, file: e.file, path: e.path, status: e.status, sha256: e.sha256 ?? null, bytes: e.bytes ?? null, redacted: e.redacted ?? 0 });
  }
  return out;
}

/** CURRENT / LAGGING / UNAVAILABLE, and how far behind the referee the archive is. */
export function archiveHealth({ index, error = null, liveLatest, prev = null, nowMs }) {
  const latest = index && index.size ? Math.max(...index.keys()) : null;
  const lag = latest != null && liveLatest != null ? Math.max(0, liveLatest - latest) : null;
  let status = ARCHIVE_STATUS.UNAVAILABLE;
  if (!error && latest != null) status = lag != null && lag <= LAG_TOLERANCE_SWEEPS ? ARCHIVE_STATUS.CURRENT : ARCHIVE_STATUS.LAGGING;
  const entries = index ? [...index.values()] : [];
  return {
    archive_status: status,
    archive_latest_sweep: latest,
    live_latest_sweep: liveLatest ?? null,
    archive_lag_sweeps: lag,
    archive_last_success: error ? (prev?.archive_last_success ?? null) : new Date(nowMs).toISOString(),
    archive_error: error ? String(error).slice(0, 200) : null,
    archive_full_count: entries.filter((e) => e.status === 'full').length,
    archive_redacted_count: entries.filter((e) => e.status === 'redacted').length
  };
}

/**
 * How far one record may be trusted. `signedFile` is the `file` hash from a
 * verified referee post for sweep n (null if we hold none).
 */
export function classifyRecord({ entry, bytes, signedFile }) {
  const got = sha256(bytes);
  if (!signedFile) return { cls: RECORD.UNANCHORED, sha256: got };
  if (entry.file !== signedFile) return { cls: RECORD.MISMATCH, sha256: got, why: 'index maps the sweep to a hash the referee did not sign' };
  if (got === signedFile) return { cls: RECORD.VERIFIED_FULL, sha256: got };
  if (entry.status === 'redacted' && entry.sha256 && got === entry.sha256) return { cls: RECORD.REDACTED, sha256: got };
  return { cls: RECORD.MISMATCH, sha256: got, why: 'bytes hash to neither the signed file nor the index' };
}

/**
 * The parts of one record that concern us: whether our key was minted, and
 * every trade that carries one of our ids or names our key, paired with its
 * outcome. Throws if the record is not the sweep it claims or its input and
 * output lists do not line up — such a record is treated as a mismatch.
 */
export function extractRecord(record, n, { ids, ourDid }) {
  const j = typeof record === 'string' || Buffer.isBuffer(record) ? JSON.parse(String(record)) : record;
  const inp = j?.input; const out = j?.output;
  if (!inp || !out || inp.n !== n || out.sweep !== n || !Array.isArray(inp.trades) || !Array.isArray(out.trades)) throw new Error(`record ${n}: not sweep ${n}`);
  if (inp.trades.length !== out.trades.length) throw new Error(`record ${n}: ${inp.trades.length} trades in, ${out.trades.length} outcomes`);
  const trades = [];
  let redactedTrades = 0;
  inp.trades.forEach((t, i) => {
    if (t && t.redacted) { redactedTrades += 1; return; }
    const o = out.trades[i];
    if (o?.id !== t?.id) throw new Error(`record ${n}: outcome ${i} is for ${o?.id}, not ${t?.id}`);
    if (!ids.has(t.id) && t.maker !== ourDid && t.countersigner !== ourDid) return;
    trades.push({
      i, id: t.id, maker: t.maker, countersigner: t.countersigner, taker: t.taker, side: t.side, px: t.px, qty: t.qty, until: t.until,
      outcome: o.outcome, reason: o.reason ?? null, maker_fee: o.maker_fee ?? null, taker_fee: o.taker_fee ?? null
    });
  });
  return { n, minted_us: Array.isArray(out.minted) && out.minted.includes(ourDid), trades, redacted_trades: redactedTrades };
}

/** The sweeps in which this trade could settle (the ledger's own window). */
export function windowOf(t, cfg = null) {
  const from = sweepFor(Date.parse(t.postedAt), cfg);
  const last = t.role === 'maker' ? Math.max(t.until, from) : from + 1;
  return { from, last };
}

const sameTerms = (e, t) => Number(e.px) === Number(t.px) && Number(e.qty) === Number(t.qty);
const isOurCopy = (e, t, ourDid) => (t.role === 'maker'
  ? e.maker === ourDid && sameTerms(e, t)
  : e.countersigner === ourDid && e.maker === t.maker && sameTerms(e, t));

/**
 * What the archive says about one of our trades.
 *
 *   { verdict: 'SETTLED_OURS' | 'SETTLED_NOT_OURS' | 'NOT_SETTLED' | null, … }
 *
 * A verdict needs VERIFIED_FULL records: a settled copy in one of them, our
 * own copy voided in one of them (a take is applied once), or every sweep of
 * the window verified and none settling the id. Anything short of that
 * returns verdict null with the gaps named; redacted records contribute only
 * `observations`, which the ledger shows and never acts on.
 */
export function archiveVerdict(t, { records, ourDid, cfg = null }) {
  const { from, last } = windowOf(t, cfg);
  const observations = [];
  const missing = []; const redacted = []; const unanchored = []; const mismatched = [];
  let allVerified = true;
  let ourVoid = null;
  for (let n = from; n <= last; n++) {
    const rec = records.get(n);
    if (!rec) { missing.push(n); allVerified = false; continue; }
    if (rec.cls !== RECORD.VERIFIED_FULL) {
      allVerified = false;
      ({ [RECORD.REDACTED]: redacted, [RECORD.UNANCHORED]: unanchored, [RECORD.MISMATCH]: mismatched }[rec.cls] || missing).push(n);
      for (const e of rec.extract?.trades || []) {
        if (e.id === t.id) observations.push({ sweep: n, record: rec.cls, outcome: e.outcome, reason: e.reason, maker: e.maker, countersigner: e.countersigner, ours: isOurCopy(e, t, ourDid) });
      }
      continue;
    }
    for (const e of rec.extract?.trades || []) {
      if (e.id !== t.id) continue;
      if (e.outcome === 'settled') {
        const ours = isOurCopy(e, t, ourDid);
        return {
          verdict: ours ? 'SETTLED_OURS' : 'SETTLED_NOT_OURS', sweep: n, maker: e.maker, countersigner: e.countersigner,
          fee: t.role === 'maker' ? e.maker_fee : e.taker_fee, observations
        };
      }
      if (isOurCopy(e, t, ourDid) && !ourVoid) ourVoid = { sweep: n, reason: e.reason };
    }
  }
  if (ourVoid && t.role !== 'maker') {
    return { verdict: ourVoid.reason === 'settled' ? 'SETTLED_NOT_OURS' : 'NOT_SETTLED', sweep: ourVoid.sweep, voidReason: ourVoid.reason, observations };
  }
  if (allVerified) return { verdict: 'NOT_SETTLED', sweep: last, voidReason: ourVoid?.reason ?? null, observations };
  return { verdict: null, window: [from, last], missing, redacted, unanchored, mismatched, observations };
}

/** Our mint in the archive: verified only from a VERIFIED_FULL record listing our key. */
export function archiveMint({ records, regSweep }) {
  const out = { verified: null, observed: null };
  if (!regSweep) return out;
  for (const n of [regSweep, regSweep + 1]) {
    const rec = records.get(n);
    if (!rec?.extract?.minted_us) continue;
    if (rec.cls === RECORD.VERIFIED_FULL) { out.verified = { sweep: n }; break; }
    out.observed = { sweep: n, record: rec.cls };
  }
  return out;
}

/** The sweeps worth fetching: every trade's window, and the two sweeps that could mint us. */
export function neededSweeps({ trades, registration, cfg = null, archiveLatest }) {
  const need = new Set();
  for (const t of trades) {
    const { from, last } = windowOf(t, cfg);
    for (let n = from; n <= last; n++) need.add(n);
  }
  if (registration?.postedAt) {
    const r = sweepFor(Date.parse(registration.postedAt), cfg);
    need.add(r); need.add(r + 1);
  }
  return [...need].filter((n) => archiveLatest != null && n <= archiveLatest).sort((a, b) => a - b);
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); };

/**
 * One reconciliation pass. Reads `index.json` (If-None-Match against the last
 * ETag), then fetches at most `maxFetch` needed records not yet checked, and
 * keeps each as an extract under `cacheDir/records/<n>.json`. A cached extract
 * is reused while the index entry and the signed hash it was checked against
 * stay the same, so a restored or replaced record is checked again.
 */
export async function reconcileArchive({
  trades, registration, ourDid, signedFiles, liveLatest, cacheDir, cfg = null,
  prevHealth = null, nowMs = Date.now(), fetchFn = fetch, maxFetch = MAX_FETCH_PER_RUN, base = ARCHIVE_BASE
}) {
  const meta = readJson(path.join(cacheDir, 'index-meta.json'), null);
  let index = null; let error = null;
  try {
    const r = await fetchFn(`${base}index.json`, { headers: meta?.etag ? { 'if-none-match': meta.etag } : {} });
    if (r.status === 304 && meta?.body) index = parseIndex(meta.body);
    else if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
    else {
      const body = await r.text();
      index = parseIndex(body);
      writeJson(path.join(cacheDir, 'index-meta.json'), { etag: r.headers?.get?.('etag') ?? null, lastModified: r.headers?.get?.('last-modified') ?? null, at: new Date(nowMs).toISOString(), body });
    }
  } catch (err) {
    error = err.message;
    try { if (meta?.body) index = parseIndex(meta.body); } catch { index = null; }
  }
  const health = archiveHealth({ index: error ? null : index, error, liveLatest, prev: prevHealth, nowMs });
  if (error && index) { health.archive_latest_sweep = Math.max(...index.keys()); health.archive_cached_index = true; }

  const ids = new Set(trades.map((t) => t.id));
  const records = new Map();
  const mismatches = [];
  let fetched = 0; let pending = 0;
  const need = index ? neededSweeps({ trades, registration, cfg, archiveLatest: Math.max(...index.keys()) }) : [];
  for (const n of need) {
    const entry = index.get(n);
    if (!entry) continue;
    const signedFile = signedFiles.get(n) ?? null;
    const key = `${entry.status}:${entry.file}:${entry.sha256 ?? ''}:${signedFile ?? ''}`;
    const f = path.join(cacheDir, 'records', `${n}.json`);
    let rec = readJson(f, null);
    if (rec?.key !== key) rec = null;   // a new trade's id cannot appear in a sweep before it was posted
    if (!rec && !error) {
      if (fetched >= maxFetch) { pending += 1; continue; }
      try {
        const r = await fetchFn(`${base}${entry.path}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        fetched += 1;
        const c = classifyRecord({ entry, bytes, signedFile });
        let extract = null; let why = c.why ?? null; let cls = c.cls;
        if (cls !== RECORD.MISMATCH) {
          try { extract = extractRecord(bytes, n, { ids, ourDid }); } catch (err) { cls = RECORD.MISMATCH; why = err.message; }
        }
        rec = { n, key, cls, sha256: c.sha256, why, extract, checkedAt: new Date(nowMs).toISOString() };
        writeJson(f, rec);
      } catch (err) { pending += 1; health.archive_fetch_error = `sweep ${n}: ${err.message}`.slice(0, 200); continue; }
    }
    if (!rec) { pending += 1; continue; }
    records.set(n, rec);
    if (rec.cls === RECORD.MISMATCH) mismatches.push({ n, why: rec.why });
  }
  const byCls = {};
  for (const r of records.values()) byCls[r.cls] = (byCls[r.cls] || 0) + 1;
  return {
    health: { ...health, needed_sweeps: need.length, checked_sweeps: records.size, pending_sweeps: pending, fetched_this_run: fetched, records_by_class: byCls, mismatch_sweeps: mismatches.map((m) => m.n) },
    records,
    mismatches
  };
}
