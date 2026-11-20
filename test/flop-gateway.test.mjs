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
  assert.ok(calls[0].url.includes(`address=${flopAddressOfDid(id.did)}`));
});

test('a timed-out enrollment is reported as status 0 "timeout" at its stage, never thrown', async () => {
  const id = generateIdentity();
  const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
  const atChallenge = await enrollWallet(id, { fetchFn: async () => timeout(), gateway: 'https://gw.test' });
  assert.deepEqual([atChallenge.ok, atChallenge.stage, atChallenge.status, atChallenge.code], [false, 'challenge', 0, 'timeout']);
  const atPost = await enrollWallet(id, {
    gateway: 'https://gw.test',
    fetchFn: async (url) => (url.includes('/challenge') ? new Response(JSON.stringify({ message: 'm' }), { status: 200 }) : timeout())
  });
  assert.deepEqual([atPost.stage, atPost.status, atPost.code], ['enroll', 0, 'timeout']);
  const down = await enrollWallet(id, { fetchFn: async () => { throw new TypeError('fetch failed'); }, gateway: 'https://gw.test' });
  assert.equal(down.code, 'network_error');
});

test('rehearse retries enrollment at most once per scheduled run, not once per UTC day', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'flop-gateway.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flop-gw-'));
  try {
    fs.mkdirSync(path.join(dir, 'data', 'local'), { recursive: true });
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'data', 'local', 'flop-gateway-log.jsonl'),
      `${JSON.stringify({ at: recent, agent: 'scribe', event: 'enroll_refused', status: 503 })}\n`);
    // A refusal 30 min ago blocks this run without touching the network or the (absent) identity.
    const out = spawnSync(process.execPath, [tool, 'rehearse', '--agent', 'scribe'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /last enrollment attempt .* next after /);
    // A refusal earlier the same day but over 100 min ago no longer blocks: the run goes on to
    // enroll, which here fails fast reading the missing identity file instead of waiting a day.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'data', 'local', 'flop-gateway-log.jsonl'),
      `${JSON.stringify({ at: old, agent: 'scribe', event: 'enroll_refused', status: 503 })}\n`);
    const again = spawnSync(process.execPath, [tool, 'rehearse', '--agent', 'scribe'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
    assert.doesNotMatch(again.stdout, /last enrollment attempt/);
    assert.match(again.stderr + again.stdout, /scribe-identity\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enrollment asks for the hermes-tools-v1 purpose by default, so the allowance lands on a live model', async () => {
  const id = generateIdentity();
  const seen = [];
  const fetchFn = async (url) => { seen.push(url); return new Response(JSON.stringify({ error: 'wallet_enrollment_unavailable' }), { status: 503 }); };
  await enrollWallet(id, { fetchFn, gateway: 'https://gw.test' });
  assert.match(seen[0], /\/v1\/enroll\/wallet\/challenge\?address=5\w+&purpose=hermes-tools-v1$/);
  await enrollWallet(id, { fetchFn, gateway: 'https://gw.test', purpose: '' });
  assert.match(seen[1], /\/challenge\?address=5\w+$/);
});
