import test from 'node:test';
import assert from 'node:assert/strict';

import { claimPlan, agentClaimMessage, wrapBytes, isSignatureRefusal, claimedToday } from '../chain/faucet-lib.mjs';

const TESTNET = '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800';

test('claimPlan: testnet limits with agent.claimPath use the signed agent claim', () => {
  const p = claimPlan({ faucet: { status: 'open', anonymous: { grantFlop: 25 }, agent: { grantFlop: 10, claimPath: '/v1/testnet/agent-claims' } } });
  assert.deepEqual(p, { mode: 'agent-claim', path: '/v1/testnet/agent-claims', ready: true, status: 'open', grant: 10 });
});

test('claimPlan: low_balance is not ready; devnet limits without claimPath fall back to /fund', () => {
  assert.equal(claimPlan({ faucet: { status: 'low_balance', agent: { claimPath: '/x' } } }).ready, false);
  const d = claimPlan({ faucet: { anonymous: { grantFlop: 25 } } });
  assert.deepEqual([d.mode, d.path, d.ready, d.grant], ['fund', '/fund', true, 25]);
  assert.equal(claimPlan(null).mode, 'fund');
});

test('agentClaimMessage: v1 format with the nonce as a string', () => {
  assert.equal(agentClaimMessage(TESTNET, '5Abc', 1795590859489), `flop-faucet-agent/v1|${TESTNET}|5Abc|1795590859489`);
  assert.equal(wrapBytes('m'), '<Bytes>m</Bytes>');
});

test('isSignatureRefusal: only a 401 bad-signature refusal allows the next signing form', () => {
  assert.equal(isSignatureRefusal(401, { reason: 'claim_signature_invalid' }), true);
  assert.equal(isSignatureRefusal(401, { error: 'Sign the D10 versioned claim with the recipient key' }), true);
  assert.equal(isSignatureRefusal(429, { reason: 'ip_cooldown' }), false);
  assert.equal(isSignatureRefusal(200, {}), false);
});

test('claimedToday: accepted or unknown today blocks a second claim; refusals and other days do not', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const base = { agent: 'scout', genesis: TESTNET };
  assert.equal(claimedToday([{ ...base, at: '2026-11-25T07:00:00Z', outcome: 'unknown' }], { ...base, now }), true);
  assert.equal(claimedToday([{ ...base, at: '2026-11-25T07:00:00Z', outcome: 'refused' }], { ...base, now }), false);
  assert.equal(claimedToday([{ ...base, at: '2026-11-24T23:00:00Z', outcome: 'accepted' }], { ...base, now }), false);
  assert.equal(claimedToday([{ ...base, agent: 'scribe', at: '2026-11-25T07:00:00Z', outcome: 'accepted' }], { ...base, now }), false);
});
