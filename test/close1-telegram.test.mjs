/**
 * The Telegram operator console (operator, 2026-09-29): private chat only, read-only,
 * a whitelist of three monitoring settings, and no route to trading, signing or the lock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUpdate, pollOnce, readOffset, loadSettings, selectForTelegram, parseSet, tgDir, scrub, severityOf, BLOCKED, UNAUTHORIZED, DEFAULT_SETTINGS, operatorAlerts } from '../src/close1/telegram-bot.mjs';
import { deliverAlerts } from '../src/close1/runtime.mjs';
import { readOperatorLock, readWrites } from '../src/close1/operator-lock.mjs';

const TOKEN = '123456:SECRET-TOKEN-VALUE';
const CHAT = 777001;
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: String(CHAT) };

/** A mini-PC-shaped data dir: <root>/close1 holds the runtime files, <root>/telegram is the bot's. */
function world({ unknownIds = ['mfk-aaaa', 'mfk-bbbb'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'close1-tg-'));
  const dir = path.join(root, 'close1');
  fs.mkdirSync(dir, { recursive: true });
  const trades = Array.from({ length: 20 }, (_, i) => {
    const id = i < unknownIds.length ? unknownIds[i] : `mfk-t${i}`;
    const unknown = i < unknownIds.length;
    return { id, status: 'SETTLED_UNPROVEN', evidence: unknown ? 'UNKNOWN' : 'OFFICIAL_REDACTED_CORROBORATION', sweep: 100 + i,
      corroborated_outcome: unknown ? 'UNKNOWN' : (i % 2 ? 'SETTLED' : 'NOT_SETTLED'), corroborated_settlement: unknown ? 'UNKNOWN' : 'OFFICIALLY_CORROBORATED' };
  });
  const snap = {
    generated_at: '2026-09-29T08:00:00.000Z', active_runtime_host: 'MINI_PC', runtime_commit: '58a7297aaaaaaaaaa', operator_mode: 'EVIDENCE_ONLY',
    writes_allowed: false, host_writer: true, writes_actual_total: 0, writes_attempted_total: 0, last_actual_write: null,
    last_successful_cycle: '2026-09-29T07:44:02.000Z', last_close1_cycle: '2026-09-29T07:44:02.000Z', evidence_baseline_ready: true, evidence_status: 'BASELINE_READY',
    settled_proven_count: 0, exposure_low: -4.5, exposure_high: 8.42, proven_position: 0, free_polf_worst_case: 6949.8,
    corroborated_account: { net_position: -1.9 }, github_watch_status: 'OK', telegram_status: 'CONFIGURED', updater_status: 'UP_TO_DATE',
    current_sweep: 1092, reference_price: 225.3, reference_age_seconds: 40, price_post_age_seconds: 12,
    archive: { archive_status: 'LAGGING', archive_latest_sweep: 766, live_latest_sweep: 1100, archive_lag_sweeps: 334, archive_lag_minutes: 334, archive_cache_present: 102, archive_cache_required: 102, archive_cache_valid: true, mismatch_sweeps: [], our_missing_sweeps: [] },
    trades
  };
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(snap));
  fs.writeFileSync(path.join(dir, 'forensics.json'), JSON.stringify({ rows: trades.map((t) => ({ trade_id: t.id, side: 'buy', qty: '0.5', price: '225', posted_sweep: t.sweep, referee_flow_visible_outcome: 'nothing listed', archive_outcome: '—', notes: 'private-room trades redacted' })), decision: { tally: { attempts: 20 }, exposure: {}, recommended_next_mode: 'EVIDENCE_ONLY' }, archive: snap.archive, accounts: { conflicts: [] } }));
  fs.writeFileSync(path.join(dir, 'operator-mode.json'), JSON.stringify({ mode: 'EVIDENCE_ONLY' }));
  fs.writeFileSync(path.join(dir, 'host-role.json'), JSON.stringify({ host: 'MINI_PC', writer: true }));
  return { root, dir };
}
const msg = (text, { id = CHAT, type = 'private', uid = 1 } = {}) => ({ update_id: uid, message: { message_id: uid, chat: { id, type }, text } });
const ctxFor = (dir, extra = {}) => ({ dataDir: dir, env, busy: { forensics: false }, now: () => new Date('2026-09-29T08:10:00Z'), ...extra });
const snapshotFiles = (dir) => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

test('T1. an authorized private chat gets answers', async () => {
  const { dir } = world();
  const r = await handleUpdate(msg('/start'), ctxFor(dir));
  assert.match(r.replies.join('\n'), /FLOP Evidence Scout online/);
  assert.match(r.replies.join('\n'), /Host: MINI_PC/);
  assert.match(r.replies.join('\n'), /Writes: BLOCKED/);
  assert.match(r.replies.join('\n'), /18\/20 corroborated · 2 unknown · 0 proven/);
});

test('T2/T3. another chat, and a group, learn nothing about the system', async () => {
  const { dir } = world();
  const stranger = await handleUpdate(msg('/status', { id: 999 }), ctxFor(dir));
  assert.deepEqual(stranger.replies, [UNAUTHORIZED]);
  const group = await handleUpdate(msg('/status', { id: CHAT, type: 'group' }), ctxFor(dir));
  assert.deepEqual(group.replies, []);
  const chan = await handleUpdate(msg('/status', { id: CHAT, type: 'channel' }), ctxFor(dir));
  assert.deepEqual(chan.replies, []);
  for (const r of [stranger, group, chan]) assert.doesNotMatch(r.replies.join(' '), /MINI_PC|did:|EVIDENCE_ONLY|C:\\/);
});

const fakeTelegram = (batches, sent = []) => {
  const q = [...batches];
  const fn = async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'getUpdates') return { ok: true, json: async () => ({ ok: true, result: q.shift() ?? [] }) };
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return { fn, sent };
};

test('T4/T5. the polling offset survives a restart and a duplicate update runs once', async () => {
  const { dir } = world();
  const tg = fakeTelegram([[{ ...msg('/set quiet_mode on', { uid: 41 }) }], [{ ...msg('/set quiet_mode on', { uid: 41 }) }]]);
  assert.equal(await pollOnce(ctxFor(dir), { fetchFn: tg.fn }), 1);
  assert.equal(readOffset(dir), 42);
  // "restart": fresh ctx, Telegram redelivers the same update id
  const n = await pollOnce(ctxFor(dir), { fetchFn: tg.fn });
  assert.equal(n, 1);
  const audit = fs.readFileSync(path.join(tgDir(dir), 'operator-audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(audit.length, 1, 'the redelivered update was not executed again');
  assert.equal(readOffset(dir), 42);
});

test('T6. /status reads the current snapshot, fresh on every command', async () => {
  const { dir } = world();
  const a = (await handleUpdate(msg('/status'), ctxFor(dir))).replies.join('\n');
  assert.match(a, /SHA 58a7297/);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')); s.runtime_commit = 'abcdef0123'; s.archive.archive_lag_sweeps = 12;
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(s));
  const b = (await handleUpdate(msg('/status'), ctxFor(dir))).replies.join('\n');
  assert.match(b, /SHA abcdef0/); assert.match(b, /lag 12/);
});

test('T7. /unknown derives the unresolved trades from the current data, not from a fixed list', async () => {
  const w1 = world({ unknownIds: ['mfk-first1', 'mfk-second'] });
  const a = (await handleUpdate(msg('/unknown'), ctxFor(w1.dir))).replies.join('\n');
  assert.match(a, /mfk-first1/); assert.match(a, /mfk-second/); assert.match(a, /UNKNOWN: 2/);
  const w2 = world({ unknownIds: ['mfk-other'] });
  const b = (await handleUpdate(msg('/unknown'), ctxFor(w2.dir))).replies.join('\n');
  assert.match(b, /mfk-other/); assert.doesNotMatch(b, /mfk-first1/); assert.match(b, /UNKNOWN: 1/);
  const w3 = world({ unknownIds: [] });
  assert.match((await handleUpdate(msg('/unknown'), ctxFor(w3.dir))).replies.join(''), /nėra/);
});

test('T7b. /trades paginates and labels the evidence class', async () => {
  const { dir } = world();
  const p1 = (await handleUpdate(msg('/trades'), ctxFor(dir))).replies.join('\n');
  const p2 = (await handleUpdate(msg('/trades 2'), ctxFor(dir))).replies.join('\n');
  assert.match(p1, /\(1\/2\)/); assert.match(p2, /\(2\/2\)/);
  assert.match(p1, /❓/); assert.match(p1, /CORROBORATED/);
  assert.ok(p1.length < 3500);
});

test('T8. /forensics is read-only: it announces, runs the injected read-only job once, and refuses a concurrent run', async () => {
  const { dir } = world();
  let runs = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = ctxFor(dir, { runForensics: async () => { runs += 1; await gate; return JSON.parse(fs.readFileSync(path.join(dir, 'forensics.json'), 'utf8')); } });
  const before = snapshotFiles(dir); const lockBefore = readOperatorLock(dir);
  const first = await handleUpdate(msg('/forensics'), ctx);
  assert.deepEqual(first.replies, ['Forensics refresh started.']);
  const second = await handleUpdate(msg('/forensics', { uid: 2 }), ctx);
  assert.match(second.replies.join(''), /jau vykdoma/);
  release();
  const done = (await first.job).join('\n');
  assert.equal(runs, 1);
  assert.match(done, /FORENSICS/); assert.match(done, /18\/20 corroborated/);
  assert.deepEqual(snapshotFiles(dir), before);
  assert.deepEqual(readOperatorLock(dir), lockBefore);
  assert.equal(ctx.busy.forensics, false, 'the lock is released afterwards');
});

test('T9/T10. /mode is read-only and /mode ACTIVE changes nothing', async () => {
  const { dir } = world();
  const before = snapshotFiles(dir);
  const a = (await handleUpdate(msg('/mode'), ctxFor(dir))).replies.join('\n');
  const b = (await handleUpdate(msg('/mode ACTIVE', { uid: 2 }), ctxFor(dir))).replies.join('\n');
  assert.match(a, /Mode: EVIDENCE_ONLY/); assert.match(a, /Writes allowed: NO/); assert.match(a, /local MINI_PC operator action only/);
  assert.equal(a, b);
  assert.deepEqual(snapshotFiles(dir), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'operator-mode.json'), 'utf8')).mode, 'EVIDENCE_ONLY');
});

test('T11. forbidden commands are refused and touch nothing', async () => {
  const { dir, root } = world();
  const before = snapshotFiles(dir);
  for (const c of ['/active', '/trade buy 1', '/shell rm -rf /', '/sign', '/post hi', '/cap 50', '/reset', '/delete all', '/export keys', '/register', '/git pull']) {
    const r = await handleUpdate(msg(c), ctxFor(dir));
    assert.deepEqual(r.replies, [BLOCKED], c);
  }
  assert.deepEqual(snapshotFiles(dir), before);
  assert.equal(fs.existsSync(path.join(root, 'telegram')), false, 'not even a settings or audit file appeared');
});

test('T11b. the console source has no route to the executor, the signer, the lock files or a shell', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(here, '../src/close1/telegram-bot.mjs'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code only, not comments
  const imports = [...src.matchAll(/^import .* from '(.*)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./risk-gate.mjs', 'node:fs', 'node:path']);
  assert.doesNotMatch(src, /child_process|executor|signOffer|operator-lock|operator-mode\.json'|host-role/);
});

test('T12/T13. /set accepts only the whitelist, validates strictly, persists and audits', async () => {
  const { dir } = world();
  const ok = (await handleUpdate(msg('/set github_interval 60'), ctxFor(dir))).replies.join('\n');
  assert.match(ok, /Changed:\ngithub_interval_minutes: 30 → 60\nBy: authorized Telegram operator\nAt: 2026-09-29T08:10:00.000Z/);
  assert.equal(loadSettings(dir).github_interval_minutes, 60);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tgDir(dir), 'settings.json'), 'utf8')).github_interval_minutes, 60);
  const audit = JSON.parse(fs.readFileSync(path.join(tgDir(dir), 'operator-audit.jsonl'), 'utf8').trim());
  assert.deepEqual([audit.setting, audit.from, audit.to], ['github_interval_minutes', 30, 60]);
  for (const bad of ['/set github_interval 14', '/set github_interval 361', '/set github_interval 30.5', '/set github_interval 1e2', '/set archive_threshold 9', '/set archive_threshold 501',
    '/set alert_level loud', '/set quiet_mode maybe', '/set mode ACTIVE', '/set max_attempts 99', '/set operator_mode ACTIVE', '/set', '/set alert_level']) {
    const r = (await handleUpdate(msg(bad), ctxFor(dir))).replies.join('\n');
    assert.doesNotMatch(r, /Changed:/, bad);
  }
  assert.equal(loadSettings(dir).github_interval_minutes, 60, 'rejected values changed nothing');
  assert.deepEqual(parseSet(['quiet_mode', 'on']), { key: 'quiet_mode', value: true });
  assert.deepEqual(parseSet(['archive_threshold', '50']), { key: 'archive_resume_threshold_sweeps', value: 50 });
  assert.equal(fs.readFileSync(path.join(dir, 'operator-mode.json'), 'utf8').includes('EVIDENCE_ONLY'), true);
  // a settings file edited by hand to nonsense falls back to the defaults
  fs.writeFileSync(path.join(tgDir(dir), 'settings.json'), JSON.stringify({ alert_level: 'x', quiet_mode: 'yes', github_interval_minutes: 5, archive_resume_threshold_sweeps: 9999 }));
  assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS);
});

test('T14. quiet mode holds normal alerts but never a critical one', async () => {
  const alerts = [
    { kind: 'archive_our_sweeps', text: 'a' }, { kind: 'stream_gap', text: 'b' }, { kind: 'foreign_writer_detected', text: 'c' },
    { kind: 'operator_mode_changed', text: 'd' }, { kind: 'archive_integrity', text: 'e' }, { kind: 'account_conflict', text: 'f' }, { kind: 'x', text: 'g', logOnly: true }
  ];
  const quiet = selectForTelegram(alerts, { ...DEFAULT_SETTINGS, quiet_mode: true });
  assert.deepEqual(quiet.send.map((a) => a.text), ['c', 'd', 'e', 'f']);
  assert.deepEqual(quiet.held.map((a) => a.text), ['a', 'b']);
  assert.deepEqual(selectForTelegram(alerts, { ...DEFAULT_SETTINGS, alert_level: 'critical' }).send.map((a) => a.text), ['c', 'd', 'e', 'f']);
  assert.deepEqual(selectForTelegram(alerts, DEFAULT_SETTINGS).send.map((a) => a.text), ['a', 'c', 'd', 'e', 'f']);
  assert.deepEqual(selectForTelegram(alerts, { ...DEFAULT_SETTINGS, alert_level: 'all' }).send.map((a) => a.text), ['a', 'b', 'c', 'd', 'e', 'f']);
  // end to end: the log keeps everything, Telegram gets the allowed ones with a severity label
  const { dir } = world(); const sent = [];
  const fetchFn = async (u, init) => { sent.push(JSON.parse(init.body).text); return { ok: true }; };
  await deliverAlerts(alerts, { logFile: path.join(dir, 'alerts.jsonl'), env, fetchFn, settings: { ...DEFAULT_SETTINGS, quiet_mode: true } });
  assert.equal(sent.length, 4); assert.match(sent[0], /^🔴 KRITINIS\nc$/);
  const logged = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(logged.length, 7);
  assert.equal(logged.find((l) => l.text === 'a').telegram, 'HELD_QUIET_MODE');
  assert.equal(severityOf('actual_write'), 'CRITICAL'); assert.equal(severityOf('operator_lock_broken'), 'CRITICAL');
  // commands still work in quiet mode
  await handleUpdate(msg('/set quiet_mode on'), ctxFor(dir));
  assert.match((await handleUpdate(msg('/status', { uid: 3 }), ctxFor(dir))).replies.join(''), /quiet ON/);
});

test('T15. the token never appears in replies, logs or errors', async () => {
  const { dir } = world();
  const all = [];
  for (const c of ['/start', '/status', '/close1', '/trades', '/unknown', '/archive', '/github', '/host', '/alerts', '/settings', '/mode', '/help', '/nope']) {
    all.push(...(await handleUpdate(msg(c), ctxFor(dir))).replies);
  }
  assert.ok(all.every((t) => !t.includes(TOKEN)));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'), /SECRET-TOKEN/);
  assert.equal(scrub(`fetch failed https://api.telegram.org/bot${TOKEN}/getUpdates`, env).includes(TOKEN), false);
  await assert.rejects(() => pollOnce(ctxFor(dir), { fetchFn: async () => { throw new Error(`boom ${TOKEN}`); } }), (e) => e instanceof Error);
});

test('T16. a Telegram outage does not affect the close-1 cycle', async () => {
  const { dir } = world();
  const down = async () => { throw new Error('ENOTFOUND api.telegram.org'); };
  const before = snapshotFiles(dir);
  const r = await deliverAlerts([{ kind: 'foreign_writer_detected', text: 'x' }, { kind: 'archive_our_sweeps', text: 'y' }], { logFile: path.join(dir, 'alerts.jsonl'), env, fetchFn: down, settings: DEFAULT_SETTINGS });
  assert.equal(r.sent, 0); assert.equal(r.logged, 2, 'logged, did not throw');
  assert.deepEqual(Object.fromEntries(Object.entries(snapshotFiles(dir)).filter(([f]) => f !== 'alerts.jsonl')), before);
  await assert.rejects(() => pollOnce(ctxFor(dir), { fetchFn: down }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8')).active_runtime_host, 'MINI_PC');
});

test('T17/T18. after any Telegram command the lock still blocks writes and no write was made', async () => {
  const { dir } = world();
  for (const c of ['/status', '/mode ACTIVE', '/active', '/trade buy 1', '/set quiet_mode off', '/set alert_level all', '/forensics', '/host']) {
    await handleUpdate(msg(c), ctxFor(dir, { runForensics: async () => null }));
  }
  const lock = readOperatorLock(dir);
  assert.equal(lock.mode, 'EVIDENCE_ONLY'); assert.equal(lock.writes_allowed, false);
  assert.equal(readWrites(dir).actual, 0); assert.equal(readWrites(dir).attempts, 0);
  assert.equal(fs.existsSync(path.join(dir, 'writes.json')), false);
});

test('T19. /alerts skips log-only rows, held noise and repeats', async () => {
  const { dir } = world();
  const rows = [
    { at: '2026-09-29T07:04:15Z', kind: 'evidence_report', text: 'old partial cache', logOnly: true },
    { at: '2026-09-29T07:10:00Z', kind: 'archive_our_sweeps', text: 'baseline', logOnly: true, suppressed: 'BASELINE_JUST_ESTABLISHED' },
    { at: '2026-09-29T08:00:00Z', kind: 'github_watch_blind', text: 'blind 1' },
    { at: '2026-09-29T08:20:00Z', kind: 'github_watch_blind', text: 'blind 1' },
    { at: '2026-09-29T08:30:00Z', kind: 'stream_gap', text: 'gap', telegram: 'HELD_ALERT_LEVEL_NORMAL' }
  ];
  fs.writeFileSync(path.join(dir, 'alerts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const list = operatorAlerts(dir);
  assert.deepEqual(list.map((a) => a.kind), ['github_watch_blind']);
  assert.match((await handleUpdate(msg('/alerts'), ctxFor(dir))).replies.join(''), /🟡 SVARBU .*github_watch_blind/);
});

test('T20. no configured chat id means nobody is authorized', async () => {
  const { dir } = world();
  const r = await handleUpdate(msg('/status'), { ...ctxFor(dir), env: { TELEGRAM_BOT_TOKEN: TOKEN } });
  assert.deepEqual(r.replies, [UNAUTHORIZED]);
});

test('T21. /close1 labels PROVEN, CORROBORATED and UNKNOWN separately, with the real outcome names', async () => {
  const { dir } = world();
  const r = (await handleUpdate(msg('/close1'), ctxFor(dir))).replies.join('\n');
  assert.match(r, /PROVEN: SETTLED_PROVEN 0; expozicija -4.5 … 8.42/);
  assert.match(r, /CORROBORATED: settled 9 · not-settled 9/);
  assert.match(r, /UNKNOWN: 2/);
  assert.match(r, /Attempts|cap: 20\/20/);
  assert.match((await handleUpdate(msg('/archive'), ctxFor(dir))).replies.join(''), /Cache: 102\/102 · valid: TAIP/);
});
