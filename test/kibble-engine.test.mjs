import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { KibbleEngine, didCardUrl } from '../src/kibble-engine.mjs';
import { reconstructBoard } from '../src/kibble.mjs';
import { QUESTION_BANK } from '../src/kibble-jobs.mjs';
import { boardBriefs, instrumentBriefs, nextBrief, briefLine } from '../src/kibble-briefs.mjs';

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

/**
 * Memory is the authority inside one process; the note is only a restart's
 * memory. Re-merging it mid-run is what forced the three lanes to run one after
 * another, and that serialisation cost the fast lane roughly half the interval.
 */
/**
 * A fixed claim rate has been wrong twice — once set on a belief measurement
 * disproved, once on plain caution. The operator asked the right question: if
 * more genuine work is worth more, why is there a ceiling? Because an abandoned
 * claim blocks that job for every other agent. So the rate follows the one
 * thing that actually matters, which is whether we finish what we take.
 */
describe('KibbleEngine claim rate follows the finishing rate', () => {
  const engineWith = () => new KibbleEngine({
    workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client: makeClient()
  });

  test('nothing moves until there is a full window to judge', () => {
    const engine = engineWith();
    const start = engine.workerGuardrails.maxPerHour;
    for (let i = 0; i < 7; i++) engine.recordClaimOutcome(true);
    assert.equal(engine.workerGuardrails.maxPerHour, start, 'seven outcomes is not evidence');
  });

  test('finishing everything opens the rate up, and it stops at the ceiling', () => {
    const engine = engineWith();
    const start = engine.workerGuardrails.maxPerHour;
    for (let i = 0; i < 8; i++) engine.recordClaimOutcome(true);
    assert.ok(engine.workerGuardrails.maxPerHour > start);

    for (let i = 0; i < 200; i++) engine.recordClaimOutcome(true);
    // 60/hour is the structural limit — one settled claim per 60s cycle — not
    // a number chosen out of caution. The server allows 18,000 writes an hour.
    assert.equal(engine.workerGuardrails.maxPerHour, 60);
  });

  test('abandoning claims backs off fast, and it stops at the floor', () => {
    // The failure this exists for: one sentence in a prompt turned 11 of 17
    // claims into abandonments, and a fixed rate kept taking jobs throughout.
    const engine = engineWith();
    for (let i = 0; i < 16; i++) engine.recordClaimOutcome(true);
    const raised = engine.workerGuardrails.maxPerHour;

    for (let i = 0; i < 8; i++) engine.recordClaimOutcome(false);
    assert.ok(engine.workerGuardrails.maxPerHour < raised, 'backed off once claims stopped landing');

    for (let i = 0; i < 200; i++) engine.recordClaimOutcome(false);
    assert.equal(engine.workerGuardrails.maxPerHour, 3, 'never stops taking part entirely');
  });

  test('it falls faster than it rises, because the damage is asymmetric', () => {
    // Claiming too slowly costs us some work. Claiming too fast and abandoning
    // costs everyone else the job.
    const up = engineWith();
    for (let i = 0; i < 8; i++) up.recordClaimOutcome(true);
    const gained = up.workerGuardrails.maxPerHour - 6;

    const down = engineWith();
    for (let i = 0; i < 8; i++) down.recordClaimOutcome(false);
    const lost = 6 - down.workerGuardrails.maxPerHour;

    assert.ok(lost > gained, `lost ${lost} per step, gained ${gained}`);
  });

  test('the learned rate survives a restart', () => {
    const client = makeClient();
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();

    const first = new KibbleEngine({ workerIdentity, validatorIdentity, client });
    for (let i = 0; i < 16; i++) first.recordClaimOutcome(true);
    const learned = first.workerGuardrails.maxPerHour;
    assert.ok(learned > 6);

    return first.saveRemoteState().then(async () => {
      const second = new KibbleEngine({ workerIdentity, validatorIdentity, client });
      await second.loadRemoteState();
      assert.equal(second.workerGuardrails.maxPerHour, learned,
        'an hour of evidence is not re-learned from scratch on every restart');
    });
  });
});

const OUTSIDER = 'did:key:z6MkOutsiderDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

/** A board where each of our deliveries carries one verdict from a stranger. */
function boardOfVerdicts(workerDid, verdicts, attestor = OUTSIDER) {
  const ids = [];
  const lines = [];
  verdicts.forEach((verdict, i) => {
    const id = 'k00000000' + String(i).padStart(2, '0');
    ids.push(id);
    lines.push(
      { text: 'JOB v1 | ' + id + ' | explain | T | A long enough body to be a real question here.', from: OUTSIDER, seq: i * 3 + 1 },
      { text: 'RESULT v1 | ' + id + ' | a real answer of some substance', from: workerDid, seq: i * 3 + 2 },
      { text: 'ATTEST v1 | ' + id + ' | ' + verdict + ' | a reason of adequate length here', from: attestor, seq: i * 3 + 3 }
    );
  });
  return { jobs: reconstructBoard(lines), ids };
}

/**
 * Until this existed the worker counted deliveries and stopped there, with no
 * idea whether any of it was any good — the same blindness as counting claims
 * and never checking they landed. A not-useful verdict is the only thing on
 * this board that actively subtracts, so it decides whether volume pays.
 */
describe('KibbleEngine reads back what the room made of its work', () => {
  test('counts the verdicts strangers left on our deliveries', () => {
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({
      workerIdentity, validatorIdentity: generateIdentity(), client: makeClient()
    });
    const { jobs, ids } = boardOfVerdicts(workerIdentity.did, ['useful', 'not', 'useful']);
    engine.localState.deliveredJobIds = ids;

    const seen = engine.reviewOwnDeliveries(jobs);
    assert.equal(seen.useful, 2);
    assert.equal(seen.not, 1);
    assert.equal(seen.acted, false, 'three verdicts is not yet a sample');
  });

  test('backs off when most of our work is judged not useful', () => {
    // Break-even is 1 + useful*6 - not*3, so a high not-rate is the point where
    // delivering more stops paying. This is arithmetic, not manners.
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({
      workerIdentity, validatorIdentity: generateIdentity(), client: makeClient()
    });
    const { jobs, ids } = boardOfVerdicts(workerIdentity.did, ['not', 'not', 'not', 'not', 'useful']);
    engine.localState.deliveredJobIds = ids;

    const before = engine.workerGuardrails.maxPerHour;
    const seen = engine.reviewOwnDeliveries(jobs);
    assert.equal(seen.acted, true);
    assert.ok(engine.workerGuardrails.maxPerHour < before);
  });

  test('a good verdict rate is left alone rather than treated as a reason to slow', () => {
    const workerIdentity = generateIdentity();
    const engine = new KibbleEngine({
      workerIdentity, validatorIdentity: generateIdentity(), client: makeClient()
    });
    const { jobs, ids } = boardOfVerdicts(workerIdentity.did, ['useful', 'useful', 'useful', 'not', 'useful']);
    engine.localState.deliveredJobIds = ids;

    const before = engine.workerGuardrails.maxPerHour;
    engine.reviewOwnDeliveries(jobs);
    assert.equal(engine.workerGuardrails.maxPerHour, before);
  });

  test('neither of our own keys counts as the room judging us', () => {
    // Scribe praising Scout would otherwise let the agent grade its own work
    // and then speed up on the strength of it.
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client: makeClient() });

    const a = boardOfVerdicts(workerIdentity.did, ['useful'], validatorIdentity.did);
    engine.localState.deliveredJobIds = a.ids;
    assert.equal(engine.reviewOwnDeliveries(a.jobs).useful, 0);

    const b = boardOfVerdicts(workerIdentity.did, ['useful'], workerIdentity.did);
    engine.localState.deliveredJobIds = b.ids;
    assert.equal(engine.reviewOwnDeliveries(b.jobs).useful, 0);
  });
});

describe('KibbleEngine asks only questions it actually has', () => {
  // jobs_posted is worth x2 with no race, which is exactly why it is the
  // easiest thing here to abuse — the board says it ignores job farming. The
  // bank is finite and hand-written, so running out is the correct end state.
  const engineFor = (client) => new KibbleEngine({
    workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
  });

  test('posts a real question, signed by the worker key', async () => {
    const client = makeClient();
    const engine = engineFor(client);

    const result = await engine.runPosterTurn();
    assert.equal(result.action, 'job_posted');
    assert.equal(client.posts.length, 1);
    assert.match(client.posts[0].text, /^JOB v1 \| k[0-9a-f]{10} \| \w+ \| /);
    assert.match(client.posts[0].text, /Success:/, 'a job with no bar cannot be attested honestly');
    assert.equal(client.posts[0].did, engine.workerIdentity.did);
  });

  test('never asks the same question twice', async () => {
    const client = makeClient();
    const engine = engineFor(client);
    engine.localState.postedQuestionKeys = QUESTION_BANK.map((q) => q.key);

    const result = await engine.runPosterTurn();
    assert.equal(result.action, 'no_questions_left');
    assert.equal(client.posts.length, 0, 'reposting a spent question is the farming this avoids');
  });

  test('stops rather than inventing filler when the bank empties', async () => {
    const client = makeClient();
    const engine = engineFor(client);
    engine.localState.postedQuestionKeys = QUESTION_BANK.map((q) => q.key);
    await engine.runPosterTurn();
    await engine.runPosterTurn();
    assert.equal(client.posts.length, 0);
  });

  test('every banked question states a checkable success condition', () => {
    for (const q of QUESTION_BANK) {
      assert.match(q.body, /Success:/, `${q.key} has no success condition`);
      assert.ok(q.body.length > 120, `${q.key} is too thin to answer`);
    }
  });
});

describe('publishing measurements rather than opinions', () => {
  // `briefs` is a scoring term open to everyone — 73 agents posted 409 in one
  // 2.2-hour window, the host only one of them — and we had posted none. It is
  // also the only lane here with no race, no claim to abandon and no answer of
  // ours to be judged, and it is simply what an evidence scout does.
  test('a brief carries the wire shape this room uses', () => {
    const line = briefLine('Something measurable happened', 'Counted over 1,000 lines in one export.');
    assert.match(line, /^BRIEF v1 \| \d{4}-\d{2}-\d{2} \| Something measurable happened \| /);
    assert.ok(line.length < 4096);
  });

  test('says nothing at all about a slice too small to measure', () => {
    // Reporting a ratio over nine jobs would be a number without a measurement
    // behind it, which is the thing this whole file refuses to post.
    assert.deepEqual(boardBriefs(new Map()), []);
  });

  test('every brief names the population it counted', () => {
    const jobs = reconstructBoard(Array.from({ length: 300 }, (_, i) => {
      const id = 'k' + String(i).padStart(10, '0').slice(0, 10);
      return [
        { text: `JOB v1 | ${id} | explain | T | A long enough body to be a real question here.`, from: OTHER, seq: i * 3 + 1 },
        { text: `DELIVER v1 | ${id} | Completed work on T successfully.`, from: OTHER, seq: i * 3 + 2 }
      ];
    }).flat());

    const briefs = boardBriefs(jobs);
    assert.ok(briefs.length > 0);
    for (const b of briefs) {
      assert.match(b.body, /Counted over|Of |Across /, `${b.key} does not say what it counted`);
      assert.ok(b.key && b.headline && b.body);
    }
  });

  test('an instrument reading needs enough samples to be one', () => {
    assert.deepEqual(instrumentBriefs({ claimLatencies: [100, 200, 300] }), []);
    const enough = instrumentBriefs({ claimLatencies: Array.from({ length: 25 }, (_, i) => 500 + i * 10) });
    assert.equal(enough.length, 1);
    assert.match(enough[0].body, /Measured over 25 JOB lines/);
  });

  test('the same brief is never posted twice', () => {
    const candidates = [{ key: 'a', headline: 'h', body: 'b' }, { key: 'b', headline: 'h', body: 'b' }];
    assert.equal(nextBrief(candidates, []).key, 'a');
    assert.equal(nextBrief(candidates, ['a']).key, 'b');
    assert.equal(nextBrief(candidates, ['a', 'b']), null, 'nothing new is a reason to say nothing');
  });
});

describe('KibbleEngine state ownership', () => {
  test('the remote note is read once, not on every turn', async () => {
    const client = makeClient({ roomMessages: [] });
    let reads = 0;
    const wrapped = { ...client, async getKv(...args) { reads += 1; return client.getKv(...args); } };
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client: wrapped
    });

    await engine.loadRemoteState();
    await engine.loadRemoteState();
    await engine.runWorkerTurn({ backend: makeBackend(GOOD_ANSWER), real: true });

    assert.equal(reads, 1, 'a second read is a chance to clobber what memory already holds');
  });

  test('a claim made during another turn is not wiped by a later load', async () => {
    // The exact failure this guards: the fast lane records a claim, another
    // lane re-reads the note it was written before, and the claim disappears —
    // losing the race we had already won.
    const client = makeClient({ roomMessages: [jobLine('k000000000a')] });
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });

    engine.localState.cursor = 0;
    await engine.runFastLane({ maxMs: 3000 });
    assert.equal(engine.localState.heldJobs.length, 1);

    await engine.loadRemoteState();
    assert.equal(engine.localState.heldJobs.length, 1, 'the held claim survived');
  });

  test('counters never roll backwards when the note is behind', async () => {
    const client = makeClient({ roomMessages: [] });
    // A note written by an older run, or half-written, must not undo work this
    // process has already posted to a public tape.
    await client.setKv('kibble', 'anything', {});
    const engine = new KibbleEngine({
      workerIdentity: generateIdentity(), validatorIdentity: generateIdentity(), client
    });
    engine.localState.resultsDelivered = 5;
    engine.localState.attestsPosted = 9;

    const stale = { resultsDelivered: 0, attestsPosted: 2 };
    client.getKv = async () => stale;
    await engine.loadRemoteState();

    assert.equal(engine.localState.resultsDelivered, 5);
    assert.equal(engine.localState.attestsPosted, 9);
  });
});

describe('KibbleEngine validator turn', () => {
  test('does nothing when no thin delivery is waiting', async () => {
    const client = makeClient({ roomMessages: [jobLine('k000000000e'), deliverLine('k000000000e', 'A genuinely specific answer with concrete detail.')] });
    const workerIdentity = generateIdentity();
    const validatorIdentity = generateIdentity();
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    // No thin template to call out, so the turn falls through to the useful
    // lane — which needs a real model and a franchise, and has neither here.
    const result = await engine.runValidatorTurn();
    assert.match(result.action, /^(no_target|useful_skipped_no_real_model|useful_unfranchised|no_useful_target)$/);
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
        jobLine('k000000000e'),
        { text: "DELIVER v1 | k000000000e | Completed work on 'Test title' successfully.", from: workerIdentity.did, seq: 2 }
      ]
    });
    const engine = new KibbleEngine({ workerIdentity, validatorIdentity, client });

    // The fixture used to say `k000000000g`. `g` is not hex, so the line never
    // parsed, nothing was ever found, and "found nothing" read as "correctly
    // refused" — while the exclusion it claimed to prove did not exist at all.
    // What matters is the post count: our two keys never judge each other.
    const result = await engine.runValidatorTurn();
    assert.doesNotMatch(result.action, /^attested/);
    assert.equal(client.posts.length, 0, 'Scribe must never attest Scout, and did not');
  });
});
