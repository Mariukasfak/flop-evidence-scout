/**
 * The official per-sweep archive, reconciled against what the referee signed.
 *
 * FLOP Labs published the records behind each post's `file` hash on 2026-09-28
 * (flop-labs/technocore-close-call-challenge#12, comment 5863800939, sv):
 * https://challenges.technocore.chat/close-1/, "index.json maps each sweep to
 * its hash. Trades posted in private rooms are redacted."
 *
 * index.json, as measured 2026-09-28/29 (not a published schema — our reading):
 *
 *   { "contest": "close-1", "sweeps": [ { n, file, path, status, bytes,
 *                                         redacted?, sha256? }, … ] }
 *
 *   file      the referee's hash for sweep n — equal to the `file` in the signed
 *             price/flow/pnl posts of that sweep (checked for every sweep we use)
 *   status    "full" | "redacted"
 *   path      sweeps/<file>.json (full) or redacted/<file>.json (redacted)
 *   sha256    redacted only: the hash of the redacted bytes actually served
 *   redacted  redacted only: how many trades were replaced by {"redacted":"private room"}
 *             — the input AND the output entry, so outcome and id are hidden too
 *   bytes     size of the served file
 *
 * The index carries no signature. What binds a redacted record to the referee
 * is only that the same unsigned index names the referee-signed `file` next to
 * the redacted `sha256`, served over HTTPS from FLOP's domain. That is official
 * publication, not cryptography: nothing lets us recompute `file` from the
 * redacted bytes. (The `sha256` field was pointed out by a participant,
 * shadow4810, in #12 comment 5864047963 — not by FLOP Labs.)
 *
 * Four trust classes, never converted into one another:
 *
 *   REFEREE_HASH_VERIFIED_FULL        sha256(bytes) == the `file` in a signed referee post.
 *                                     The only class that may change a ledger status.
 *   OFFICIAL_INDEX_VERIFIED_REDACTED  sha256(bytes) == the index's redacted `sha256`, and the
 *                                     index's `file` == the signed `file`. Officially published
 *                                     and intact, but not bound to the referee's hash; it
 *                                     yields CORROBORATION, which the risk path never reads.
 *   ARCHIVE_UNVERIFIED                a hash that cannot be checked or does not match.
 *   ARCHIVE_MISSING                   not published yet (the index ends before it) or 404.
 *
 * Freshness (#15): the index stopped at sweep 766 (Last-Modified 2026-09-28
 * 04:15Z) while the referee kept posting. Missing is unpublished, not empty.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepFor, SWEEP_MS } from './protocol.mjs';

export const ARCHIVE_BASE = 'https://challenges.technocore.chat/close-1/';
export const ARCHIVE_STATUS = Object.freeze({ CURRENT: 'CURRENT', LAGGING: 'LAGGING', UNAVAILABLE: 'UNAVAILABLE' });
export const RECORD = Object.freeze({
  FULL: 'REFEREE_HASH_VERIFIED_FULL',
  REDACTED: 'OFFICIAL_INDEX_VERIFIED_REDACTED',
  UNVERIFIED: 'ARCHIVE_UNVERIFIED',
  MISSING: 'ARCHIVE_MISSING'
});
/** Cache files written before 2026-09-29 used these names. */
const LEGACY_CLASS = {
  ARCHIVE_VERIFIED_FULL: RECORD.FULL, ARCHIVE_REDACTED: RECORD.REDACTED,
  ARCHIVE_UNANCHORED: RECORD.UNVERIFIED, ARCHIVE_HASH_MISMATCH: RECORD.UNVERIFIED
};
/** Evidence a corroboration carries: officially published, hash-checked against the index, not referee-bound. */
export const CORROBORATION = 'OFFICIAL_REDACTED_CORROBORATION';
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

/** CURRENT / LAGGING / UNAVAILABLE, how far behind the referee, and since when nothing moved. */
export function archiveHealth({ index, error = null, liveLatest, prev = null, nowMs, lastModified = null }) {
  const latest = index && index.size ? Math.max(...index.keys()) : null;
  const lag = latest != null && liveLatest != null ? Math.max(0, liveLatest - latest) : null;
  let status = ARCHIVE_STATUS.UNAVAILABLE;
  if (!error && latest != null) status = lag != null && lag <= LAG_TOLERANCE_SWEEPS ? ARCHIVE_STATUS.CURRENT : ARCHIVE_STATUS.LAGGING;
  const entries = index ? [...index.values()] : [];
  const moved = latest != null && latest !== prev?.archive_latest_sweep;
  return {
    archive_status: status,
    archive_latest_sweep: latest,
    live_latest_sweep: liveLatest ?? null,
    archive_lag_sweeps: lag,
    archive_lag_minutes: lag == null ? null : Math.round((lag * SWEEP_MS) / 60_000),
    archive_index_last_modified: lastModified ?? prev?.archive_index_last_modified ?? null,
    archive_latest_changed_at: moved || !prev?.archive_latest_changed_at ? new Date(nowMs).toISOString() : prev.archive_latest_changed_at,
    archive_last_success: error ? (prev?.archive_last_success ?? null) : new Date(nowMs).toISOString(),
    archive_error: error ? String(error).slice(0, 200) : null,
    archive_full_count: entries.filter((e) => e.status === 'full').length,
    archive_redacted_count: entries.filter((e) => e.status === 'redacted').length
  };
}

/**
 * How far one record may be trusted. `signedFile` is the `file` hash from a
 * verified referee post for sweep n (null if we hold none). `integrity` marks a
 * disagreement worth an alert, as opposed to a record we simply cannot check.
 */
export function classifyRecord({ entry, bytes, signedFile }) {
  const got = sha256(bytes);
  if (!signedFile) return { cls: RECORD.UNVERIFIED, sha256: got, why: 'no signed referee post for this sweep to compare against' };
  if (entry.file !== signedFile) return { cls: RECORD.UNVERIFIED, integrity: true, sha256: got, why: 'the index names a hash the referee did not sign' };
  if (got === signedFile) return { cls: RECORD.FULL, sha256: got };
  if (entry.status === 'redacted' && entry.sha256 && got === entry.sha256) return { cls: RECORD.REDACTED, sha256: got };
  return { cls: RECORD.UNVERIFIED, integrity: true, sha256: got, why: 'bytes hash to neither the signed file nor the index sha256' };
}

/**
 * The parts of one record that concern us: whether our key was minted, and
 * every trade that carries one of our ids or names our key, paired with its
 * outcome. Throws if the record is not the sweep it claims or its input and
 * output lists do not line up — such a record is ARCHIVE_UNVERIFIED.
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

/** The maker's side, which is what the record's `side` names. */
const makerSide = (t) => (t.role === 'maker' ? t.ourSide : (t.ourSide === 'buy' ? 'sell' : 'buy'));
const sameTerms = (e, t) => Number(e.px) === Number(t.px) && Number(e.qty) === Number(t.qty) && (!e.side || !t.ourSide || e.side === makerSide(t));
/** Our exact copy: our id, our terms, our key in our role (and, for a take, the maker we took). */
export const isOurCopy = (e, t, ourDid) => e.id === t.id && (t.role === 'maker'
  ? e.maker === ourDid && sameTerms(e, t)
  : e.countersigner === ourDid && e.maker === t.maker && sameTerms(e, t));

/**
 * What the archive says about one of our trades.
 *
 *   verdict        from REFEREE_HASH_VERIFIED_FULL records only — the ledger acts on it:
 *                  'SETTLED_OURS' | 'SETTLED_NOT_OURS' | 'NOT_SETTLED' | null
 *   corroboration  from OFFICIAL_INDEX_VERIFIED_REDACTED records — the ledger shows it
 *                  and never acts on it: { kind: 'SETTLED_OURS' | 'SETTLED_NOT_OURS' |
 *                  'NOT_SETTLED', exact, sweep, maker, countersigner, outcome, reason, fee }
 *
 * A redacted sweep hides the id AND the outcome of every private-room trade, and
 * anyone may post a countersigned copy of our open offer in a private room. So
 * a redacted record can corroborate that a copy settled, or that our own public
 * take copy was voided, but it can corroborate that our OFFER never settled only
 * when no trade at all was redacted in any sweep of the window.
 */
export function archiveVerdict(t, { records, ourDid, cfg = null }) {
  const { from, last } = windowOf(t, cfg);
  const gaps = { window: [from, last], missing: [], redacted: [], unverified: [], hidden_trades: 0 };
  const observations = [];
  let allFull = true; let allReadable = true;
  let fullVoid = null; let redVoid = null; let corroboration = null;
  let verdict = null;
  for (let n = from; n <= last; n++) {
    const rec = records.get(n);
    const cls = rec ? (LEGACY_CLASS[rec.cls] ?? rec.cls) : RECORD.MISSING;
    if (cls === RECORD.MISSING) { gaps.missing.push(n); allFull = false; allReadable = false; continue; }
    if (cls === RECORD.UNVERIFIED) { gaps.unverified.push(n); allFull = false; allReadable = false; continue; }
    if (cls === RECORD.REDACTED) { gaps.redacted.push(n); allFull = false; gaps.hidden_trades += rec.extract?.redacted_trades ?? 0; }
    for (const e of rec.extract?.trades || []) {
      if (e.id !== t.id) continue;
      const ours = isOurCopy(e, t, ourDid);
      const fee = t.role === 'maker' ? e.maker_fee : e.taker_fee;
      const seen = { sweep: n, record: cls, outcome: e.outcome, reason: e.reason, maker: e.maker, countersigner: e.countersigner, side: e.side, px: e.px, qty: e.qty, ours, fee: ours ? fee : null };
      observations.push(seen);
      if (cls === RECORD.FULL) {
        if (e.outcome === 'settled' && !verdict) verdict = { verdict: ours ? 'SETTLED_OURS' : 'SETTLED_NOT_OURS', sweep: n, maker: e.maker, countersigner: e.countersigner, fee: ours ? fee : null };
        else if (ours && !fullVoid && e.outcome !== 'settled') fullVoid = { sweep: n, reason: e.reason };
      } else if (e.outcome === 'settled' && !corroboration) {
        corroboration = { kind: ours ? 'SETTLED_OURS' : 'SETTLED_NOT_OURS', exact: ours, ...seen };
      } else if (ours && !redVoid && e.outcome !== 'settled') redVoid = seen;
    }
  }
  if (!verdict && fullVoid && t.role !== 'maker') {
    verdict = { verdict: fullVoid.reason === 'settled' ? 'SETTLED_NOT_OURS' : 'NOT_SETTLED', sweep: fullVoid.sweep, voidReason: fullVoid.reason };
  }
  if (!verdict && allFull) verdict = { verdict: 'NOT_SETTLED', sweep: last, voidReason: fullVoid?.reason ?? null };
  if (!corroboration && redVoid && t.role !== 'maker') {
    corroboration = { kind: redVoid.reason === 'settled' ? 'SETTLED_NOT_OURS' : 'NOT_SETTLED', exact: true, ...redVoid };
  }
  if (!corroboration && !verdict && allReadable && gaps.redacted.length && gaps.hidden_trades === 0) {
    corroboration = { kind: 'NOT_SETTLED', exact: false, sweep: last, record: RECORD.REDACTED, outcome: null, reason: 'no copy in any sweep of the window, and none redacted' };
  }
  return { verdict: verdict?.verdict ?? null, ...(verdict || {}), corroboration, observations, gaps: verdict ? null : gaps };
}

/**
 * Our mint in the archive. Kept apart by source: `verified` only from a
 * REFEREE_HASH_VERIFIED_FULL record, `corroborated` from an index-verified
 * redacted one (the `minted` list is not redacted).
 */
export function archiveMint({ records, regSweep }) {
  const out = { verified: null, corroborated: null };
  if (!regSweep) return out;
  for (const n of [regSweep, regSweep + 1]) {
    const rec = records.get(n);
    if (!rec?.extract?.minted_us) continue;
    const cls = LEGACY_CLASS[rec.cls] ?? rec.cls;
    if (cls === RECORD.FULL) { out.verified = { sweep: n }; break; }
    if (cls === RECORD.REDACTED && !out.corroborated) out.corroborated = { sweep: n, record: cls };
  }
  return out;
}

/** Every sweep our trades and mint could touch, published or not. */
export function wantedSweeps({ trades, registration, cfg = null }) {
  const need = new Set();
  for (const t of trades) {
    const { from, last } = windowOf(t, cfg);
    for (let n = from; n <= last; n++) need.add(n);
  }
  if (registration?.postedAt) {
    const r = sweepFor(Date.parse(registration.postedAt), cfg);
    need.add(r); need.add(r + 1);
  }
  return [...need].sort((a, b) => a - b);
}

/** The wanted sweeps the archive has published so far. */
export function neededSweeps({ trades, registration, cfg = null, archiveLatest }) {
  return wantedSweeps({ trades, registration, cfg }).filter((n) => archiveLatest != null && n <= archiveLatest);
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
  prevHealth = null, nowMs = Date.now(), fetchFn = fetch, maxFetch = MAX_FETCH_PER_RUN, base = ARCHIVE_BASE, revalidate = false
}) {
  const meta = readJson(path.join(cacheDir, 'index-meta.json'), null);
  let index = null; let error = null; let lastModified = meta?.lastModified ?? null;
  try {
    const r = await fetchFn(`${base}index.json`, { headers: meta?.etag ? { 'if-none-match': meta.etag } : {} });
    if (r.status === 304 && meta?.body) index = parseIndex(meta.body);
    else if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
    else {
      const body = await r.text();
      index = parseIndex(body);
      lastModified = r.headers?.get?.('last-modified') ?? null;
      writeJson(path.join(cacheDir, 'index-meta.json'), { etag: r.headers?.get?.('etag') ?? null, lastModified, at: new Date(nowMs).toISOString(), body });
    }
  } catch (err) {
    error = err.message;
    try { if (meta?.body) index = parseIndex(meta.body); } catch { index = null; }
  }
  const health = archiveHealth({ index: error ? null : index, error, liveLatest, prev: prevHealth, nowMs, lastModified });
  if (error && index) { health.archive_latest_sweep = Math.max(...index.keys()); health.archive_cached_index = true; }

  const ids = new Set(trades.map((t) => t.id));
  const records = new Map();
  const mismatches = [];
  let fetched = 0; let pending = 0;
  const differs = []; let compared = 0;
  const archiveLatest = index ? Math.max(...index.keys()) : null;
  const wanted = wantedSweeps({ trades, registration, cfg });
  const need = wanted.filter((n) => archiveLatest != null && n <= archiveLatest);
  for (const n of need) {
    const entry = index.get(n);
    if (!entry) continue;
    const signedFile = signedFiles.get(n) ?? null;
    const key = `${entry.status}:${entry.file}:${entry.sha256 ?? ''}:${signedFile ?? ''}`;
    const f = path.join(cacheDir, 'records', `${n}.json`);
    let rec = readJson(f, null);
    // revalidate: whatever is cached (a copy from another host, say) is derived data, not authority.
    // It is fetched and hashed again; the cached copy only serves as a cross-check.
    const cached = revalidate ? rec : null;
    if (revalidate) rec = null;
    if (rec?.key !== key) rec = null;   // a new trade's id cannot appear in a sweep before it was posted
    if (!rec && !error) {
      if (!revalidate && fetched >= maxFetch) { pending += 1; continue; }
      try {
        const r = await fetchFn(`${base}${entry.path}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = Buffer.from(await r.arrayBuffer());
        fetched += 1;
        const c = classifyRecord({ entry, bytes, signedFile });
        let extract = null; let why = c.why ?? null; let cls = c.cls; let integrity = Boolean(c.integrity);
        if (cls !== RECORD.UNVERIFIED) {
          try { extract = extractRecord(bytes, n, { ids, ourDid }); } catch (err) { cls = RECORD.UNVERIFIED; integrity = true; why = err.message; }
        }
        rec = { n, key, cls, integrity, sha256: c.sha256, why, extract, checkedAt: new Date(nowMs).toISOString() };
        writeJson(f, rec);
        if (cached) {
          compared += 1;
          const norm = (r) => JSON.stringify({ k: r.key, c: LEGACY_CLASS[r.cls] ?? r.cls, s: r.sha256 ?? null, e: r.extract ?? null });
          if (norm(cached) !== norm(rec)) differs.push(n);
        }
      } catch (err) { pending += 1; health.archive_fetch_error = `sweep ${n}: ${err.message}`.slice(0, 200); continue; }
    }
    if (!rec) { pending += 1; continue; }
    const cls = LEGACY_CLASS[rec.cls] ?? rec.cls;
    const integrity = rec.integrity ?? rec.cls === 'ARCHIVE_HASH_MISMATCH';
    records.set(n, { ...rec, cls, integrity });
    if (integrity) mismatches.push({ n, why: rec.why });
  }
  const byCls = {};
  for (const r of records.values()) byCls[r.cls] = (byCls[r.cls] || 0) + 1;
  const ourMissing = wanted.filter((n) => !records.has(n));
  const cacheOk = pending === 0 && mismatches.length === 0 && records.size === need.length;
  if (ourMissing.length) byCls[RECORD.MISSING] = ourMissing.length;
  return {
    health: {
      ...health, needed_sweeps: wanted.length, checked_sweeps: records.size, pending_sweeps: pending, fetched_this_run: fetched,
      records_by_class: byCls, mismatch_sweeps: mismatches.map((m) => m.n), our_missing_sweeps: ourMissing,
      archive_cache_required: need.length, archive_cache_present: records.size, archive_cache_valid: cacheOk,
      ...(revalidate ? { revalidated: { fetched, compared_with_cache: compared, differs_from_cache: differs } } : {})
    },
    records,
    mismatches
  };
}
