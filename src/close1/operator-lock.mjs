/**
 * The operator's safety control for close-1, and everything that proves it held.
 *
 *   data/local/close1/operator-mode.json   { "mode": "EVIDENCE_ONLY" | "ACTIVE" }
 *   data/local/close1/host-role.json       { "host": "MINI_PC", "writer": true }
 *
 * Writes (signing, posting, probes, trades) are allowed only when BOTH say so:
 * the mode is exactly ACTIVE and this host is declared a writer. A file that is
 * missing, unreadable, malformed or naming a mode we do not know means NO.
 * Nothing in this codebase ever writes either file; a person does.
 *
 * Reads, reconciliation, archive fetches, the GitHub watch, the dashboard and
 * Telegram are not gated by it.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODES = Object.freeze({ EVIDENCE_ONLY: 'EVIDENCE_ONLY', ACTIVE: 'ACTIVE' });
export const LOCK_FILE = 'operator-mode.json';
export const HOST_FILE = 'host-role.json';
export const WRITES_FILE = 'writes.json';

export class WritesBlocked extends Error {
  constructor(why) { super(`writes blocked: ${why}`); this.code = 'WRITES_BLOCKED'; this.why = why; }
}

const readObject = (file) => {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return { status: err.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE', value: null }; }
  try {
    const v = JSON.parse(raw.replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? { status: 'OK', value: v } : { status: 'MALFORMED', value: null };
  } catch { return { status: 'MALFORMED', value: null }; }
};

/** The lock as it is on disk right now. Never throws. */
export function readOperatorLock(dir) {
  const lock = readObject(path.join(dir, LOCK_FILE));
  const host = readObject(path.join(dir, HOST_FILE));
  const mode = lock.status === 'OK' && typeof lock.value.mode === 'string' ? lock.value.mode : null;
  const modeStatus = lock.status !== 'OK' ? lock.status : Object.values(MODES).includes(mode) ? 'OK' : 'UNKNOWN_MODE';
  const writer = host.status === 'OK' && host.value.writer === true;
  const reasons = [];
  if (modeStatus !== 'OK') reasons.push(`operator mode ${modeStatus}`);
  else if (mode !== MODES.ACTIVE) reasons.push(`operator mode ${mode}`);
  if (!writer) reasons.push(host.status === 'OK' ? 'host is not a declared writer' : `host role ${host.status}`);
  return {
    mode: modeStatus === 'OK' ? mode : null,
    mode_status: modeStatus,
    host: host.status === 'OK' && typeof host.value.host === 'string' ? host.value.host : null,
    host_writer: writer,
    writes_allowed: reasons.length === 0,
    reasons
  };
}

/** A function that re-reads the lock and throws WritesBlocked; call it right before every write. */
export const makeWriteGuard = (dir) => (what = 'write') => {
  const l = readOperatorLock(dir);
  if (!l.writes_allowed) throw new WritesBlocked(`${what}: ${l.reasons.join('; ')}`);
  return l;
};

/** Alerts for the lock changing under us, or breaking. `prev` is the last snapshot's lock fields. */
export function lockAlerts(prev, next) {
  const out = [];
  if (!prev || prev.operator_mode === undefined) return out;
  const was = prev.operator_mode; const now = next.operator_mode;
  const status = next.operator_mode_status;
  if (status && status !== 'OK') out.push({ kind: 'operator_lock_broken', text: `close-1 operator lock is ${status}: writes are blocked (fail-closed). Mode was ${was ?? 'unknown'}.` });
  else if (was !== now) out.push({ kind: 'operator_mode_changed', text: `close-1 operator mode changed ${was ?? 'unknown'} → ${now}${now === MODES.ACTIVE ? ' — writes are now permitted if the host is a writer' : ''}` });
  if (prev.host_writer === false && next.host_writer === true) out.push({ kind: 'host_became_writer', text: `close-1 host ${next.active_runtime_host ?? '?'} is now declared a writer` });
  return out;
}

/** What we did or tried to do, so "no write since EVIDENCE_ONLY" is a fact, not an absence of logs. */
export function readWrites(dir) {
  const r = readObject(path.join(dir, WRITES_FILE));
  const v = r.value || {};
  return {
    last_attempt_at: v.last_attempt_at ?? null, last_actual_write_at: v.last_actual_write_at ?? null,
    attempts: v.attempts ?? 0, actual: v.actual ?? 0, known_seqs: Array.isArray(v.known_seqs) ? v.known_seqs : [],
    watch_since_seq: v.watch_since_seq ?? null
  };
}

export function recordWrite(dir, { phase, seq = null, now = new Date() }) {
  const w = readWrites(dir);
  if (phase === 'attempt') { w.last_attempt_at = now.toISOString(); w.attempts += 1; }
  if (phase === 'done') { w.last_actual_write_at = now.toISOString(); w.actual += 1; if (seq != null) w.known_seqs = [...w.known_seqs, seq].slice(-500); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WRITES_FILE), JSON.stringify(w, null, 2));
  return w;
}

/**
 * Posts by OUR key in the close-1 room that this host did not make. On the first
 * look the watch starts at the newest such post (everything older is history from
 * before this host existed); after that any newer unknown post means another
 * machine is signing with the same key.
 */
export function foreignWrites({ records, ourDid, writes }) {
  const ours = (records || []).filter((r) => r.from === ourDid && Number.isFinite(r.seq));
  const newest = ours.reduce((m, r) => Math.max(m, r.seq), 0);
  if (writes.watch_since_seq == null) return { foreign: [], since: newest, initialised: true };
  const known = new Set(writes.known_seqs);
  const foreign = ours.filter((r) => r.seq > writes.watch_since_seq && !known.has(r.seq)).map((r) => r.seq);
  return { foreign, since: writes.watch_since_seq, initialised: false };
}

export function setWatchSince(dir, seq) {
  const w = readWrites(dir);
  w.watch_since_seq = seq;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WRITES_FILE), JSON.stringify(w, null, 2));
}
