import test from 'node:test';
import assert from 'node:assert/strict';

import { fold, SIGNALS } from '../chain/readiness-watch.mjs';

const T0 = '2026-11-27T10:00:00.000Z';
const T1 = '2026-11-27T10:10:00.000Z';

test('fold: the first sight of a signal is a baseline, not a change', () => {
  const { state, changes } = fold({}, { sdk: { value: '0.13.1' } }, T0);
  assert.deepEqual(changes, []);
  assert.equal(state.signals.sdk.value, '0.13.1');
  assert.deepEqual(state.unacked, []);
});

test('fold: a new value is a change and stays unacked until acknowledged', () => {
  const s0 = fold({}, { gatewayEnroll: { value: 'HTTP 404' } }, T0).state;
  const { state, changes } = fold(s0, { gatewayEnroll: { value: 'HTTP 200' } }, T1);
  assert.deepEqual(changes, [{ name: 'gatewayEnroll', from: 'HTTP 404', to: 'HTTP 200' }]);
  assert.equal(state.unacked.length, 1);
  assert.equal(state.signals.gatewayEnroll.since, T1);
});

test('fold: an error keeps the previous value and raises nothing (no false alarm)', () => {
  const s0 = fold({}, { faucetChain: { value: 'pinned testnet' } }, T0).state;
  const { state, changes } = fold(s0, { faucetChain: { error: 'no genesis' } }, T1);
  assert.deepEqual(changes, []);
  assert.equal(state.signals.faucetChain.value, 'pinned testnet');
  assert.equal(state.errors.faucetChain, 'no genesis');
});

test('signals: an error body or overload is not an answer', async () => {
  await assert.rejects(SIGNALS.faucetChain(async () => ({ status: 200, body: { error: 'Faucet RPC did not verify the release genesis' } })), /no genesis/);
  await assert.rejects(SIGNALS.gatewayPay(async () => ({ status: 429, body: '' })), /429/);
  await assert.rejects(SIGNALS.gatewayEnroll(async () => ({ status: 503, body: '' })), /503/);
});

test('signals: real answers are summarized', async () => {
  assert.equal(await SIGNALS.faucetChain(async () => ({ body: { genesisHash: '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800' } })), 'pinned testnet');
  assert.match(await SIGNALS.faucetChain(async () => ({ body: { genesisHash: '0x99' } })), /^OTHER/);
  const pay = await SIGNALS.gatewayPay(async () => ({ status: 402, body: JSON.stringify({ instructions: 'Direct public payment-proof settlement is not enabled. Use a funded FLOP API key.' }) }));
  assert.match(pay, /^HTTP 402 Direct public payment-proof settlement is not enabled/);
  assert.equal(await SIGNALS.tclkFlop(async () => ({ status: 404, body: {} })), 'unpublished');
});

test('rpcSync: in sync within 30 blocks of the indexer, otherwise behind', async () => {
  const fake = (fin, idx, syncing) => async (url, init) => {
    if (url.includes('flopscan')) return { status: 200, body: { finality: { finalizedBlock: idx } } };
    const { method } = JSON.parse(init.body);
    const result = method === 'chain_getFinalizedHead' ? '0xabc'
      : method === 'chain_getHeader' ? { number: `0x${fin.toString(16)}` }
      : { isSyncing: syncing };
    return { status: 200, body: { result } };
  };
  assert.equal(await SIGNALS.rpcSync(fake(240_100, 240_120, false)), 'in sync');
  assert.equal(await SIGNALS.rpcSync(fake(236_699, 240_486, true)), 'behind (syncing)');
  await assert.rejects(SIGNALS.rpcSync(fake(240_100, null, false)), /height unknown/);
});
