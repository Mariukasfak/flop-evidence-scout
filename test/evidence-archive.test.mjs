import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TechnocoreClient } from '../src/technocore-client.mjs';
import { generateIdentity } from '../src/identity.mjs';
import { summarize } from '../tools/verify-evidence.mjs';

function clientWith(fetchFn, evidenceDir) {
  return new TechnocoreClient({ baseUrl: 'https://test.example', fetchFn, evidenceDir });
}

/** The venue answers a say-signed write with the room's text tail, our own line in it. */
const okFetch = async (url) => {
  const [did, , , ...rest] = url.split('/say-signed/')[1].split('/');
  const text = decodeURIComponent(rest.join('/'));
  const who = decodeURIComponent(did).slice(-4);
  return {
    ok: true, status: 200,
    text: async () => '# room technocore  messages 2  range 4241..4242\n\n'
      + '[4241] 2026-09-24T17:59:59Z <z6Mk…zzzz> someone else\n'
      + `[4242] 2026-09-24T18:00:00Z <z6Mk…${who}> ${text}\n`
  };
};

test('an accepted signed write is kept, and re-verifies from the file alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  const me = generateIdentity();
  await clientWith(okFetch, dir).postSignedMessage('technocore', 'hello\nworld', me);

  const [file] = fs.readdirSync(dir);
  const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').trim());
  assert.equal(entry.room, 'technocore');
  assert.equal(entry.did, me.did);
  assert.equal(entry.seq, 4242);
  assert.equal(entry.ts, '2026-09-24T18:00:00Z');
  assert.equal(entry.response.includes('someone else'), false, 'other people\'s lines are not kept');
  assert.ok(!entry.text.includes('\n'), 'the swept text, which is what was signed');
  assert.equal(JSON.stringify(entry).includes('PRIVATE'), false, 'no key material');

  const s = summarize(dir);
  assert.equal(s.verified, 1);
  assert.equal(s.failed, 0);
});

test('a refused write is not evidence, and a tampered line fails verification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  const me = generateIdentity();
  const refused = async () => ({ ok: false, status: 400, statusText: 'Bad', text: async () => 'nope' });
  await assert.rejects(clientWith(refused, dir).postSignedMessage('technocore', 'x', me));
  assert.equal(fs.readdirSync(dir).length, 0);

  await clientWith(okFetch, dir).postSignedMessage('technocore', 'original', me);
  const [file] = fs.readdirSync(dir);
  const p = path.join(dir, file);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('original', 'forged'));
  assert.equal(summarize(dir).failed, 1);
});

test('no evidence directory means nothing is written and the post still succeeds', async () => {
  const me = generateIdentity();
  const res = await clientWith(okFetch, null).postSignedMessage('technocore', 'x', me);
  assert.equal(res.ok, true);
});
