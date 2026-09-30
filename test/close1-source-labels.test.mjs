/**
 * Source-confidence labels, #21/#22 watch, third-party sources (operator, 2026-09-30).
 * Narrow: nothing here touches trading, mode, cap or writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL, MAINTAINER, COMMUNITY, COMMUNITY_REPRO, THIRD_PARTY, isReproduction, communityLabel, sourceLabel, isOfficialSource, tagThirdParty, classifyArchiveRecovery } from '../src/close1/flop-watch.mjs';
import { WATCHED, REPO, upstreamAlerts, communityNotes, isMaintainer } from '../src/close1/upstream.mjs';
import { selectForTelegram, severityOf, DEFAULT_SETTINGS } from '../src/close1/telegram-bot.mjs';
import { formatNote } from '../tools/watch-note.mjs';

const PIN = { packageSha256: null };
const K21 = `${REPO}#21`; const K22 = `${REPO}#22`;
const watched = (key, n, newSince) => ({ repo: REPO, n, priority: 'MEDIUM', topic: 't', state: 'open', comments: 1, newSince });
const obs = (entries) => ({ watched: entries, issues: {}, committers: ['sv'] });
const C = (id, author, association, text) => ({ id, author, association, at: 'x', text });

test('S1. the three labels are distinct and the archive recovery is classified part by part', () => {
  assert.equal(new Set([OFFICIAL, MAINTAINER, COMMUNITY_REPRO]).size, 3);
  assert.equal(OFFICIAL, '[OFICIALUS DUOMUO]');
  assert.equal(MAINTAINER, '[MAINTAINERIO PATVIRTINTA]');
  assert.equal(COMMUNITY_REPRO, '[COMMUNITY REPRODUKCIJA]');
  const comments = [
    C(1, 'sunriseblack', 'NONE', 'Confirmed recovery to 1119: I re-fetched every record and all sha256 match the index, outcomes reproduce.'),
    C(2, 'ktrxktr', 'NONE', 'Same here, still stuck this morning, please fix.')
  ];
  const r = classifyArchiveRecovery({ latest: 1119, lastModified: 'Tue, 29 Sep 2026 09:45:59 GMT', comments, isMaintainer: (c) => isMaintainer(c, ['sv']) });
  assert.equal(r.official_data.length, 1);
  assert.match(r.official_data[0], /index\.json → 1119/);
  assert.deepEqual(r.community_reproduction.map((x) => x.split(':')[0]), ['sunriseblack']);
  assert.deepEqual(r.maintainer_confirmation, [], 'no maintainer confirmation');
  assert.match(r.text, /^\[OFICIALUS DUOMUO\] .*\[COMMUNITY REPRODUKCIJA\] sunriseblack; \[MAINTAINERIO PATVIRTINTA\] none$/);
  assert.doesNotMatch(r.text, /OFICIALIAI PATVIRTINTA/);
});

test('S2. a maintainer claim is [MAINTAINERIO PATVIRTINTA]; a community reproduction is [COMMUNITY REPRODUKCIJA], a plain comment [COMMUNITY]', () => {
  const prev = obs({ [K21]: watched(K21, 21, []) });
  const text = 'We will sign index.json with the referee key from the next publication and document it in the README.';
  const m = upstreamAlerts(prev, { ...obs({ [K21]: watched(K21, 21, [C(2, 'x', 'MEMBER', text)]) }) }, PIN);
  assert.match(m[0].text, /^\[MAINTAINERIO PATVIRTINTA\] MEDIUM /);
  const repro = communityNotes(prev, obs({ [K21]: watched(K21, 21, [C(3, 'pepedesigner', 'NONE', 'I replayed all 984 records: 25/25 board keys reproduce, sha256 of served bytes checked.')]) }));
  assert.match(repro[0].text, /^\[COMMUNITY REPRODUKCIJA\] /);
  assert.equal(repro[0].logOnly, true);
  const plain = communityNotes(prev, obs({ [K21]: watched(K21, 21, [C(4, 'someone', 'NONE', 'Thanks for raising this, hoping the team looks at it soon.')]) }));
  assert.match(plain[0].text, /^\[COMMUNITY\] /);
  assert.equal(communityLabel('opinion only, hoping the team looks at it soon'), COMMUNITY);
  assert.ok(isReproduction('re-hashed 102/102'));
});

test('S3. #21 and #22 are MEDIUM watches with community-labelled summaries', () => {
  const w21 = WATCHED.find((w) => w.repo === REPO && w.n === 21);
  const w22 = WATCHED.find((w) => w.repo === REPO && w.n === 22);
  assert.equal(w21?.priority, 'MEDIUM'); assert.equal(w22?.priority, 'MEDIUM');
  assert.match(w21.topic, /unsigned index binding/);
  assert.match(w22.topic, /per-key proofs/);
  assert.match(w21.summary, /^COMMUNITY:.*already exists.*index\.json itself is unsigned/s);
  assert.match(w22.summary, /^COMMUNITY:.*public-room data.*private-room trades and unpublished sweeps/s);
});

test('S4. community comments on #21/#22 stay in the log; a maintainer reply and an integrity contradiction are sent', () => {
  const prev = obs({ [K21]: watched(K21, 21, []), [K22]: watched(K22, 22, []) });
  const quiet = communityNotes(prev, obs({ [K21]: watched(K21, 21, [C(2, 'lastbubble2035', 'NONE', 'the served-bytes digest already exists, it is the sha256 field on each redacted entry, a signed index would close it.')]), [K22]: watched(K22, 22, [C(3, 'pepedesigner', 'NONE', 'Replay of 984 records: zero unexplained mismatches, 25/25 board keys found in the replay.')]) }));
  assert.deepEqual(quiet.map((n) => [n.kind, n.logOnly]), [['community_comment', true], ['community_comment', true]], '"zero mismatches" is a clean check, not a contradiction');
  assert.equal(selectForTelegram(quiet, DEFAULT_SETTINGS).send.length, 0);
  const bad = communityNotes(prev, obs({ [K21]: watched(K21, 21, [C(4, 'p', 'NONE', 'Record 300 does not match the sha256 published in index.json, served bytes differ.')]) }));
  assert.deepEqual(bad.map((n) => [n.kind, n.logOnly]), [['community_integrity_claim', false]]);
  const sv = upstreamAlerts(prev, obs({ [K22]: watched(K22, 22, [C(5, 'sv', 'NONE', 'The state root is a merkle tree over sorted (did, cash, position) leaves; we will document it in close-1-referee.md.')]) }), PIN);
  assert.equal(sv.length, 1);
  assert.equal(severityOf(sv[0].kind), 'IMPORTANT');
  assert.equal(selectForTelegram(sv, DEFAULT_SETTINGS).send.length, 1);
});

test('S5. aggregators are [TREČIOJI ŠALIS], never official; only FLOP Labs sources are official', () => {
  assert.equal(sourceLabel('https://rootdata.com/Projects/detail/FLOP'), THIRD_PARTY);
  assert.equal(sourceLabel('https://coinmarketcap.com/currencies/flop/'), THIRD_PARTY);
  assert.equal(sourceLabel('https://some-news.example/flop-airdrop'), THIRD_PARTY, 'unknown host is conservative');
  assert.equal(sourceLabel('https://github.com/flop-labs/yellowpaper/commit/abc'), OFFICIAL);
  assert.equal(sourceLabel('https://challenges.technocore.chat/close-1/index.json'), OFFICIAL);
  assert.equal(isOfficialSource('https://evil.example/flop-labs/'), false);
  assert.equal(isOfficialSource('https://technocore.chat.evil.example/'), false);
  assert.equal(tagThirdParty('RootData says $FLOP mainnet launch on Oct 10'), `${THIRD_PARTY} RootData says $FLOP mainnet launch on Oct 10`);
  assert.equal(tagThirdParty('Yellowpaper E.48 merged'), 'Yellowpaper E.48 merged');
  const line = formatNote('CoinMarketCap lists $FLOP airdrop date', { now: () => new Date('2026-09-30T10:00:00Z') });
  assert.match(line, /\| \[TREČIOJI ŠALIS\] CoinMarketCap lists/);
});
