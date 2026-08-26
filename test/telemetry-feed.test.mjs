import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FEED_ROOM, FEED_TOPIC, FALLBACK_ROOM } from '../src/telemetry-feed.mjs';
import {
  selectPost, POST_GAPS_MS, nextFactsPost,
  buildProtocolPost, buildAdvisoryPost, buildRoomsPost, buildCapacityPost, buildTelemetryPost
} from '../src/publications.mjs';
import { STATUS } from '../src/flop-facts.mjs';

/** The board is always available until every section has been published. */
const factsExhausted = () => {
  const out = [];
  let post;
  while ((post = nextFactsPost(out))) out.push({ ...post, at: '2026-08-20T00:00Z' });
  return out;
};
import { isValidTechnocoreName } from '../src/identity.mjs';

const CAPS = { rooms: 10240, notes: 327680 };
const reading = (at, dids, rooms, notes, lobby) => ({
  at, sharded_did_estimate: dids, legacy_did_count: 40960,
  rooms_used: rooms, notes_used: notes, lobby_msgs_per_min: lobby
});
const OBS = [
  reading('2026-08-26T04:00Z', 80000, 8000, 170000, 900),
  reading('2026-08-26T06:00Z', 86000, 8100, 176000, 1200)
];

describe('Publication room', () => {
  test('the room name, its fallback and its topic are valid for the network', () => {
    assert.equal(isValidTechnocoreName(FEED_ROOM), true);
    assert.equal(FEED_ROOM.startsWith('d-'), true, 'only d- rooms can be owned');
    assert.equal(isValidTechnocoreName(FALLBACK_ROOM), true);
    assert.equal(FEED_TOPIC.length < 8192, true);
    assert.equal(FEED_TOPIC.includes('\n'), false);
  });
});

describe('Post builders', () => {
  test('every post survives the single-line sweep and names its source', () => {
    const posts = [
      buildProtocolPost({ detectedAt: '2026-08-26T06:00Z', changes: [{ id: 'openapi', addedPaths: ['/faucet'] }] }),
      buildAdvisoryPost([{ room: 'flop-testnet-faucet' }]),
      buildRoomsPost({ corpus: { messages: 300 }, roomsBySignal: { a: { messages: 30, signalScore: 0.5, boilerplateShare: 0 }, b: { messages: 30, signalScore: 0.2, boilerplateShare: 0.3 } } }),
      buildCapacityPost(OBS, CAPS),
      buildTelemetryPost(OBS, CAPS)
    ];
    for (const p of posts) {
      assert.notEqual(p, null);
      assert.equal(p.line.includes('\n'), false);
      assert.match(p.line, /flop-evidence-scout/);
      assert.equal(p.line.length < 4096, true, 'must fit the message cap');
    }
  });

  test('a new route is reported by name, not as a hash change', () => {
    const p = buildProtocolPost({
      detectedAt: '2026-08-26T06:00Z',
      changes: [{ id: 'openapi', was: '24 paths', now: '25 paths', addedPaths: ['/faucet/{did}'] }]
    });
    assert.match(p.line, /NEW ROUTE in openapi\.json: \/faucet\/\{did\}/);
  });

  test('an advisory leads with the caveat, because the risk is acting on the headline', () => {
    const p = buildAdvisoryPost([{ room: 'flop-testnet-faucet' }]);
    const beforeName = p.line.slice(0, p.line.indexOf('flop-testnet-faucet'));
    assert.match(beforeName, /UNVERIFIED/);
    assert.match(p.line, /Do not connect a wallet/);
    assert.match(p.line, /no claim or token endpoint/);
  });

  test('capacity says the listed room count is a floor', () => {
    const p = buildCapacityPost(OBS, CAPS);
    assert.match(p.line, /excludes private p- rooms/);
    assert.match(p.line, /floor/);
  });

  test('builders return null rather than an empty post', () => {
    assert.equal(buildProtocolPost(null), null);
    assert.equal(buildProtocolPost({ changes: [], signalAlerts: [] }), null);
    assert.equal(buildAdvisoryPost([]), null);
    assert.equal(buildRoomsPost({ roomsBySignal: {} }), null);
    assert.equal(buildTelemetryPost([], CAPS), null);
    // Below 70% of either cap there is nothing to warn about.
    assert.equal(buildCapacityPost([reading('2026-08-26T06:00Z', 8000, 100, 1000, 50), reading('2026-08-26T07:00Z', 8100, 110, 1100, 50)], CAPS), null);
  });
});

describe('Choosing what to publish', () => {
  const base = { observations: OBS, caps: CAPS, published: [] };

  test('a protocol change outranks everything else waiting', () => {
    const { post } = selectPost({
      ...base,
      sourceChange: { detectedAt: '2026-08-26T06:00Z', changes: [{ id: 'openapi', addedPaths: ['/faucet'] }] },
      faucetHits: [{ room: 'flop-testnet-faucet' }]
    });
    assert.equal(post.type, 'protocol');
  });

  test('an advisory outranks capacity and telemetry', () => {
    const { post } = selectPost({ ...base, faucetHits: [{ room: 'flop-testnet-faucet' }] });
    assert.equal(post.type, 'advisory');
  });

  test('identical content is never republished, however long it has been', () => {
    const first = selectPost({ ...base, faucetHits: [{ room: 'flop-testnet-faucet' }] }).post;
    const published = [{ ...first, at: '2020-01-01T00:00Z' }];   // ancient

    const again = selectPost({
      ...base, faucetHits: [{ room: 'flop-testnet-faucet' }], published,
      now: Date.parse('2026-08-26T06:00Z')
    });
    assert.notEqual(again.post?.type, 'advisory', 'the same advisory must not repeat');
  });

  test('new content of the same type still waits out its gap', () => {
    // Well under either cap, so `capacity` has nothing to say and telemetry is
    // the only candidate left — otherwise a never-published type wins on its
    // own merits, which it should.
    const quiet = [
      reading('2026-08-26T04:00Z', 80000, 900, 20000, 900),
      reading('2026-08-26T06:00Z', 86000, 910, 21000, 1200)
    ];
    const published = [...factsExhausted(), { type: 'telemetry', key: 'telemetry:old', at: '2026-08-26T05:00Z' }];

    const soon = selectPost({ observations: quiet, caps: CAPS, published, now: Date.parse('2026-08-26T06:00Z') });
    assert.equal(soon.post, null, 'one hour is inside the four-hour telemetry gap');

    const later = selectPost({ observations: quiet, caps: CAPS, published, now: Date.parse('2026-08-26T10:00Z') });
    assert.equal(later.post?.type, 'telemetry');
  });

  test('a type that has never been published wins on its own merits', () => {
    // The inverse of the case above, stated deliberately: a first capacity
    // warning should not be held back just because telemetry went out recently.
    const published = [{ type: 'telemetry', key: 'telemetry:old', at: '2026-08-26T05:59Z' }];
    const { post } = selectPost({ ...base, published, now: Date.parse('2026-08-26T06:00Z') });
    assert.equal(post?.type, 'capacity');
  });

  test('urgent types have a shorter gap than routine ones', () => {
    assert.equal(POST_GAPS_MS.protocol < POST_GAPS_MS.telemetry, true);
    assert.equal(POST_GAPS_MS.advisory < POST_GAPS_MS.rooms, true);
  });

  test('nothing to say means nothing published', () => {
    const { post, reason } = selectPost({ observations: [], caps: CAPS, published: factsExhausted() });
    assert.equal(post, null);
    assert.match(reason, /nothing new/);
  });

  test('the status board cycles its sections, then goes quiet', () => {
    const published = [];
    const seen = [];
    let post;
    while ((post = nextFactsPost(published))) {
      seen.push(post.status);
      published.push({ ...post, at: '2026-08-20T00:00Z' });
    }

    // Unknown goes first: what nobody has published is what a reader most needs.
    assert.equal(seen[0], STATUS.UNKNOWN);
    assert.equal(new Set(seen).size, seen.length, 'each section published once');
    // And an unchanged board stops rather than repeating itself forever.
    assert.equal(nextFactsPost(published), null);
  });
});
