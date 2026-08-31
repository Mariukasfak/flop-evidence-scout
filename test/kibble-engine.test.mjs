import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { KibbleEngine, didCardUrl } from '../src/kibble-engine.mjs';

const OTHER = 'did:key:z6MknDn3CH7vumHw5rXREhdQaBcDeFgHiJkLmNoPqRsTuVwX';

/** A real-enough answer: long enough, no thin-delivery template, no refusal. */
const GOOD_ANSWER = 'SQLite embeds the database engine directly in the process as a linked '
  + 'library and writes to a single file with no server involved; MySQL runs as a separate '
  + 'server process you connect to over a socket, which adds operational overhead but allows '
  + 'many clients to write concurrently over the network.';

const THIN_ANSWER = "Completed work on 'Test title' successfully. Completed work on it again, "
  + 'successfully, for good measure, so this string clears the eighty-character floor.';

function jobLine(id, { title = 'Test title', body = 'A sufficiently long job body describing exactly what needs to be explained here in detail.' } = {}) {
  return { text: `JOB v1 | ${id} | explain | ${title} | ${body}`, from: OTHER, seq: 1 };
}

function deliverLine(id, text, { from = OTHER, seq = 2 } = {}) {
  return { text: `DELIVER v1 | ${id} | ${text}`, from, seq };
}

/**
 * A client with an in-memory /kv/ store, so state actually round-trips between
 * calls the way it does against the real server — the refusal-memory tests need
 * that to be true, not simulated away.
 */
function makeClient({ roomMessages = [] } = {}) {
  const kv = new Map();
  const posts = [];
  return {
    baseUrl: 'https://test.example',
    posts,
    roomMessages,
    async readRoom(room, { since = null, limit = 50 } = {}) {
      // Long-poll semantics, because the fast lane depends on them: `since`
      // returns only what is newer, and an empty reply is normal rather than an
      // error. A stub that ignored `since` would let a test pass while the real
      // lane re-read the same taken jobs forever.
      const all = this.roomMessages;
      const fresh = since === null ? all : all.filter((m) => (m.seq ?? 0) > since);
      return { messages: fresh.slice(-limit) };
    },
    async postMessage(room, text, identity) {
      posts.push({ room, text, did: identity.did });
    },
    async getKv(ns, key) {
      return kv.has(`${ns}/${key}`) ? JSON.parse(kv.get(`${ns}/${key}`)) : null;
    },
    async setKv(ns, key, value) {
      kv.set(`${ns}/${key}`, JSON.stringify(value));
      return true;
    }
  };
}

function makeBackend(text) {
  return { id: 'test-backend', simulated: false, async generate() { return { text, modelId: 'test' }; } };
}

describe('KibbleEngine identity requirements', () => {
  test('refuses to construct without both identities and a client', () => {
    const id = generateIdentity();
    assert.throws(() => new KibbleEngine({ validatorIdentity: id, client: {} }));
    assert.throws(() => new KibbleEngine({ workerIdentity: id, client: {} }));
    assert.throws(() => new KibbleEngine({ workerIdentity: id, validatorIdentity: id }));
  });

  test('the DID card URL is the same note publishDidProfile writes', () => {
    const identity = generateIdentity();
    const client = makeClient();
    const url = didCardUrl(client, identity);
    assert.match(url, /^https:\/\/test\.example\/kv\/did-[0-9a-f]{2}\/[0-9a-f]{14}$/);
  });
});

function claimMsg(id, from, seq) {
  return { text: `CLAIM v1 | ${id} | worker`, from, seq };
}

/**
 * The two lanes exist because the one-lane version lost every race it entered.
 * Measured on the live tape: three deliveries, three jobs claimed by somebody
 * else 3-4 messages ahead of us, all three dropped as non-claimant RESULTs.
 * These tests pin the order that fixed it — claim on sight, answer afterwards,
 * and never pay for a job we already lost.
 */
describe('KibbleEngine fast lane', () => {
  test('claims an unclaimed job on sight, without running the model', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    engine.localState.cursor = 0;
    const result = await engine.runFastLane({ maxMs: 3000 });

    assert.equal(result.claimed, 1);
    assert.equal(client.posts.length, 1);
    assert.match(client.posts[0].text, /^CLAIM v1 \| k000000000a \| worker$/);
    assert.equal(engine.localState.heldJobs.length, 1);
    assert.equal(engine.localState.heldJobs[0].jobId, 'k000000000a');
  });

  test('does not claim a job somebody else already took', async () => {
    const client = makeClient({
      roomMessages: [jobLine('k000000000a'), claimMsg('k000000000a', OTHER, 2)]
    });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    engine.localState.cursor = 0;
    const result = await engine.runFastLane({ maxMs: 3000 });
    assert.equal(result.claimed, 0);
    assert.equal(client.posts.length, 0);
  });

  test('holds at most a couple of claims, so it cannot hoard work it owes', async () => {
    const client = makeClient({
      roomMessages: ['a', 'b', 'c', 'd'].map((c, i) => ({ ...jobLine(`k00000000${c}0`), seq: i + 1 }))
    });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    assert.ok(engine.localState.heldJobs.length <= 2, `held ${engine.localState.heldJobs.length}`);
  });
});

describe('KibbleEngine worker turn', () => {
  test('does nothing when we hold no claim', async () => {
    const client = makeClient({ roomMessages: [] });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    const result = await engine.runWorkerTurn({ backend: makeBackend(GOOD_ANSWER), real: true });
    assert.equal(result.action, 'no_job');
    assert.equal(client.posts.length, 0);
  });

  test('an unclaimed job on the board is not answered until the fast lane claims it', async () => {
    // The old order — see a job, generate, then claim — is exactly what arrived
    // second every time. Seeing a job is no longer enough to spend a session.
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    let generated = false;
    const counting = { id: 'counting', simulated: false, async generate() { generated = true; return { text: GOOD_ANSWER }; } };
    const result = await engine.runWorkerTurn({ backend: counting, real: true });

    assert.equal(result.action, 'no_job');
    assert.equal(generated, false, 'no model run for a job we do not hold');
  });

  test('never delivers from a simulated backend, even holding a claim', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity: generateIdentity(), client });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    client.roomMessages.push(claimMsg('k000000000a', workerIdentity.did, 2));

    const result = await engine.runWorkerTurn({ backend: makeBackend(GOOD_ANSWER), real: false });
    assert.equal(result.action, 'skipped_no_real_model');
    assert.equal(client.posts.length, 1, 'still just the claim');
  });

  test('delivers a claim we won as RESULT only, with no second competing CLAIM', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity: generateIdentity(), client });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    client.roomMessages.push(claimMsg('k000000000a', workerIdentity.did, 2));

    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kibble-ledger-'));
    const ledgerPath = path.join(ledgerDir, 'receipts.jsonl');
    const result = await engine.runWorkerTurn({ backend: makeBackend(GOOD_ANSWER), real: true, ledgerPath });

    assert.equal(result.action, 'delivered');
    assert.equal(client.posts.length, 2, 'one claim from the fast lane, one result from here');
    assert.match(client.posts[0].text, /^CLAIM v1 \| k000000000a \| worker$/);
    assert.match(client.posts[1].text, /^RESULT v1 \| k000000000a \| /);
    assert.doesNotMatch(client.posts[1].text, /^DELIVER/);
    assert.match(client.posts[1].text, /verified worker: https:\/\/test\.example\/kv\//);

    assert.equal(engine.localState.heldJobs.length, 0, 'the claim is settled, not still owed');
    assert.equal(engine.localState.resultsDelivered, 1);
    const ledgered = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(ledgered.length, 1);
  });

  test('a claim we lost is dropped before the model is ever run', async () => {
    // This is the whole point: three real answers were binned by the board
    // because somebody claimed first. Losing must cost nothing but the claim.
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity: generateIdentity(), client });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    // Their claim landed first; ours came after.
    client.roomMessages.push(claimMsg('k000000000a', OTHER, 2));
    client.roomMessages.push(claimMsg('k000000000a', workerIdentity.did, 3));

    let generated = false;
    const counting = { id: 'counting', simulated: false, async generate() { generated = true; return { text: GOOD_ANSWER }; } };
    const result = await engine.runWorkerTurn({ backend: counting, real: true });

    assert.equal(result.action, 'claims_lost');
    assert.equal(generated, false, 'no session spent on a line the board would discard');
    assert.equal(engine.localState.heldJobs.length, 0);
    assert.equal(engine.localState.claimsLost, 1);
  });

  test('a refused answer releases the claim and is never regenerated', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000b')] });
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    client.roomMessages.push(claimMsg('k000000000b', workerIdentity.did, 2));

    const first = await engine.runWorkerTurn({ backend: makeBackend(THIN_ANSWER), real: true });
    assert.equal(first.action, 'refused');
    assert.equal(client.posts.length, 1, 'the claim stands, but no slop was posted behind it');
    assert.equal(engine.localState.heldJobs.length, 0, 'we stop owing a job we cannot answer');

    // A fresh instance reading the same persisted state must not pay for it again.
    const engine2 = new KibbleEngine({ workerIdentity, validatorIdentity, client });
    let generated = false;
    const counting = { id: 'counting', simulated: false, async generate() { generated = true; return { text: THIN_ANSWER }; } };
    engine2.localState.cursor = 0;
    await engine2.runFastLane({ maxMs: 1500 });
    assert.equal(generated, false);
    assert.ok(!engine2.localState.heldJobs.some((h) => h.jobId === 'k000000000b'),
      'the refused job is not re-claimed either');
  });
});

describe('KibbleEngine validator turn', () => {
  test('does nothing when no thin delivery is waiting', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000e'), deliverLine('k000000000e', 'A genuinely specific answer with concrete detail.')] });
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    const result = await engine.runValidatorTurn();
    assert.equal(result.action, 'no_target');
    assert.equal(client.posts.length, 0);
  });

  test('attests a thin delivery as not-useful, with a DID card attached, and never as useful', async () => {
    const client = makeClient({
      roomMessages: [jobLine('k000000000f'), deliverLine('k000000000f', "Completed work on 'Test title' successfully.")]
    });
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    const result = await engine.runValidatorTurn();
    assert.equal(result.action, 'attested_not');
    assert.equal(client.posts.length, 1);
    assert.match(client.posts[0].text, /^ATTEST v1 \| k000000000f \| not \| /);
    assert.doesNotMatch(client.posts[0].text, /\|\s*useful\s*\|/);
    assert.match(client.posts[0].text, /Verified by: https:\/\/test\.example\/kv\//);
    assert.equal(client.posts[0].did, validatorIdentity.did);
    assert.equal(engine.localState.attestsPosted, 1);
  });

  test('never attests its own worker\'s delivery', async () => {
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const client = makeClient({
      roomMessages: [
        jobLine('k000000000g'),
        { text: "DELIVER v1 | k000000000g | Completed work on 'Test title' successfully.", from: workerIdentity.did, seq: 2 }
      ]
    });
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    const result = await engine.runValidatorTurn();
    assert.equal(result.action, 'no_target');
    assert.equal(client.posts.length, 0);
  });
});
