import test from 'node:test';
import assert from 'node:assert/strict';

import { turnGnCap, effectiveTurnGn, turnGnFloor } from '../chain/lane-price.mjs';
import { resolveChainInfo } from '../chain/net.mjs';

const FLOP = 10n ** 18n;
const TESTNET = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';
const DEVNET = '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631';

test('turnGnCap: legacy price 1 leaves a 1 FLOP channel room for any configured turn', () => {
  const cap = turnGnCap({ basePerTurn: 1n, pricePerGn: 1n, channel: FLOP });
  assert.equal(cap, FLOP / 4n - 1n);
  const r = effectiveTurnGn({ configured: 1_000_000n, cap, floor: turnGnFloor(16_384n, 427n) });
  assert.deepEqual([r.gn, r.ok], [1_000_000n, true]);
});

test('turnGnCap: a market price caps the turn so the SDK does not refuse every request', () => {
  // 1e12 atoms per G_n: 1 000 000 G_n would be 1 FLOP, the whole channel.
  const cap = turnGnCap({ basePerTurn: 10n ** 15n, pricePerGn: 10n ** 12n, channel: FLOP });
  assert.equal(cap, (FLOP / 4n - 10n ** 15n) / 10n ** 12n);
  const r = effectiveTurnGn({ configured: 1_000_000n, cap, floor: 16_384n });
  assert.equal(r.ok, true);
  assert.equal(r.gn, cap);
  assert.match(r.why, /capped by price/);
});

test('effectiveTurnGn: refuses when the price leaves less than the floor a real turn needs', () => {
  const cap = turnGnCap({ basePerTurn: 0n, pricePerGn: 10n ** 14n, channel: FLOP });
  assert.equal(cap, 2500n);
  const r = effectiveTurnGn({ configured: 1_000_000n, cap, floor: 16_384n });
  assert.equal(r.ok, false);
  assert.match(r.why, /price too high/);
});

test('turnGnCap: unknown price keeps the configured ceiling; base above the share leaves nothing', () => {
  assert.equal(turnGnCap({ basePerTurn: 1n, pricePerGn: null, channel: FLOP }), null);
  assert.deepEqual(effectiveTurnGn({ configured: 5n, cap: null, floor: 1n }).gn, 5n);
  assert.equal(turnGnCap({ basePerTurn: FLOP, pricePerGn: 1n, channel: FLOP }), 0n);
  assert.throws(() => turnGnCap({ basePerTurn: 0n, pricePerGn: 0n, channel: FLOP }), /positive/);
});

test('turnGnFloor: twice the largest served G_n once it passes the minimum', () => {
  assert.equal(turnGnFloor(16_384n, 0n), 16_384n);
  assert.equal(turnGnFloor(16_384n, 9_000n), 18_000n);
});

test('resolveChainInfo: a faucet on another chain than the pin is refused', () => {
  const cfg = { faucet: 'https://faucet.flop.network', rpc: 'wss://testnet.flop.network/', genesis: TESTNET, network: 'testnet' };
  assert.throws(() => resolveChainInfo(cfg, { status: 200, body: { chain: 'FLOP Devnet', genesisHash: DEVNET } }), /not the pinned/);
});

test('resolveChainInfo: no faucet yet falls back to the pin with an rpc, never without one', () => {
  const cfg = { faucet: 'https://faucet.testnet.flop.network', rpc: 'wss://testnet.flop.network/', genesis: TESTNET, network: 'testnet' };
  const info = resolveChainInfo(cfg, { error: 'ENOTFOUND' });
  assert.equal(info.faucetLive, false);
  assert.equal(info.genesisHash, TESTNET);
  assert.equal(info.network, 'testnet');
  assert.throws(() => resolveChainInfo({ ...cfg, genesis: null }, { error: 'ENOTFOUND' }), /failed/);
  assert.throws(() => resolveChainInfo({ ...cfg, rpc: null }, { status: 404 }), /answered 404/);
});

test('resolveChainInfo: a matching faucet answer is used as is', () => {
  const cfg = { faucet: 'https://faucet.flop.network', rpc: null, genesis: DEVNET };
  const info = resolveChainInfo(cfg, { status: 200, body: { chain: 'FLOP Devnet', genesisHash: DEVNET.toUpperCase().replace('0X', '0x') } });
  assert.equal(info.faucetLive, true);
  assert.equal(info.chain, 'FLOP Devnet');
  // Unpinned (the old behaviour): whatever the faucet serves.
  assert.equal(resolveChainInfo({ ...cfg, genesis: null }, { status: 200, body: { genesisHash: TESTNET } }).faucetLive, true);
});
