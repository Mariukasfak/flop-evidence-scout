/**
 * The denominator, tested.
 *
 * This exists because a count was published upstream without one — twelve 503s
 * in a day, against an unknown number of requests — and a maintainer pointed
 * out that twelve out of nothing is not a rate. The meter is only worth having
 * if it counts EVERY request, including the ones that fail, so those are the
 * cases pinned here rather than the happy path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TechnocoreClient } from '../src/technocore-client.mjs';

/** A fetch that answers whatever the script says, in order. */
function scriptedFetch(steps) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step instanceof Error) throw step;
    return new Response('body', { status: step });
  };
}

describe('request meter', () => {
  test('counts every request, not just the ones that answered', async () => {
    const client = new TechnocoreClient({
      baseUrl: 'http://example.invalid',
      fetchFn: scriptedFetch([200, 503, 404, new Error('fetch failed')])
    });

    await client.fetch('http://example.invalid/a');
    await client.fetch('http://example.invalid/b');
    await client.fetch('http://example.invalid/c');
    await assert.rejects(() => client.fetch('http://example.invalid/d'));

    const m = client.readMeter();
    assert.equal(m.total, 4, 'the transport failure is still a request that was made');
    assert.equal(m.transportErrors, 1);
    assert.deepEqual(m.byStatus, { 200: 1, 503: 1, 404: 1 });
  });

  test('a refusal rate can be computed from it, and 5xx is separable', async () => {
    const client = new TechnocoreClient({
      baseUrl: 'http://example.invalid',
      fetchFn: scriptedFetch([503, 200, 200, 200])
    });
    for (const p of ['a', 'b', 'c', 'd']) await client.fetch(`http://example.invalid/${p}`);

    const m = client.readMeter();
    const refusals = Object.entries(m.byStatus)
      .filter(([status]) => Number(status) >= 500)
      .reduce((sum, [, n]) => sum + n, 0);

    assert.equal(refusals, 1);
    assert.equal(m.total, 4);
    assert.equal((100 * refusals) / m.total, 25);
  });

  test('the snapshot carries its own window and its own caveat', async () => {
    const client = new TechnocoreClient({
      baseUrl: 'http://example.invalid',
      fetchFn: scriptedFetch([200])
    });
    await client.fetch('http://example.invalid/a');

    const m = client.readMeter();
    // A count without a window is the mistake this file exists to prevent.
    assert.match(m.since, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof m.windowMs, 'number');
    assert.ok(m.windowMs >= 0);
    // And it must never be quotable as a count of origin refusals: the edge can
    // serve a stored copy instead of the 503, so this is a lower bound.
    assert.match(m.note, /[Ll]ower bound/);
  });

  test('the snapshot is a copy, so a reader cannot corrupt the counter', async () => {
    const client = new TechnocoreClient({
      baseUrl: 'http://example.invalid',
      fetchFn: scriptedFetch([200])
    });
    await client.fetch('http://example.invalid/a');

    const snapshot = client.readMeter();
    snapshot.byStatus['200'] = 999;
    assert.equal(client.readMeter().byStatus['200'], 1);
  });
});
