import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { enrollWallet, signEnrollment, wrapBytes } from '../src/flop-gateway.mjs';
import { generateIdentity, decodeDidKeyToRaw, rawPublicKeyToSpki } from '../src/identity.mjs';
import { flopAddressOfDid } from '../src/flop-address.mjs';

test('the enrollment signature is Ed25519 over the <Bytes>-wrapped message, verifiable by the did:key', () => {
  const id = generateIdentity();
  const msg = 'flop.network wants you to sign in\nnonce: 1';
  const sig = signEnrollment(msg, id.privateKeyPem);
  assert.match(sig, /^0x[0-9a-f]{128}$/);
  const pub = crypto.createPublicKey(rawPublicKeyToSpki(decodeDidKeyToRaw(id.did)));
  assert.ok(crypto.verify(null, Buffer.from(wrapBytes(msg)), pub, Buffer.from(sig.slice(2), 'hex')));
});

test('one attempt: a capped day is reported, not retried, and the address is the did:key account', async () => {
  const id = generateIdentity();
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/challenge')) return new Response(JSON.stringify({ message: 'm' }), { status: 200 });
    return new Response(JSON.stringify({ error: 'wallet_enrollment_cap_reached' }), { status: 503 });
  };
  const out = await enrollWallet(id, { fetchFn, gateway: 'https://gw.test' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'wallet_enrollment_cap_reached');
  assert.equal(calls.length, 2, 'one challenge, one POST');
  assert.equal(calls[1].body.address, flopAddressOfDid(id.did));
  assert.ok(calls[0].url.endsWith(`address=${flopAddressOfDid(id.did)}`));
});
