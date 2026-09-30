/**
 * FLOP upstream watch (operator, 2026-09-30): the archive-publication topic is one topic (#15 + #25),
 * official and community are told apart by who wrote it, an UNKNOWN is only ever resolved by stronger
 * evidence, feed health alerts once per transition, and none of it can touch the operator lock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WATCHED, REPO, upstreamAlerts, communityNotes, isMaintainer, makeGitHub } from '../src/close1/upstream.mjs';
import { groupOf, dedupeGroupedAlerts, observeHeads, headAlerts, observeMentions, mentionAlerts, OFFICIAL, COMMUNITY } from '../src/close1/flop-watch.mjs';
import { alertsBetween, evidenceAlerts, unknownEvidenceDiff } from '../src/close1/runtime.mjs';
import { publicationHealth, PUBLICATION as P } from '../src/close1/publication.mjs';
import { classifyRecord, RECORD } from '../src/close1/archive.mjs';
import { selectForTelegram, severityOf, DEFAULT_SETTINGS, handleUpdate } from '../src/close1/telegram-bot.mjs';
import { decide, MODE } from '../tools/close1-forensics.mjs';
import { readOperatorLock, readWrites } from '../src/close1/operator-lock.mjs';

const K15 = `${REPO}#15`; const K25 = `${REPO}#25`;
const MIN = 60_000; const HOUR = 60 * MIN;
const T0 = Date.parse('2026-09-30T08:00:00Z');
const PIN = { packageSha256: null };

const watched = (key, n, newSince, over = {}) => ({ repo: REPO, n, priority: 'HIGH', topic: 'archive', state: 'open', comments: 3, newSince, ...over });
const obsWith = (entries, extra = {}) => ({ watched: entries, issues: {}, committers: ['sv'], ...extra });

test('F1. #25 is a HIGH priority watch and shares the archive-publication topic with #15', () => {
  const w25 = WATCHED.find((w) => w.repo === REPO && w.n === 25);
  assert.equal(w25?.priority, 'HIGH');
  assert.ok(WATCHED.some((w) => w.repo === REPO && w.n === 15 && w.priority === 'HIGH'), '#15 stays');
  assert.equal(groupOf(K15), 'CLOSE1_ARCHIVE_PUBLICATION');
  assert.equal(groupOf(K25), 'CLOSE1_ARCHIVE_PUBLICATION');
  assert.equal(groupOf(`${REPO}#17`), null);
  for (const n of [6, 8, 9, 10, 12, 17]) assert.ok(WATCHED.some((w) => w.repo === REPO && w.n === n), `#${n}`);
  for (const n of [32, 71]) assert.ok(WATCHED.some((w) => w.repo === 'flop-labs/yellowpaper' && w.n === n), `yp #${n}`);
  for (const n of [1796, 1907]) assert.ok(WATCHED.some((w) => w.repo === 'flop-labs/flop-core' && w.n === n), `core #${n}`);
});

test('F2. the same maintainer statement in #15 and #25 is ONE alert, this run and the next', () => {
  const text = 'We are republishing the sweep archive in hourly batches and will backfill 1120 onwards before the lock.';
  const c = (id) => ({ id, author: 'sv', association: 'NONE', at: 'x', text });
  const prev = obsWith({ [K15]: watched(K15, 15, [], { comments: 2 }), [K25]: watched(K25, 25, [], { comments: 0 }) });
  const next = obsWith({ [K15]: watched(K15, 15, [c(11)]), [K25]: watched(K25, 25, [c(12)], { comments: 1 }) });
  const raw = upstreamAlerts(prev, next, PIN);
  assert.equal(raw.length, 2, 'the pure comparison sees two comments');
  const { notes, digests } = dedupeGroupedAlerts(raw, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'maintainer_reply');
  assert.match(notes[0].text, /^\[OFICIALU\] /);
  assert.match(notes[0].text, /mentions: backfill, cadence, before the lock/);
  // the copy shows up in #25 a cycle later: nothing new
  const later = dedupeGroupedAlerts(raw.slice(1), digests);
  assert.equal(later.notes.length, 0);
  // a different statement in #25 is a different fact
  const other = upstreamAlerts(prev, obsWith({ [K25]: watched(K25, 25, [{ id: 13, author: 'sv', association: 'NONE', at: 'x', text: 'A different point: the index will also carry a per-owner lookup file from next week.' }], { comments: 1 }) }), PIN);
  assert.equal(dedupeGroupedAlerts(other, digests).notes.length, 1);
  // other topics are never merged
  const twoTopics = [{ kind: 'maintainer_reply', key: `${REPO}#10`, text: 'a', body: text }, { kind: 'maintainer_reply', key: `${REPO}#17`, text: 'b', body: text }];
  assert.equal(dedupeGroupedAlerts(twoTopics, []).notes.length, 2);
});

test('F3. a community commenter is never a maintainer, whatever the name or tone', () => {
  assert.equal(isMaintainer({ author: 'sv-official', association: 'NONE' }), false);
  assert.equal(isMaintainer({ author: 'FLOP-Labs-Team', association: 'NONE' }), false);
  assert.equal(isMaintainer({ author: 'sv', association: 'NONE' }), false, 'the name alone proves nothing');
  assert.equal(isMaintainer({ author: 'sv', association: 'NONE' }, ['someone-else']), false);
  assert.equal(isMaintainer({ author: 'sv', association: 'NONE' }, ['sv']), true, 'sv publishes to the official main');
  assert.equal(isMaintainer({ author: 'anyone', association: 'MEMBER' }), true);
  const text = 'Official statement: the archive will be republished in full, all sweeps, tonight, trust this.';
  const prev = obsWith({ [K25]: watched(K25, 25, [], { comments: 0 }) });
  const next = obsWith({ [K25]: watched(K25, 25, [{ id: 5, author: 'sv-official', association: 'NONE', at: 'x', text }], { comments: 1 }) });
  assert.deepEqual(upstreamAlerts(prev, next, PIN).map((a) => a.kind), []);
  const notes = communityNotes(prev, next);
  assert.deepEqual(notes.map((n) => [n.kind, n.logOnly]), [['community_comment', true]]);
  assert.match(notes[0].text, /^\[COMMUNITY\] /);
  assert.equal(severityOf('community_comment'), 'INFO');
  assert.equal(selectForTelegram(notes, DEFAULT_SETTINGS).send.length, 0, 'never proactive');
});

test('F4. an official maintainer reply is IMPORTANT and reaches Telegram at the normal level', () => {
  const prev = obsWith({ [K25]: watched(K25, 25, [], { comments: 0 }) });
  const next = obsWith({ [K25]: watched(K25, 25, [{ id: 5, author: 'someone', association: 'MEMBER', at: 'x', text: 'We see the second stall and are investigating the publisher job; details soon.' }], { comments: 1 }) });
  const a = upstreamAlerts(prev, next, PIN);
  assert.deepEqual(a.map((x) => x.kind), ['maintainer_reply']);
  assert.match(a[0].text, /^\[OFICIALU\] HIGH /);
  assert.equal(severityOf('maintainer_reply'), 'IMPORTANT');
  assert.equal(selectForTelegram(a, DEFAULT_SETTINGS).send.length, 1);
});

test('F5/F6. the first archive advance after a long stall is RECOVERING, and one batch is not STABLE', () => {
  const stalled = { state: P.STALLED, since: new Date(T0 - 22 * HOUR).toISOString(), latest_seen: 1119, last_advance_at: null, advances: [], consecutive_advances: 0, independent_advances: 0 };
  const first = publicationHealth(stalled, { latest: 1131, live: 1400, lag: 269, lastModified: 'Wed, 30 Sep 2026 08:00:00 GMT', changedAt: new Date(T0 - 22 * HOUR).toISOString(), nowMs: T0 });
  assert.equal(first.state, P.RECOVERING);
  assert.notEqual(first.state, P.STABLE);
  assert.equal(first.independent_advances, 0);
  const huge = publicationHealth(stalled, { latest: 1400, live: 1401, lag: 1, lastModified: 'Wed, 30 Sep 2026 08:00:00 GMT', nowMs: T0 });
  assert.equal(huge.state, P.RECOVERING, 'even a full catch-up in one batch');
  assert.equal(decide({ rows: [], ledger: { exposure: {} }, comparison: { conflicts: [] }, attempts: 20, archive: { archive_status: 'CURRENT', archive_lag_sweeps: 1, pending_sweeps: 0, publication: huge } }).recommended_next_mode, MODE.EVIDENCE_ONLY);
});

const trade = (over = {}) => ({ id: 'mfk-0ab343ea2e', status: 'UNKNOWN', evidence: 'UNKNOWN_OMITTED', ownership: 'UNPROVEN', basis: 'FLOW_OMITTED', corroborated_outcome: 'UNKNOWN', corroborated_settlement: 'UNKNOWN', corroboration: null,
  archive_observations: [], archive_gaps: { redacted: 3, missing: 0, unverified: 0, hidden_trades: 115 }, ...over });
const snapOf = (t) => ({ trades: [t], owner_confidence: 'OFFICIALLY_CORROBORATED' });

test('F7. an UNKNOWN stays UNKNOWN without stronger evidence; a change in its evidence is reported exactly', () => {
  assert.deepEqual(evidenceAlerts(snapOf(trade()), snapOf(trade())), []);
  const more = trade({ archive_gaps: { redacted: 3, missing: 0, unverified: 0, hidden_trades: 40 } });
  const a = evidenceAlerts(snapOf(trade()), snapOf(more));
  assert.deepEqual(a.map((x) => x.kind), ['unknown_evidence_changed']);
  assert.match(a[0].text, /still UNKNOWN/);
  assert.match(a[0].text, /hidden trades in its window: 115 → 40/);
  const copy = trade({ archive_observations: [{ sweep: 253, outcome: 'settled' }] });
  assert.match(unknownEvidenceDiff(trade(), copy).join(';'), /exact-copy observations in the archive: 0 → 1/);
  // resolution is a different alert and needs the corroborated outcome to leave UNKNOWN
  const resolved = evidenceAlerts(snapOf(trade()), snapOf(trade({ corroborated_outcome: 'NOT_SETTLED', corroborated_settlement: 'OFFICIALLY_CORROBORATED', corroboration: { kind: 'NOT_SETTLED' } })));
  assert.ok(resolved.some((x) => x.kind === 'unknown_resolved'));
  assert.equal(severityOf('unknown_evidence_changed'), 'IMPORTANT');
});

test('F8. redacted evidence is never copy-level proof', () => {
  const file = 'a'.repeat(64); const redactedSha = 'b'.repeat(64);
  const entry = { n: 253, file, status: 'redacted', sha256: redactedSha };
  const c = classifyRecord({ entry, bytes: Buffer.from('x'), signedFile: file });
  assert.notEqual(c.cls, RECORD.FULL);
  // bytes that hash to neither the signed file nor the index sha256 are UNVERIFIED, never FULL
  assert.equal(c.cls, RECORD.UNVERIFIED);
  assert.notEqual(RECORD.REDACTED, RECORD.FULL);
  // and an UNKNOWN that gains only redacted records is still not a proof
  const more = trade({ archive_gaps: { redacted: 9, missing: 0, unverified: 0, hidden_trades: 300 } });
  assert.equal(more.corroborated_outcome, 'UNKNOWN');
  assert.equal(more.evidence, 'UNKNOWN_OMITTED');
});

const gateSnap = (reasons, ok = false, kind = 'halt') => ({ contest_verified: true, gate: { ok, kind, reasons }, trades: [] });

test('F9. referee feed health alerts once per transition: HEALTHY → STALE → HEALTHY', () => {
  const healthy = gateSnap(['attempt_cap_reached'], false, 'hold');
  const stale = gateSnap(['price_post_stale', 'attempt_cap_reached']);
  const kinds = (a, b) => alertsBetween(a, b).map((x) => x.kind);
  assert.ok(kinds(healthy, stale).includes('referee_stale'));
  assert.deepEqual(kinds(stale, stale).filter((k) => k.startsWith('referee')), [], 'staying stale is silent');
  assert.deepEqual(kinds(stale, healthy).filter((k) => k.startsWith('referee')), ['referee_recovered']);
  assert.deepEqual(kinds(healthy, healthy).filter((k) => k.startsWith('referee')), []);
  assert.equal(severityOf('referee_recovered'), 'IMPORTANT');
});

test('F10. no duplicate risk_gate_halt while the attempt cap already blocks trading', () => {
  const held = gateSnap(['attempt_cap_reached'], false, 'hold');
  const staleWithCap = gateSnap(['price_post_stale', 'attempt_cap_reached']);
  assert.ok(!alertsBetween(held, staleWithCap).some((a) => a.kind === 'risk_gate_halt'));
  // without the cap it is still news
  const open = gateSnap([], true, 'ok');
  assert.ok(alertsBetween(open, gateSnap(['price_post_stale'])).some((a) => a.kind === 'risk_gate_halt'));
});

test('F11. the STALLED reason states the elapsed time, latest, live, lag and Last-Modified age', () => {
  const lm = 'Tue, 29 Sep 2026 09:45:59 GMT';
  const changedAt = '2026-09-29T10:04:02.076Z';
  let pub = { state: P.STALLED, since: '2026-09-29T13:44:02.239Z', latest_seen: 1119, last_advance_at: null, advances: [], consecutive_advances: 0, independent_advances: 0, reason: 'first observation: no history, so nothing is proven yet' };
  const at = (iso, live) => publicationHealth(pub, { latest: 1119, live, lag: live - 1119, lastModified: lm, changedAt, nowMs: Date.parse(iso) });
  const a = at('2026-09-30T07:14:00Z', 1380);
  assert.equal(a.state, P.STALLED);
  assert.match(a.reason, /^no archive advance for 21h 10m \(latest 1119, live 1380, lag 261, Last-Modified age 21h 28m\)$/);
  pub = a;
  const b = at('2026-09-30T08:14:00Z', 1392);
  assert.match(b.reason, /no archive advance for 22h 10m .*live 1392, lag 273, Last-Modified age 22h 28m/);
  assert.equal(b.state, P.STALLED, 'the state rules are unchanged');
  assert.ok(!/first observation/.test(b.reason));
});

test('F12-F14. none of it changes the operator lock or the write counters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'close1-fw-'));
  const dir = path.join(root, 'close1'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'operator-mode.json'), JSON.stringify({ mode: 'EVIDENCE_ONLY' }));
  fs.writeFileSync(path.join(dir, 'host-role.json'), JSON.stringify({ host: 'MINI_PC', writer: true }));
  const before = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const stableArchive = { archive_status: 'CURRENT', archive_lag_sweeps: 2, pending_sweeps: 0, publication: { state: P.STABLE, reason: 'x' } };
  assert.equal(decide({ rows: [], ledger: { exposure: {} }, comparison: { conflicts: [] }, attempts: 20, archive: stableArchive }).recommended_next_mode, MODE.SAFE_RESUME_CANDIDATE);
  dedupeGroupedAlerts([{ kind: 'maintainer_reply', key: K15, text: 't', body: 'b' }], []);
  const mine = await handleUpdate({ update_id: 1, message: { chat: { id: 5, type: 'private' }, text: '/mode ACTIVE' } }, { dataDir: dir, env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '5' } });
  assert.match(mine.replies.join(''), /Writes allowed: NO/);
  assert.match(mine.replies.join(''), /local MINI_PC operator action only/);
  const lock = readOperatorLock(dir);
  assert.equal(lock.mode, 'EVIDENCE_ONLY');
  assert.equal(lock.writes_allowed, false);
  assert.equal(readWrites(dir).attempts, 0);
  assert.equal(readWrites(dir).actual, 0);
  assert.deepEqual(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]), before);
});

/* ------------------------------------------------- merged changes and mentions */

const resp = (body, status = 200, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });
const commit = (sha, title, login = 'dev') => ({ sha: sha.padEnd(40, '0'), commit: { message: title, author: { date: '2026-09-30T07:00:00Z', name: login } }, author: { login } });
const gh = (fetchFn, nowMs = T0) => makeGitHub({ fetchFn, env: {}, nowMs });

test('F15. merged changes: any yellowpaper merge, other repos only when they touch signing, rooms or settlement', async () => {
  const lists = {
    'flop-labs/yellowpaper': [commit('yp1', 'docs(yellowpaper): sync 0.5.1 (draft)')],
    'flop-labs/technocore-chat': [commit('tc1', 'fix(rooms): keep the counters')],
    'flop-labs/flop-core': [commit('fc1', 'chore: bump deps')],
    'flop-labs/tclk': [commit('tk1', 'tclk: release 0.4.0')]
  };
  const fetchFn = async (url) => {
    const repo = Object.keys(lists).find((r) => url.includes(`/repos/${r}/commits`));
    return repo ? resp(lists[repo]) : resp({}, 404);
  };
  const first = await observeHeads({ prev: null, gh: gh(fetchFn), nowMs: T0 });
  assert.deepEqual(headAlerts({}, first), [], 'the first look is a baseline');
  lists['flop-labs/yellowpaper'] = [commit('yp2', 'docs(yellowpaper): D-77 normative wording for E.40'), ...lists['flop-labs/yellowpaper']];
  lists['flop-labs/technocore-chat'] = [commit('tc2', 'fix(store): rename a local helper'), commit('tc3', 'fix(signing): domain separation for room posts'), ...lists['flop-labs/technocore-chat']];
  lists['flop-labs/flop-core'] = [commit('fc2', 'refactor: tidy logging'), ...lists['flop-labs/flop-core']];
  const second = await observeHeads({ prev: first, gh: gh(fetchFn), nowMs: T0 + 30 * MIN });
  const a = headAlerts(first, second);
  assert.deepEqual(a.map((x) => x.kind).sort(), ['protocol_change_merged', 'yellowpaper_change']);
  assert.ok(a.every((x) => x.text.startsWith(OFFICIAL)));
  assert.ok(a.find((x) => x.kind === 'protocol_change_merged').text.includes('domain separation'));
  assert.ok(!a.some((x) => /tidy logging|local helper/.test(x.text)), 'routine merges are not news');
  assert.equal(severityOf('yellowpaper_change'), 'IMPORTANT');
  assert.equal(severityOf('protocol_change_merged'), 'IMPORTANT');
  // an unreachable repo never breaks the watch
  const broken = await observeHeads({ prev: second, gh: gh(async () => { throw new Error('boom'); }), nowMs: T0 + 60 * MIN });
  assert.deepEqual(headAlerts(second, broken), []);
});

test('F16. @Mariukasfak: a maintainer reply is [OFICIALU], a community mention is [COMMUNITY] and never proactive', async () => {
  let items = [{ number: 25, title: 'Sweep archive has stalled a second time', state: 'open', comments: 1, updated_at: '2026-09-30T06:00:00Z', user: { login: 'keitaj' }, url: 'https://api.github.com/repos/flop-labs/technocore-close-call-challenge/issues/25' },
    { number: 61, title: 'our issue', state: 'open', comments: 0, updated_at: '2026-09-30T06:00:00Z', user: { login: 'Mariukasfak' }, url: 'https://api.github.com/repos/flop-labs/tclk/issues/61' }];
  let comments = [{ id: 100, user: { login: 'keitaj' }, author_association: 'NONE', body: 'old' }];
  const fetchFn = async (url) => {
    if (url.includes('/search/issues')) return resp({ items });
    if (url.includes('/issues/25/comments')) return resp(comments);
    return resp([], 404);
  };
  const isMaint = (c) => isMaintainer(c, ['sv']);
  const base = await observeMentions({ prev: null, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 });
  assert.deepEqual(mentionAlerts({}, base), [], 'baseline: old comments are never news');
  items = [{ ...items[0], comments: 4, updated_at: '2026-09-30T08:10:00Z' }, { ...items[1], state: 'closed', updated_at: '2026-09-30T08:05:00Z' }];
  comments = [...comments,
    { id: 101, user: { login: 'randomperson' }, author_association: 'NONE', body: '@Mariukasfak did your revalidation match the index? I get a different hash for sweep 813.' },
    { id: 102, user: { login: 'sv' }, author_association: 'NONE', body: 'We will republish the index in batches; the cadence is hourly from tonight, and we will backfill.' },
    { id: 103, user: { login: 'Mariukasfak' }, author_association: 'NONE', body: '@keitaj thanks, our own reply is not news to us.' }];
  const next = await observeMentions({ prev: base, gh: gh(fetchFn, T0 + 30 * MIN), isMaintainer: isMaint, nowMs: T0 + 30 * MIN });
  const a = mentionAlerts(base, next);
  assert.deepEqual(a.map((x) => x.kind).sort(), ['mention_community', 'mention_official', 'our_thread_state']);
  assert.match(a.find((x) => x.kind === 'mention_official').text, /^\[OFICIALU\] .*sv wrote/);
  assert.match(a.find((x) => x.kind === 'mention_community').text, /^\[COMMUNITY\] .*randomperson mentioned @Mariukasfak/);
  assert.match(a.find((x) => x.kind === 'our_thread_state').text, /tclk#61 .*closed/);
  assert.equal(severityOf('mention_official'), 'IMPORTANT');
  assert.equal(severityOf('mention_community'), 'INFO');
  const sent = selectForTelegram(a, DEFAULT_SETTINGS).send.map((x) => x.kind);
  assert.ok(sent.includes('mention_official') && !sent.includes('mention_community'));
  void COMMUNITY;
});

test('F17. the first look never reports old comments, and a thread over the per-run budget is read next run, not skipped', async () => {
  const mk = (n, comments) => ({ number: n, title: `t${n}`, state: 'open', comments, updated_at: `2026-09-30T0${n}:00:00Z`, user: { login: 'other' }, url: `https://api.github.com/repos/flop-labs/tclk/issues/${n}` });
  let items = [1, 2, 3, 4, 5].map((n) => mk(n, 2));
  const bodies = new Map([1, 2, 3, 4, 5].map((n) => [n, [{ id: n * 10, user: { login: 'x' }, author_association: 'NONE', body: '@Mariukasfak OLD mention' }, { id: n * 10 + 1, user: { login: 'x' }, author_association: 'NONE', body: '@Mariukasfak OLD mention 2' }]]));
  const fetchFn = async (url) => {
    if (url.includes('/search/issues')) return resp({ items });
    const m = url.match(/issues\/(\d+)\/comments\?per_page=(\d+)&page=(\d+)/);
    if (m) { const all = bodies.get(Number(m[1])); return resp(m[2] === '1' ? [all[all.length - 1]] : all); }
    return resp([], 404);
  };
  const isMaint = (c) => isMaintainer(c, []);
  const base = await observeMentions({ prev: null, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 });
  assert.ok(Object.values(base.threads).every((t) => t.last_comment_id > 0), 'every thread has its newest comment id');
  const again = await observeMentions({ prev: base, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 + MIN });
  assert.deepEqual(mentionAlerts(base, again), [], 'nothing old is reported');
  // every thread gets one new comment with a mention
  items = items.map((i) => ({ ...i, comments: 3, updated_at: '2026-09-30T09:00:00Z' }));
  for (const n of [1, 2, 3, 4, 5]) bodies.get(n).push({ id: n * 10 + 2, user: { login: 'y' }, author_association: 'NONE', body: `@Mariukasfak NEW mention in ${n}` });
  const r1 = await observeMentions({ prev: again, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 + 2 * MIN });
  assert.equal(mentionAlerts(again, r1).length, 3, 'three threads read this run');
  const r2 = await observeMentions({ prev: r1, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 + 3 * MIN });
  assert.equal(mentionAlerts(r1, r2).length, 2, 'the two left over are read next run');
  const r3 = await observeMentions({ prev: r2, gh: gh(fetchFn), isMaintainer: isMaint, nowMs: T0 + 4 * MIN });
  assert.equal(mentionAlerts(r2, r3).length, 0, 'and nothing repeats');
});
