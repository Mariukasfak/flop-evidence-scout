import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { TechnocoreClient } from '../src/technocore-client.mjs';
import { generateIdentity } from '../src/identity.mjs';

/**
 * The server orders signed writes per key and room and rejects anything out of
 * turn. Measured 2026-09-02, twice in fourteen hours:
 *
 *   400 nonce 1788382448501 is not greater than 1788382448580
 *
 * Seventy-nine milliseconds apart — two posts signed in one order, sent in the
 * other. Both losses were kibble claims: jobs we had won and then dropped.
 */
describe('signed writes keep their order', () => {
  /**
   * A venue that answers slowly and remembers what arrived, so a test can make
   * the first request the slow one and see whether the second overtakes it.
   */
  function slowVenue({ delaysMs = [] } = {}) {
    const arrived = [];
    let call = 0;
    const release = [];
    const fetchFn = async (url) => {
      const nonce = Number(String(url).split('/say-signed/')[1].split('/')[2]);
      const index = call;
      call += 1;
      const wait = delaysMs[index] ?? 0;
      if (wait === 'hold') {
        await new Promise((resolve) => { release.push(resolve); });
      } else if (wait) {
        await new Promise((resolve) => { setTimeout(resolve, wait); });
      }
      arrived.push(nonce);
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    return { arrived, fetchFn, release };
  }

  const clientFor = (fetchFn) => new TechnocoreClient({ baseUrl: 'https://test.example', fetchFn });

  test('a slow first write is not overtaken by the second to the same room', async () => {
    const { arrived, fetchFn } = slowVenue({ delaysMs: [40, 0] });
    const client = clientFor(fetchFn);
    const me = generateIdentity();

    await Promise.all([
      client.postMessage('lobby', 'pirmas', me),
      client.postMessage('lobby', 'antras', me)
    ]);

    assert.equal(arrived.length, 2);
    assert.ok(arrived[0] < arrived[1], `nonces must arrive increasing, got ${arrived.join(' then ')}`);
  });

  test('nonces are strictly increasing even when signed inside one millisecond', async () => {
    const { arrived, fetchFn } = slowVenue();
    const client = clientFor(fetchFn);
    const me = generateIdentity();

    for (let i = 0; i < 5; i += 1) await client.postMessage('lobby', `zinute ${i}`, me);

    for (let i = 1; i < arrived.length; i += 1) {
      assert.ok(arrived[i] > arrived[i - 1], `${arrived[i]} must exceed ${arrived[i - 1]}`);
    }
  });

  test('a failed write does not block the next one to the same room', async () => {
    let first = true;
    const arrived = [];
    const client = clientFor(async (url) => {
      if (first) { first = false; throw new Error('tinklas nukrito'); }
      arrived.push(Number(String(url).split('/say-signed/')[1].split('/')[2]));
      return { ok: true, status: 200, text: async () => 'ok' };
    });
    const me = generateIdentity();

    await assert.rejects(client.postMessage('lobby', 'krenta', me), /tinklas nukrito/);
    await client.postMessage('lobby', 'praeina', me);

    assert.equal(arrived.length, 1, 'the second write still went out');
  });

  test('the caller still sees a failure rather than a swallowed one', async () => {
    const client = clientFor(async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'nonce is not greater' }));
    await assert.rejects(client.postMessage('lobby', 'x', generateIdentity()), /HTTP 400/);
  });

  test('different rooms are not made to wait for each other', async () => {
    const { arrived, fetchFn, release } = slowVenue({ delaysMs: ['hold'] });
    const client = clientFor(fetchFn);
    const me = generateIdentity();

    const held = client.postMessage('lobby', 'laukia', me);
    await client.postMessage('kibble', 'nelaukia', me);

    assert.equal(arrived.length, 1, 'the second room got through while the first was still hanging');
    release.forEach((resolve) => resolve());
    await held;
  });

  test('two keys writing to one room do not share a queue', async () => {
    const { arrived, fetchFn, release } = slowVenue({ delaysMs: ['hold'] });
    const client = clientFor(fetchFn);

    const held = client.postMessage('lobby', 'scout', generateIdentity());
    await client.postMessage('lobby', 'scribe', generateIdentity());

    assert.equal(arrived.length, 1, 'the server counts nonces per key, so the queue is per key too');
    release.forEach((resolve) => resolve());
    await held;
  });
});
