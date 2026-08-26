import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, shouldPublish, FEED_ROOM, FEED_TOPIC } from '../src/telemetry-feed.mjs';
import { isValidTechnocoreName } from '../src/identity.mjs';

const CAPS = { rooms: 10240, notes: 327680 };
const reading = (at, dids, rooms, notes, lobby) => ({
  at, sharded_did_estimate: dids, legacy_did_count: 40960,
  rooms_used: rooms, notes_used: notes, lobby_msgs_per_min: lobby
});

describe('Telemetry feed', () => {
  test('the room name and its topic are valid for the network', () => {
    assert.equal(isValidTechnocoreName(FEED_ROOM), true);
    assert.equal(FEED_ROOM.startsWith('d-'), true, 'only d- rooms can be owned');
    // Notes are capped at 8192 and swept to one line.
    assert.equal(FEED_TOPIC.length < 8192, true);
    assert.equal(FEED_TOPIC.includes('\n'), false);
  });

  test('a digest states the movement, not just the level', () => {
    const obs = [reading('2026-08-26T04:00Z', 80000, 8000, 170000, 900),
                 reading('2026-08-26T06:00Z', 86000, 8100, 176000, 1200)];
    const d = buildDigest(obs, { caps: CAPS });

    assert.match(d.line, /telemetry 2026-08-26T06:00Z/);
    assert.match(d.line, /DIDs ~127k/);           // sharded + legacy
    assert.match(d.line, /rooms 8100\/10240/);
    assert.match(d.line, /lobby 1200\/min/);
    assert.match(d.movement, /\+3000 sharded DIDs\/h/);  // 6000 over 2 hours
    assert.equal(d.line.includes('\n'), false, 'must survive the single-line sweep');
  });

  test('the first reading publishes; an unchanged one does not', () => {
    const obs = [reading('2026-08-26T06:00Z', 86000, 8100, 176000, 1200)];
    assert.equal(shouldPublish(obs, null).publish, true);

    const published = { at: '2026-08-26T06:00Z', reading: obs[0] };
    const verdict = shouldPublish(obs, published, Date.parse('2026-08-26T06:30Z'));
    assert.equal(verdict.publish, false, 'nothing moved and it is too soon');
    assert.match(verdict.reason, /nothing moved/);
  });

  test('a material move publishes, a trivial one waits', () => {
    const before = reading('2026-08-26T06:00Z', 86000, 8100, 176000, 1200);
    const published = { at: '2026-08-26T06:00Z', reading: before };

    // +5% on DIDs, an hour later.
    const moved = [before, reading('2026-08-26T07:00Z', 90300, 8100, 176000, 1200)];
    const yes = shouldPublish(moved, published, Date.parse('2026-08-26T07:00Z'));
    assert.equal(yes.publish, true);
    assert.match(yes.reason, /sharded_did_estimate/);

    // +0.5%, same hour: not news.
    const flat = [before, reading('2026-08-26T07:00Z', 86400, 8100, 176000, 1200)];
    assert.equal(shouldPublish(flat, published, Date.parse('2026-08-26T07:00Z')).publish, false);
  });

  test('silence eventually breaks on its own, so a dead agent is visible', () => {
    const before = reading('2026-08-26T06:00Z', 86000, 8100, 176000, 1200);
    const published = { at: '2026-08-26T06:00Z', reading: before };
    const flat = [before, reading('2026-08-26T11:00Z', 86050, 8100, 176000, 1200)];

    const verdict = shouldPublish(flat, published, Date.parse('2026-08-26T11:00Z'));
    assert.equal(verdict.publish, true);
    assert.equal(verdict.reason, 'periodic reading');
  });

  test('no readings means no publication rather than an empty one', () => {
    assert.equal(shouldPublish([], null).publish, false);
    assert.equal(buildDigest([], { caps: CAPS }), null);
  });
});
