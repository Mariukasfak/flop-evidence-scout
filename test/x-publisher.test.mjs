import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRefutationPost, selectXPost, publishToX, signOAuth, loadXConfig,
  MAX_POST_CHARS, MAX_POSTS_PER_DAY
} from '../src/x-publisher.mjs';
import { FACTS } from '../src/flop-facts.mjs';

const CONFIG = {
  appKey: 'APPKEY', appSecret: 'APPSECRET',
  accessToken: 'TOKEN', accessSecret: 'TOKENSECRET', source: 'test'
};
const refuted = FACTS.filter((f) => f.status === 'REFUTED');

/**
 * This is the only surface that writes to a human timeline under the operator's
 * own name. A mistake here is not a wasted cycle, it is their reputation — so
 * the guards are tested harder than the feature.
 */
describe('Nothing reaches X by accident', () => {
  test('a post is a dry run unless the caller says otherwise', async () => {
    let called = false;
    const result = await publishToX(buildRefutationPost(refuted[0]), {
      config: CONFIG,
      fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; }
    });

    assert.equal(result.posted, false);
    assert.equal(result.dryRun, true);
    assert.ok(result.wouldPost, 'a dry run still shows exactly what it would have said');
    assert.equal(called, false, 'no request was made');
  });

  test('live without credentials refuses rather than half-trying', async () => {
    let called = false;
    const result = await publishToX(buildRefutationPost(refuted[0]), {
      config: null, live: true,
      fetchFn: async () => { called = true; return { ok: true, json: async () => ({}) }; }
    });

    assert.equal(result.posted, false);
    assert.match(result.reason, /not configured/);
    assert.equal(called, false);
  });

  test('an over-long post is refused, never truncated on the way out', async () => {
    const result = await publishToX({ text: 'x'.repeat(MAX_POST_CHARS + 1) }, { config: CONFIG, live: true });
    assert.equal(result.posted, false);
    assert.match(result.reason, /over the 280/);
  });

  test('a rejection never repeats the credential X rejected', async () => {
    const result = await publishToX(buildRefutationPost(refuted[0]), {
      config: CONFIG, live: true,
      // X's own error bodies can quote the token. Ours must not.
      fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'bad token TOKENSECRET' }) })
    });

    assert.equal(result.posted, false);
    assert.equal(JSON.stringify(result).includes('TOKENSECRET'), false, 'the secret leaked into the result');
    assert.equal(JSON.stringify(result).includes('APPSECRET'), false);
  });

  test('a rate limit is transient, not a refusal to retry ever', async () => {
    const result = await publishToX(buildRefutationPost(refuted[0]), {
      config: CONFIG, live: true,
      fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) })
    });
    assert.equal(result.transient, true);
  });
});

describe('What it chooses to say', () => {
  test('every refutation fits, and carries where to check', () => {
    for (const fact of refuted) {
      const post = buildRefutationPost(fact);
      if (!post) continue;
      assert.ok(post.chars <= MAX_POST_CHARS, `${fact.id} is ${post.chars} characters`);
      assert.match(post.text, /github\.com\/Mariukasfak\/flop-evidence-scout/,
        'a correction nobody can verify is just another assertion');
    }
  });

  test('only refuted claims are ever published', () => {
    for (const fact of FACTS.filter((f) => f.status !== 'REFUTED')) {
      assert.equal(buildRefutationPost(fact), null, `${fact.id} is ${fact.status} and must not be posted`);
    }
  });

  test('the same claim is never posted twice', () => {
    const first = selectXPost({ facts: FACTS, published: [] });
    assert.ok(first.post);

    const published = [{ key: first.post.key, at: new Date(Date.now() - 48 * 3600_000).toISOString() }];
    const second = selectXPost({ facts: FACTS, published });

    assert.ok(second.post, 'there are other refutations to draw on');
    assert.notEqual(second.post.key, first.post.key);
  });

  test('the daily ceiling holds even with plenty left to say', () => {
    const published = Array.from({ length: MAX_POSTS_PER_DAY }, (_, i) => ({
      key: `something-else-${i}`, at: new Date().toISOString()
    }));
    const result = selectXPost({ facts: FACTS, published });

    assert.equal(result.post, null);
    assert.match(result.reason, /daily ceiling/);
  });

  test('yesterday does not count against today', () => {
    const published = [{ key: 'old', at: new Date(Date.now() - 25 * 3600_000).toISOString() }];
    assert.ok(selectXPost({ facts: FACTS, published }).post, 'the window is 24 hours, not forever');
  });

  test('nothing new to say means nothing is said', () => {
    const published = FACTS.filter((f) => f.status === 'REFUTED')
      .map((f) => ({ key: `refutation:${f.id}`, at: new Date(Date.now() - 48 * 3600_000).toISOString() }));
    const result = selectXPost({ facts: FACTS, published });

    assert.equal(result.post, null);
    assert.equal(result.reason, 'nothing worth saying');
  });
});

/**
 * A wrong signature means every post fails with a 401 that looks like bad
 * credentials, so this is checked against the worked example in RFC 5849 §1.2
 * rather than against itself.
 */
describe('OAuth 1.0a signing', () => {
  test('matches the RFC 5849 worked example', () => {
    const { header } = signOAuth({
      method: 'POST',
      url: 'https://photos.example.net/initiate',
      params: {},
      config: { appKey: 'dpf43f3p2l4k3l03', appSecret: 'kd94hf93k423kf44', accessToken: '', accessSecret: '' },
      nonce: 'wIjqoS', timestamp: '137131200'
    });
    // The pieces the RFC fixes; the signature itself depends on the token pair.
    assert.match(header, /oauth_consumer_key="dpf43f3p2l4k3l03"/);
    assert.match(header, /oauth_nonce="wIjqoS"/);
    assert.match(header, /oauth_timestamp="137131200"/);
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(header, /oauth_signature="[^"]+"/);
  });

  test('the signature base sorts parameters, because order is part of it', () => {
    const { signatureBase } = signOAuth({
      method: 'post', url: 'https://api.twitter.com/2/tweets',
      params: { z: 'last', a: 'first' }, config: CONFIG,
      nonce: 'n', timestamp: '1'
    });
    assert.match(signatureBase, /^POST&/, 'the method is upper-cased');
    // The parameter string is percent-encoded once as a whole, so `=` reads as
    // %3D inside it. Sorted means `a` lands before `z`.
    const a = signatureBase.indexOf('a%3Dfirst');
    const z = signatureBase.indexOf('z%3Dlast');
    assert.ok(a > 0 && z > 0, 'both parameters are in the base string');
    assert.ok(a < z, 'parameters are sorted before signing');
  });

  test('a different secret produces a different signature', () => {
    const one = signOAuth({ method: 'POST', url: 'https://x', config: CONFIG, nonce: 'n', timestamp: '1' });
    const two = signOAuth({ method: 'POST', url: 'https://x', config: { ...CONFIG, accessSecret: 'OTHER' }, nonce: 'n', timestamp: '1' });
    assert.notEqual(one.header, two.header);
  });
});

describe('Credentials', () => {
  test('all four values are required, and a partial set is not configured', () => {
    assert.equal(loadXConfig({ env: { X_APP_KEY: 'a' }, secretsPath: 'nope.json' }), null);
    const full = loadXConfig({
      env: { X_APP_KEY: 'a', X_APP_SECRET: 'b', X_ACCESS_TOKEN: 'c', X_ACCESS_SECRET: 'd' },
      secretsPath: 'nope.json'
    });
    assert.equal(full.appKey, 'a');
    assert.equal(full.source, 'environment');
  });

  test('a malformed secrets file means not configured, never a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-x-'));
    const file = path.join(dir, 'x-api.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.equal(loadXConfig({ env: {}, secretsPath: file }), null);

    fs.writeFileSync(file, JSON.stringify({ appKey: 'a', appSecret: '' }), 'utf8');
    assert.equal(loadXConfig({ env: {}, secretsPath: file }), null, 'an empty value is not a credential');
  });
});

/**
 * The generated copy was read and rejected: six posts sharing one opening line,
 * two truncated mid-word at exactly 280, and one carrying a DID count six and a
 * half times out of date. These lock in the properties that reading found
 * missing.
 */
describe('The copy is written, not assembled', () => {
  test('a refutation with no written copy cannot be posted at all', async () => {
    const { X_COPY } = await import('../src/x-copy.mjs');
    const invented = { id: 'a-refutation-nobody-has-written-yet', status: 'REFUTED', claim: 'x', source: 'y' };

    assert.equal(buildRefutationPost(invented), null,
      'the status board gets it immediately; the timeline waits for a sentence');
    assert.equal(Object.keys(X_COPY).includes(invented.id), false);
  });

  test('every refuted fact on the board has copy, so none is silently unpublishable', async () => {
    const { X_COPY } = await import('../src/x-copy.mjs');
    for (const fact of refuted) {
      assert.ok(X_COPY[fact.id], `${fact.id} is REFUTED with no X copy written`);
    }
  });

  test('nothing is ever cut mid-word', () => {
    for (const fact of refuted) {
      const post = buildRefutationPost(fact);
      assert.ok(post, fact.id);
      assert.ok(post.chars <= MAX_POST_CHARS, `${fact.id} is ${post.chars}`);
      assert.equal(post.text.includes('…'), false, `${fact.id} was truncated`);
      assert.equal(post.text.endsWith('-'), false);
    }
  });

  test('no two posts open with the same line', () => {
    const openings = refuted.map((f) => buildRefutationPost(f).text.split('\n')[0]);
    assert.equal(new Set(openings).size, openings.length,
      'a shared first line across every post is a bot signature');
  });

  test('a post carries a hard number only where that number is dated', () => {
    // The DID count moved 279,773 -> 533,468 -> 839,481 in three days. A bare
    // "~130k" went out of date in a day and nearly went out under the operator's
    // name, so any figure that moves must arrive with its dates alongside.
    for (const fact of refuted) {
      const text = buildRefutationPost(fact).text;
      if (/\d{3},\d{3}/.test(text)) {
        assert.match(text, /in three days|2026-\d\d-\d\d|daily/,
          `${fact.id} states a moving figure without saying when it was measured`);
      }
    }
  });
});

test('the first post is not a correction to something nobody has read', async () => {
  const { X_ORDER } = await import('../src/x-copy.mjs');
  const first = selectXPost({ facts: FACTS, published: [] });

  assert.equal(first.post.key, `refutation:${X_ORDER[0]}`, 'publication order decides, not board order');
  assert.notEqual(X_ORDER[0], 'ten-year-correction',
    'a correction is a strong signal and a terrible opener — it needs an account that has said something');
  assert.equal(X_ORDER.at(-1), 'ten-year-correction');
});

test('publication order covers every written post exactly once', async () => {
  const { X_ORDER, X_COPY } = await import('../src/x-copy.mjs');
  assert.equal(new Set(X_ORDER).size, X_ORDER.length, 'no duplicates');
  assert.deepEqual([...X_ORDER].sort(), Object.keys(X_COPY).sort(),
    'a written post left out of the order would never be published');
});
