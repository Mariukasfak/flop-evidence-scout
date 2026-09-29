/**
 * The operator's Telegram console for close-1: READ-ONLY.
 *
 * It reads the snapshot and forensics files the runtime already writes, answers
 * a whitelist of commands, and stores three monitoring settings. It has no path
 * to the executor, the signer, the operator lock, the host role, the attempt cap
 * or a shell: nothing in this file imports them, and nothing here writes any file
 * outside data/local/telegram/. The read-only forensics refresh is injected by
 * the process wrapper (tools/telegram-bot.mjs).
 *
 * Authorization: only a PRIVATE chat whose id equals TELEGRAM_CHAT_ID. Anyone
 * else gets "Unauthorized." (private chats) or nothing (groups, channels).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY } from './risk-gate.mjs';
import { lastModifiedAgeMin, MIN_INDEPENDENT_ADVANCES } from './publication.mjs';

const CAP = DEFAULT_POLICY.maxAttempts; // display only; this file never changes it

/** data/local/close1 -> data/local/telegram (the bot's own files live beside, not inside, the runtime's). */
export const tgDir = (dataDir) => path.join(path.dirname(path.resolve(dataDir)), 'telegram');
export const STATE_FILE = 'update-state.json';
export const SETTINGS_FILE = 'settings.json';
export const AUDIT_FILE = 'operator-audit.jsonl';
export const UNAUTHORIZED = 'Unauthorized.';
export const BLOCKED = 'Blocked: this action requires local operator control on MINI_PC.';
export const MAX_MESSAGE = 3500; // Telegram allows 4096; leave room

export const DEFAULT_SETTINGS = Object.freeze({ alert_level: 'normal', quiet_mode: false, github_interval_minutes: 30, archive_resume_threshold_sweeps: 50 });

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; } };

/* ------------------------------------------------------------------ settings */

/** Settings on disk, each value re-validated; anything odd falls back to its default. */
export function loadSettings(dataDir) {
  const raw = readJson(path.join(tgDir(dataDir), SETTINGS_FILE), {}) || {};
  const out = { ...DEFAULT_SETTINGS };
  if (['critical', 'normal', 'all'].includes(raw.alert_level)) out.alert_level = raw.alert_level;
  if (typeof raw.quiet_mode === 'boolean') out.quiet_mode = raw.quiet_mode;
  if (Number.isInteger(raw.github_interval_minutes) && raw.github_interval_minutes >= 15 && raw.github_interval_minutes <= 360) out.github_interval_minutes = raw.github_interval_minutes;
  if (Number.isInteger(raw.archive_resume_threshold_sweeps) && raw.archive_resume_threshold_sweeps >= 10 && raw.archive_resume_threshold_sweeps <= 500) out.archive_resume_threshold_sweeps = raw.archive_resume_threshold_sweeps;
  return out;
}

const INT = /^[0-9]{1,4}$/;
/** The whole /set whitelist. Returns { key, value } or { error }. */
export function parseSet(args) {
  const [name, val, ...rest] = args;
  if (!name || val === undefined || rest.length) return { error: 'Naudojimas: /set alert_level critical|normal|all · /set quiet_mode on|off · /set github_interval 15-360 · /set archive_threshold 10-500' };
  if (name === 'alert_level') return ['critical', 'normal', 'all'].includes(val) ? { key: 'alert_level', value: val } : { error: 'alert_level: critical, normal arba all' };
  if (name === 'quiet_mode') return val === 'on' || val === 'off' ? { key: 'quiet_mode', value: val === 'on' } : { error: 'quiet_mode: on arba off' };
  if (name === 'github_interval') {
    const n = INT.test(val) ? Number(val) : NaN;
    return n >= 15 && n <= 360 ? { key: 'github_interval_minutes', value: n } : { error: 'github_interval: sveikas skaičius 15-360 (minutės)' };
  }
  if (name === 'archive_threshold') {
    const n = INT.test(val) ? Number(val) : NaN;
    return n >= 10 && n <= 500 ? { key: 'archive_resume_threshold_sweeps', value: n } : { error: 'archive_threshold: sveikas skaičius 10-500 (sweep\'ai)' };
  }
  return { error: `Nežinomas nustatymas „${String(name).slice(0, 30)}“. Leidžiama: alert_level, quiet_mode, github_interval, archive_threshold.` };
}

function applySet(dataDir, key, value, now) {
  const dir = tgDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const cur = loadSettings(dataDir);
  const before = cur[key];
  const next = { ...cur, [key]: value };
  fs.writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(next, null, 2));
  const entry = { at: now.toISOString(), by: 'authorized Telegram operator', setting: key, from: before, to: value };
  fs.appendFileSync(path.join(dir, AUDIT_FILE), JSON.stringify(entry) + '\n');
  return { before, entry };
}

/* --------------------------------------------------------- alert classification */

/** Never suppressed, whatever the settings. */
export const CRITICAL_KINDS = Object.freeze(new Set([
  'foreign_writer_detected', 'host_became_writer', 'operator_mode_changed', 'operator_lock_broken', 'account_conflict',
  'archive_integrity', 'referee_key_changed', 'write_blocked_attempt', 'actual_write'
]));
export const IMPORTANT_KINDS = Object.freeze(new Set([
  'evidence_report', 'archive_our_sweeps', 'archive_current', 'archive_advanced', 'unknown_resolved', 'corroboration_changed',
  'settled_proven', 'trade_resolved', 'owner_stronger', 'mint_confirmed', 'proven_exposure_changed', 'mode_changed',
  'maintainer_reply', 'new_watched_issue', 'watched_issue_state', 'github_watch_blind', 'github_watch_restored',
  'prize_place_proven', 'publication_transition', 'updater_blocked', 'write_failure', 'archive_lagging', 'contest_verification_failed',
  'contest_verification_restored', 'referee_stale', 'risk_gate_halt', 'package_changed_upstream', 'package_not_draft',
  'rules_repo_changed', 'rules_version_final', 'seed_changed', 'launch_record_published'
]));
export const severityOf = (kind) => (CRITICAL_KINDS.has(kind) ? 'CRITICAL' : IMPORTANT_KINDS.has(kind) ? 'IMPORTANT' : 'INFO');
export const SEVERITY_LABEL = Object.freeze({ CRITICAL: '🔴 KRITINIS', IMPORTANT: '🟡 SVARBU', INFO: '🟢 INFO' });

/** What of these alerts may be sent, under the operator's settings. logOnly ones never are. */
export function selectForTelegram(alerts, settings = DEFAULT_SETTINGS) {
  const send = []; const held = [];
  for (const a of alerts) {
    const sev = severityOf(a.kind);
    if (a.logOnly) continue;
    let why = null;
    if (sev !== 'CRITICAL') {
      if (settings.quiet_mode) why = 'QUIET_MODE';
      else if (settings.alert_level === 'critical') why = 'ALERT_LEVEL_CRITICAL';
      else if (settings.alert_level === 'normal' && sev === 'INFO') why = 'ALERT_LEVEL_NORMAL';
    }
    (why ? held : send).push(why ? { ...a, telegram: `HELD_${why}` } : a);
  }
  return { send, held };
}

/* ---------------------------------------------------------------- formatting */

const n2 = (x) => (x == null || !Number.isFinite(Number(x)) ? '?' : String(Math.round(Number(x) * 100) / 100));
const sha7 = (s) => (s ? String(s).slice(0, 7) : '?');
const yn = (b) => (b ? 'TAIP' : 'NE');

/** Corroborated tally derived from a snapshot's trades. */
export function tally(snap) {
  const t = snap?.trades || [];
  const unknown = t.filter((x) => !x.corroborated_outcome || x.corroborated_outcome === 'UNKNOWN');
  const decided = t.length - unknown.length;
  const has = (o) => (x) => x.corroborated_outcome === o;
  return {
    total: t.length, corroborated: decided, unknown: unknown.length,
    proven: snap?.settled_proven_count ?? 0,
    settled_ours: t.filter(has('SETTLED')).length,
    not_settled: t.filter((x) => x.corroborated_outcome === 'NOT_SETTLED').length
  };
}

const ago = (iso, nowMs) => {
  if (!iso) return 'nėra';
  const m = Math.round((nowMs - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return 'nėra';
  return m < 90 ? `prieš ${m} min` : `prieš ${Math.round(m / 60)} val`;
};

export function evidenceLine(snap) {
  const t = tally(snap);
  return `${t.corroborated}/${t.total} corroborated · ${t.unknown} unknown · ${t.proven} proven`;
}

const modeText = (s) => s?.operator_mode ?? s?.operator_mode_status ?? 'UNKNOWN';

export function fmtStart(snap) {
  if (!snap) return '🟡 FLOP Evidence Scout online\nBūsenos failo dar nėra. /help';
  return [
    '🟢 FLOP Evidence Scout online',
    `Host: ${snap.active_runtime_host ?? '?'}`,
    `🔒 Mode: ${modeText(snap)}`,
    `Writes: ${snap.writes_allowed ? 'ALLOWED' : 'BLOCKED'}`,
    `Evidence: ${evidenceLine(snap)}`,
    `Archive: ${snap.archive?.archive_status ?? '?'}`,
    'Use /help'
  ].join('\n');
}

export function fmtStatus(snap, settings, nowMs) {
  if (!snap) return '🟡 Būsenos failo (runtime.json) dar nėra.';
  const a = snap.archive || {}; const b = snap.corroborated_account || {};
  const sys = snap.writes_allowed || snap.operator_mode !== 'EVIDENCE_ONLY' ? '🔴' : '🟢';
  return [
    `${sys} SISTEMA`,
    `Host: ${snap.active_runtime_host ?? '?'} · SHA ${sha7(snap.runtime_commit)}`,
    `🔒 Mode: ${modeText(snap)} · writes allowed: ${yn(snap.writes_allowed)}`,
    `Last actual write: ${snap.last_actual_write ?? 'nėra'} (iš viso ${snap.writes_actual_total ?? 0})`,
    `Last successful cycle: ${ago(snap.last_successful_cycle, nowMs)}`,
    `Baseline: ${snap.evidence_status ?? '?'}${snap.evidence_baseline_ready ? '' : ' (dar ne)'}`,
    `Attempts: ${snap.trades?.length ?? '?'}/${CAP} · ${evidenceLine(snap)}`,
    `Proven exposure: ${n2(snap.exposure_low)} … ${n2(snap.exposure_high)} (definite ${n2(snap.proven_position)})`,
    `Corroborated position: ${n2(b.net_position)} (NEPANAUDOTA parašams ar rizikai)`,
    `🟡 ARCHYVAS ${a.archive_status ?? '?'}: latest ${a.archive_latest_sweep ?? '?'} / live ${a.live_latest_sweep ?? '?'} / lag ${a.archive_lag_sweeps ?? '?'}`,
    `GitHub: ${snap.github_watch_status ?? '?'}`,
    `Telegram: ${snap.telegram_status ?? '?'}${settings.quiet_mode ? ' · quiet ON' : ''}`,
    `Updater: ${snap.updater_status ?? '?'}`
  ].join('\n');
}

export function fmtClose1(snap, nowMs) {
  if (!snap) return '🟡 Būsenos failo dar nėra.';
  const t = tally(snap); const b = snap.corroborated_account || {};
  return [
    '🔒 CLOSE CALL',
    `Sweep: ${snap.current_sweep ?? '?'} · ref kaina ${snap.reference_price ?? '?'} (amžius ${snap.reference_age_seconds ?? '?'} s)`,
    `Kainos post'o amžius: ${snap.price_post_age_seconds ?? '?'} s`,
    `Mode: ${modeText(snap)} · cap: ${snap.trades?.length ?? '?'}/${CAP} panaudota`,
    `PROVEN: SETTLED_PROVEN ${t.proven}; expozicija ${n2(snap.exposure_low)} … ${n2(snap.exposure_high)} (definite ${n2(snap.proven_position)}); blogiausias free POLF ${n2(snap.free_polf_worst_case)}`,
    `CORROBORATED: settled ${t.settled_ours} · not-settled ${t.not_settled}; tikėtina pozicija ${n2(b.net_position)}`,
    `UNKNOWN: ${t.unknown}`,
    `Leaderboard: ${snap.leaderboard_display_row != null ? `matomi #${snap.leaderboard_display_row}` : 'nematomi'} (${snap.prize_place_status ?? '?'})`
  ].join('\n');
}

const TAG = { PROVEN: 'PROVEN', CORROBORATED: 'CORROBORATED' };
/** Rows for /trades, joined from forensics rows (side/qty/price) and the snapshot. */
export function tradeLines(snap, forensics) {
  const rows = new Map((forensics?.rows || []).map((r) => [r.trade_id, r]));
  return (snap?.trades || []).map((t) => {
    const r = rows.get(t.id) || {};
    const out = t.corroborated_outcome;
    const settledOurs = out === 'SETTLED';
    const proven = t.evidence === 'CRYPTOGRAPHICALLY_PROVEN' || t.evidence === 'PROVEN' || String(t.corroborated_settlement || '').includes('PROVEN');
    const unk = !out || out === 'UNKNOWN';
    const icon = unk ? '❓' : proven ? '✅' : '🟡';
    const tag = unk ? '' : ` [${proven ? TAG.PROVEN : TAG.CORROBORATED}]`;
    const verdict = unk ? 'UNKNOWN' : settledOurs ? 'SETTLED' : 'NOT_SETTLED';
    const side = r.side ? String(r.side).toUpperCase() : '?';
    return `${icon} ${String(t.id).slice(0, 12)}… ${side} ${r.qty ?? '?'} — ${verdict}${tag}`;
  });
}

export function paginate(lines, page, perPage = 10) {
  const pages = Math.max(1, Math.ceil(lines.length / perPage));
  const p = Math.min(Math.max(1, page), pages);
  return { p, pages, slice: lines.slice((p - 1) * perPage, p * perPage) };
}

export function fmtTrades(snap, forensics, page = 1) {
  if (!snap) return '🟡 Būsenos failo dar nėra.';
  const lines = tradeLines(snap, forensics);
  const { p, pages, slice } = paginate(lines, page);
  return [`SANDORIAI (${p}/${pages}) · ${evidenceLine(snap)}`, ...slice, pages > 1 ? `/trades ${p < pages ? p + 1 : 1} — kitas puslapis` : ''].filter(Boolean).join('\n');
}

/** Currently unresolved trades, derived from the snapshot each time (never a fixed list). */
export function fmtUnknown(snap, forensics) {
  if (!snap) return '🟡 Būsenos failo dar nėra.';
  const rows = new Map((forensics?.rows || []).map((r) => [r.trade_id, r]));
  const unk = (snap.trades || []).filter((t) => !t.corroborated_outcome || t.corroborated_outcome === 'UNKNOWN');
  if (!unk.length) return '🟢 Neišspręstų sandorių nėra.';
  const out = [`❓ UNKNOWN: ${unk.length}`];
  for (const t of unk) {
    const r = rows.get(t.id) || {};
    out.push('', `${t.id}`,
      `${String(r.side ?? '?').toUpperCase()} ${r.qty ?? '?'} @ ${r.price ?? '?'} · sweep ${r.posted_sweep ?? t.sweep ?? '?'}`,
      `Signed flow: ${r.referee_flow_visible_outcome ?? t.basis ?? '?'}`,
      `Archyvas: ${r.archive_outcome && r.archive_outcome !== '—' ? r.archive_outcome : 'kopijos nėra'}${r.archive_class ? ` (${r.archive_class})` : ''}`,
      `Kodėl neaišku: ${r.notes || (t.archive_gaps?.hidden_trades ? `${t.archive_gaps.hidden_trades} paslėptų sandorių lange` : 'nei pasirašytas srautas, nei archyvas neįrodo rezultato')}`);
  }
  return out.join('\n');
}

export function fmtArchive(snap, nowMs) {
  const a = snap?.archive;
  if (!a) return '🟡 Archyvo duomenų dar nėra.';
  const p = a.publication;
  const lmAge = lastModifiedAgeMin(a.archive_index_last_modified, nowMs);
  const dur = (m) => (m == null ? '?' : m < 90 ? `${m} min` : `${Math.round(m / 60)} val`);
  const lines = [
    `${p?.state === 'STABLE' ? '🟢' : '🟡'} ARCHYVAS: ${a.archive_status}`,
    `Publication: ${p?.state ?? 'nėra duomenų'}${p?.reason ? ` (${p.reason})` : ''}`,
    `Latest: ${a.archive_latest_sweep ?? '?'} · live: ${a.live_latest_sweep ?? '?'} · lag: ${a.archive_lag_sweeps ?? '?'} sweep (~${a.archive_lag_minutes ?? '?'} min)`,
    `Last-Modified: ${a.archive_index_last_modified ?? '?'} (amžius ${dur(lmAge)})`,
    `Last archive advance: ${p?.last_advance_at ? `${ago(p.last_advance_at, nowMs)} (${p.last_advance_from} → ${p.last_advance_to}, +${p.last_advance_jump})` : 'nematytas'}`,
    `Recovery evidence: ${p ? `${p.independent_advances ?? 0}/${MIN_INDEPENDENT_ADVANCES} nepriklausomų advance'ų po atsigavimo (iš eilės ${p.consecutive_advances ?? 0})` : '?'}`,
    `Cache: ${a.archive_cache_present ?? '?'}/${a.archive_cache_required ?? '?'} · valid: ${yn(a.archive_cache_valid)}`,
    `Hash mismatches: ${(a.mismatch_sweeps || []).length}`,
    `Mūsų trūkstami sweep'ai: ${(a.our_missing_sweeps || []).length}`,
    p?.state === 'STALLED' ? `Archive stalled: nesikeitė ${dur(Math.round((nowMs - Date.parse(a.archive_latest_changed_at)) / 60000))} (tai laukiama būsena, ne pranešimas)` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

export function fmtGithub(snap, nowMs) {
  if (!snap) return '🟡 Būsenos failo dar nėra.';
  const up = snap.upstream || {}; const w = up.watched || {};
  const prio = Object.entries(w).slice(0, 6).map(([k, v]) => `  · ${k}: ${v?.state ?? v?.status ?? '?'}`);
  return [
    `${snap.github_watch_status === 'OK' ? '🟢' : '🟡'} GITHUB: ${snap.github_watch_status ?? '?'}`,
    `Authenticated: ${yn(snap.github_authenticated)}`,
    `Likę užklausų: ${snap.github_remaining ?? '?'} · reset ${snap.github_reset_at ?? '?'}`,
    `Paskutinė sėkmė: ${snap.github_last_success ?? 'nėra'}`,
    `Paskutinis esminis FLOP įvykis: ${up.last_substantive_event ?? snap.upstream?.head ?? 'nėra duomenų'}`,
    prio.length ? 'Stebimi prioritetiniai:' : '', ...prio
  ].filter(Boolean).join('\n');
}

export function fmtHost(snap, nowMs) {
  if (!snap) return '🟡 Būsenos failo dar nėra.';
  return [
    `🟢 ${snap.active_runtime_host ?? 'MINI_PC'}`,
    `Active SHA: ${sha7(snap.runtime_commit)} · origin SHA: ${sha7(snap.remote_head)}`,
    `Updater: ${snap.updater_status ?? '?'} (${ago(snap.updater_checked_at, nowMs)})`,
    `🔒 Mode: ${modeText(snap)} · host writer: ${yn(snap.host_writer)} · writes allowed: ${yn(snap.writes_allowed)}`,
    `Write attempts: ${snap.writes_attempted_total ?? 0} · actual writes: ${snap.writes_actual_total ?? 0} · last actual: ${snap.last_actual_write ?? 'nėra'}`,
    `Baseline ready: ${yn(snap.evidence_baseline_ready)}`,
    `Last cycle: ${ago(snap.last_close1_cycle, nowMs)} · last successful: ${ago(snap.last_successful_cycle, nowMs)}`,
    'HETZNER: standby / writer disabled'
  ].join('\n');
}

/** Last operator-relevant alerts: skips log-only rows and the old partial-cache evidence report. */
export function operatorAlerts(dataDir, limit = 10) {
  let text = '';
  try { text = fs.readFileSync(path.join(dataDir, 'alerts.jsonl'), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let a; try { a = JSON.parse(line); } catch { continue; }
    if (a.logOnly) continue;
    if (a.telegram && String(a.telegram).startsWith('HELD_') && severityOf(a.kind) === 'INFO') continue;
    rows.push(a);
  }
  // Repeated noise: the same kind with the same first line only once.
  const seen = new Set(); const out = [];
  for (const a of rows.reverse()) {
    const key = `${a.kind}|${String(a.text).split('\n')[0]}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}

export function fmtAlerts(dataDir) {
  const list = operatorAlerts(dataDir, 10);
  if (!list.length) return '🟢 Naujų perspėjimų nėra.';
  return ['PERSPĖJIMAI (naujausi pirmi)', ...list.map((a) => `${SEVERITY_LABEL[severityOf(a.kind)]} ${String(a.at).slice(5, 16).replace('T', ' ')} ${a.kind}: ${String(a.text).split('\n')[0].slice(0, 140)}`)].join('\n');
}

export function fmtSettings(s) {
  return ['⚙️ STEBĖJIMO NUSTATYMAI', `alert_level: ${s.alert_level}`, `quiet_mode: ${s.quiet_mode ? 'on' : 'off'}`,
    `github_interval_minutes: ${s.github_interval_minutes}`, `archive_resume_threshold_sweeps: ${s.archive_resume_threshold_sweeps}`,
    'Keisti: /set alert_level critical|normal|all · /set quiet_mode on|off · /set github_interval 15-360 · /set archive_threshold 10-500'].join('\n');
}

export function fmtMode(snap) {
  return ['🔒 REŽIMAS', `Mode: ${modeText(snap)}`, `Writes allowed: ${snap?.writes_allowed ? 'YES' : 'NO'}`, 'Trading activation: local MINI_PC operator action only'].join('\n');
}

export function fmtForensics(f) {
  if (!f) return '🟡 Forensics ataskaitos nėra.';
  const d = f.decision || {}; const t = d.tally || {}; const ex = d.exposure || {}; const a = f.archive || {};
  const c = f.accounts?.conflicts || [];
  return [
    'FORENSICS (tik skaitymas)',
    `Tally: ${JSON.stringify(t)}`,
    `Exposure: ${n2(ex.low ?? f.accounts?.A_proven?.low)} … ${n2(ex.high ?? f.accounts?.A_proven?.high)}`,
    `Archive: ${a.archive_status ?? '?'} · latest ${a.archive_latest_sweep ?? '?'} · cache valid ${yn(a.archive_cache_valid)}`,
    `Conflicts: ${c.length ? c.map((x) => JSON.stringify(x)).join('; ').slice(0, 300) : 'nėra'}`,
    `Recommended: ${d.recommended_next_mode ?? '?'} (tik informacija; keičia tik žmogus)`
  ].join('\n');
}

export const HELP = [
  'KOMANDOS (visos tik skaitymui)',
  '/start · /status · /close1 · /trades [N] · /unknown', '/archive · /github · /host · /alerts · /forensics', '/settings · /set · /mode · /help',
  'Šis botas negali keisti režimo, prekiauti ar pasirašyti.'
].join('\n');

/** Split a long message at line breaks so no single message is giant. */
export function chunk(text, max = MAX_MESSAGE) {
  if (text.length <= max) return [text];
  const out = []; let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ commands */

const FORBIDDEN = new Set(['active', 'trade', 'shell', 'exec', 'sh', 'cmd', 'run', 'sign', 'post', 'offer', 'accept', 'probe', 'buy', 'sell', 'cap', 'reset', 'delete', 'export', 'key', 'keys', 'did', 'register', 'enable', 'disable', 'evidence_only', 'unlock', 'lock', 'git', 'update', 'restart', 'stop']);

/** Strip the @botname suffix and split. */
export function parseCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return null;
  const parts = t.split(/\s+/);
  const cmd = parts[0].slice(1).replace(/@.*$/, '').toLowerCase();
  return { cmd, args: parts.slice(1) };
}

const isAuthorized = (msg, env) => Boolean(env.TELEGRAM_CHAT_ID)
  && msg?.chat?.type === 'private' && String(msg.chat.id) === String(env.TELEGRAM_CHAT_ID);

/**
 * Handle one Telegram update. Returns { replies: string[], job? } and never throws.
 * `ctx`: { dataDir, env, now: () => Date, runForensics?: async () => report|null, busy: { forensics: bool } }
 * Reads the runtime files fresh on every command.
 */
export async function handleUpdate(update, ctx) {
  const msg = update?.message;
  if (!msg || typeof msg.text !== 'string') return { replies: [] };
  const chatId = msg.chat?.id;
  if (!isAuthorized(msg, ctx.env)) {
    // Private strangers get one word; groups and channels get nothing. Nothing about the system either way.
    return msg.chat?.type === 'private' && parseCommand(msg.text) ? { replies: [UNAUTHORIZED], to: chatId } : { replies: [] };
  }
  const c = parseCommand(msg.text);
  if (!c) return { replies: [], to: chatId };
  const now = ctx.now ? ctx.now() : new Date();
  const dataDir = ctx.dataDir;
  const snap = readJson(path.join(dataDir, 'runtime.json'));
  const forensics = readJson(path.join(dataDir, 'forensics.json'));
  const settings = loadSettings(dataDir);
  const reply = (...r) => ({ replies: r.flatMap((x) => chunk(x)), to: chatId });
  try {
    switch (c.cmd) {
      case 'start': return reply(fmtStart(snap));
      case 'help': return reply(HELP);
      case 'status': return reply(fmtStatus(snap, settings, now.getTime()));
      case 'close1': return reply(fmtClose1(snap, now.getTime()));
      case 'trades': return reply(fmtTrades(snap, forensics, Number.parseInt(c.args[0], 10) || 1));
      case 'unknown': return reply(fmtUnknown(snap, forensics));
      case 'archive': return reply(fmtArchive(snap, now.getTime()));
      case 'github': return reply(fmtGithub(snap, now.getTime()));
      case 'host': return reply(fmtHost(snap, now.getTime()));
      case 'alerts': return reply(fmtAlerts(dataDir));
      case 'settings': return reply(fmtSettings(settings));
      case 'mode': return reply(fmtMode(snap)); // parameters are ignored on purpose
      case 'set': {
        const p = parseSet(c.args);
        if (p.error) return reply(p.error);
        const { before } = applySet(dataDir, p.key, p.value, now);
        return reply(`Changed:\n${p.key}: ${before} → ${p.value}\nBy: authorized Telegram operator\nAt: ${now.toISOString()}`);
      }
      case 'forensics': {
        if (ctx.busy?.forensics) return reply('Forensics jau vykdoma; palaukite.');
        if (ctx.busy) ctx.busy.forensics = true;
        const first = 'Forensics refresh started.';
        const job = (async () => {
          try {
            const rep = ctx.runForensics ? await ctx.runForensics() : null;
            const fresh = rep || readJson(path.join(dataDir, 'forensics.json'));
            const s2 = readJson(path.join(dataDir, 'runtime.json'));
            return [fmtForensics(fresh), s2 ? `Evidence (snapshot): ${evidenceLine(s2)}` : ''].filter(Boolean);
          } catch (err) { return [`🔴 Forensics nepavyko: ${String(err.message).slice(0, 160)}`]; }
          finally { if (ctx.busy) ctx.busy.forensics = false; }
        })();
        return { replies: [first], to: chatId, job };
      }
      default:
        if (FORBIDDEN.has(c.cmd)) return reply(BLOCKED);
        return reply('Nežinoma komanda. /help');
    }
  } catch (err) {
    return reply(`🔴 Klaida: ${String(err.message).slice(0, 120)}`);
  }
}

/* ------------------------------------------------------------------- polling */

export function readOffset(dataDir) { return readJson(path.join(tgDir(dataDir), STATE_FILE), {})?.offset ?? 0; }
export function writeOffset(dataDir, offset) {
  const dir = tgDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, STATE_FILE);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify({ offset, saved_at: new Date().toISOString() }));
  fs.renameSync(`${f}.tmp`, f);
}

/** Never let the token into a message. */
export const scrub = (text, env) => (env.TELEGRAM_BOT_TOKEN ? String(text).split(env.TELEGRAM_BOT_TOKEN).join('[token]') : String(text));

async function api(env, method, body, fetchFn, signal) {
  const r = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
  return r.json();
}

/**
 * One poll turn: fetch updates after the saved offset, PERSIST the new offset
 * BEFORE running any command (so a crash never repeats a command), then answer.
 * Returns the number of updates handled. Throws only for the caller's backoff.
 */
export async function pollOnce(ctx, { fetchFn = fetch, timeoutSec = 25 } = {}) {
  const offset = readOffset(ctx.dataDir);
  const res = await api(ctx.env, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, fetchFn);
  const updates = Array.isArray(res?.result) ? res.result : [];
  if (!updates.length) return 0;
  const next = Math.max(...updates.map((u) => u.update_id)) + 1;
  writeOffset(ctx.dataDir, next);
  for (const u of updates) {
    if (u.update_id < offset) continue; // duplicate delivery
    const out = await handleUpdate(u, ctx);
    const send = async (t) => { try { await api(ctx.env, 'sendMessage', { chat_id: out.to, text: t }, fetchFn); } catch { /* a failed reply never stops the loop */ } };
    for (const t of out.replies || []) await send(t);
    if (out.job) out.job.then(async (more) => { for (const t of more.flatMap((x) => chunk(x))) await send(t); });
  }
  return updates.length;
}
