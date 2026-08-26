import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FACTS, FACTS_ROOM, FACTS_TOPIC, STATUS,
  buildFactsPost, factsByStatus, factsDigest, renderFactsMarkdown
} from '../src/flop-facts.mjs';
import { isValidTechnocoreName } from '../src/identity.mjs';

describe('FLOP status board', () => {
  test('the room name and topic are valid, and the topic does not overclaim', () => {
    assert.equal(isValidTechnocoreName(FACTS_ROOM), true);
    assert.equal(FACTS_ROOM.startsWith('d-'), true);
    assert.equal(FACTS_TOPIC.includes('\n'), false);
    assert.equal(FACTS_TOPIC.length < 8192, true);
    // The name and topic must not imply an official relationship or a promise.
    assert.match(FACTS_TOPIC, /Not affiliated/i);
    assert.equal(/help you|guarantee|earn|claim your/i.test(FACTS_TOPIC), false);
    assert.equal(/airdrop.?help/i.test(FACTS_ROOM), false);
  });

  test('every entry carries a status, a source and a date', () => {
    assert.equal(FACTS.length > 0, true);
    for (const f of FACTS) {
      assert.equal(Object.values(STATUS).includes(f.status), true, `${f.id} has an unknown status`);
      assert.equal(typeof f.source === 'string' && f.source.length > 10, true, `${f.id} needs a real source`);
      assert.match(f.asOf, /^\d{4}-\d{2}-\d{2}$/, `${f.id} needs a date`);
      assert.equal(f.claim.includes('\n'), false);
    }
    const ids = FACTS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  });

  test('what is unknown is published, not omitted', () => {
    const unknown = factsByStatus(STATUS.UNKNOWN);
    assert.equal(unknown.length >= 3, true, 'the unknowns are the point');

    // This used to assert that "chain" was among the unknowns. The Teaser
    // answered it — FLOP runs on its own account-based PoUI chain — so that
    // entry moved to CONFIRMED and the assertion started failing on a correct
    // change. Pinning a topic word pins the state of someone else's roadmap.
    //
    // What should stay true regardless is the shape: the scoring formula is the
    // one thing a reader most needs and the one thing still unpublished, and no
    // UNKNOWN may be a bare shrug without a source explaining what was checked.
    const text = unknown.map((f) => f.claim).join(' ').toLowerCase();
    assert.match(text, /snapshot|scoring|formula/);
    for (const f of unknown) {
      assert.ok(f.source.length > 20, `${f.id} must say what was checked, not just assert ignorance`);
    }
  });

  test('a post fits the message cap and survives the single-line sweep', () => {
    for (const status of Object.values(STATUS)) {
      const post = buildFactsPost(status);
      if (!post) continue;
      assert.equal(post.line.includes('\n'), false);
      assert.equal(post.line.length <= 4096, true, `${status} post exceeds the message cap`);
      assert.match(post.line, /Not affiliated with Flop Labs/);
    }
  });

  test('an unchanged board produces an unchanged key, so it never republishes', () => {
    const a = buildFactsPost(STATUS.CONFIRMED);
    const b = buildFactsPost(STATUS.CONFIRMED);
    assert.equal(a.key, b.key);

    const edited = FACTS.map((f) => (f.id === 'no-token' ? { ...f, asOf: '2026-09-01' } : f));
    assert.notEqual(factsDigest(edited), factsDigest());
  });

  test('the rendered board leads with the disclaimer, not the news', () => {
    const md = renderFactsMarkdown();
    const beforeFirstFact = md.slice(0, md.indexOf('### '));
    assert.match(beforeFirstFact, /Not affiliated with Flop Labs/);
    assert.match(beforeFirstFact, /nothing here is airdrop advice/i);
    // Unknown must appear before Refuted, and all four sections must render.
    for (const heading of ['Confirmed', 'Reported', 'Unknown', 'Refuted']) {
      assert.match(md, new RegExp(`### ${heading}`));
    }
    assert.equal(md.indexOf('### Unknown') < md.indexOf('### Refuted'), true);
  });

  test('nothing but the refuted list ever mentions a guarantee', () => {
    // The refuted entry says "registering a DID guarantees an allocation"
    // precisely in order to deny it, so it is the one place the word belongs.
    const nonRefuted = FACTS.filter((f) => f.status !== STATUS.REFUTED);
    const text = JSON.stringify(nonRefuted).toLowerCase();
    assert.equal(/guarantee/.test(text), false, 'only the refuted list may use that word');

    const refuted = factsByStatus(STATUS.REFUTED).map((f) => f.claim.toLowerCase()).join(' ');
    assert.match(refuted, /guarantees an allocation/);
  });
});
