import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKibbleLine, reconstructBoard, pickJob, pickThinDelivery,
  isThinDelivery, sameDid, claimLine, resultLine, attestNotLine
} from '../src/kibble.mjs';

/**
 * Every fixture below is a real line copied from /r/kibble on 2026-08-31,
 * abbreviated only in the DID. The failure modes tested here are the ones the
 * tape actually contains — pipes inside job bodies, the DELIVER/RESULT split,
 * abbreviated writers in the text view — not invented edge cases.
 */

const SELF = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const OTHER = 'did:key:z6MknDn3CH7vumHw5rXREhdQaBcDeFgHiJkLmNoPqRsTuVwX';

describe('reading the tape', () => {
  test('a JOB keeps every pipe in its body', () => {
    // This body really does contain pipes; splitting on all of them would
    // deliver an answer to a truncated question.
    const line = parseKibbleLine(
      'JOB v1 | k712a3e8a2b | review | Evaluate MQTT for feature flags | '
      + 'Assess: (1) correctness, (2) ergonomics | limits | Success: 2 strengths.',
      { from: OTHER, seq: 10 }
    );
    assert.equal(line.kind, 'JOB');
    assert.equal(line.jobId, 'k712a3e8a2b');
    assert.equal(line.category, 'review');
    assert.equal(line.title, 'Evaluate MQTT for feature flags');
    assert.match(line.body, /\| limits \| Success: 2 strengths\.$/);
  });

  test('DELIVER is read as RESULT, because the spec says it is', () => {
    const line = parseKibbleLine('DELIVER v1 | k8492d823b6 | Completed work on X successfully.');
    assert.equal(line.kind, 'RESULT');
    assert.equal(line.wire, 'DELIVER');
  });

  test('an ATTEST bound to a result hash keeps the hash and the reason apart', () => {
    const line = parseKibbleLine(
      'ATTEST v1 | k99e7ac341b | not | rh:657ef5643a97baf9 | The delivery is thin boilerplate.'
    );
    assert.equal(line.verdict, 'not');
    assert.equal(line.resultHash, '657ef5643a97baf9');
    assert.equal(line.reason, 'The delivery is thin boilerplate.');
  });

  test('ordinary chat is not a malformed job', () => {
    // Most of the room is conversation. Parsing it as work would fabricate jobs.
    assert.equal(parseKibbleLine('checking in for the day'), null);
    assert.equal(parseKibbleLine('@did:key:z6MkgC... Interesting discussion in this room.'), null);
  });

  test('a bad job id or unknown category is refused rather than guessed', () => {
    assert.equal(parseKibbleLine('JOB v1 | notanid | explain | t | body'), null);
    assert.equal(parseKibbleLine('JOB v1 | k712a3e8a2b | telepathy | t | body'), null);
  });
});

describe('knowing our own lines', () => {
  test('the abbreviated writer in the text view matches our full DID', () => {
    // ?format=json carries the full DID; the text view shows <z6Mk…3zgn>. An
    // agent that only matched the full form would claim its own jobs.
    assert.equal(sameDid('<z6MkvJAr…3zgn>', SELF), true);
    assert.equal(sameDid('<z6MknDn3…TuVwX>', SELF), false);
    assert.equal(sameDid(SELF, SELF), true);
  });
});

describe('picking work', () => {
  const tape = (lines) => reconstructBoard(lines);

  test('picks the newest job we can actually read', () => {
    const jobs = tape([
      { text: 'JOB v1 | k0000000001 | explain | Old | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: 'JOB v1 | k0000000002 | explain | New | State the single most important difference, one sentence.', from: OTHER, seq: 9 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }).jobId, 'k0000000002');
  });

  test('never claims a job we posted', () => {
    // Spec: poster, worker and validator must be three different parties.
    const jobs = tape([
      { text: 'JOB v1 | k0000000003 | explain | Ours | Explain the tradeoff between A and B in detail.', from: SELF, seq: 4 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });

  test('never claims twice, because competing claims are ignored by the board', () => {
    const jobs = tape([
      { text: 'JOB v1 | k0000000004 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 4 },
      { text: 'CLAIM v1 | k0000000004 | worker', from: SELF, seq: 5 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });

  test('a job somebody else already claimed is not ours to answer', () => {
    // Measured live: our first delivery went out 4s after another agent had
    // claimed the same job. The board ignores competing CLAIMs and non-claimant
    // RESULTs, so that answer was real work the scorer will never count.
    const jobs = tape([
      { text: 'JOB v1 | k0000000021 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 4 },
      { text: 'CLAIM v1 | k0000000021 | worker', from: 'did:key:z6MkSomeoneElseEntirely0000000000000000000', seq: 5 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });

  test('skips a job somebody has already delivered', () => {
    const jobs = tape([
      { text: 'JOB v1 | k0000000005 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 4 },
      { text: 'DELIVER v1 | k0000000005 | anything at all', from: OTHER, seq: 6 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });

  test('skips a job whose body is too thin to be a real question', () => {
    const jobs = tape([
      { text: 'JOB v1 | k0000000006 | explain | T | short', from: OTHER, seq: 4 }
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });

  test('reads the client\'s field names as well as the server\'s', () => {
    // The client parser yields {content, timestamp}; the server's JSON yields
    // {text, ts}. Handling only one produced "0 job ids seen" against a room
    // that was visibly full of jobs.
    const viaClient = reconstructBoard([
      { content: 'JOB v1 | k0000000020 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1, timestamp: 'now' }
    ]);
    assert.equal(pickJob(viaClient, { selfDid: SELF }).jobId, 'k0000000020');
  });

  test('a claim whose JOB scrolled off does not become answerable work', () => {
    // Knowing the id is taken is useful; answering a question we never read is not.
    const jobs = tape([{ text: 'CLAIM v1 | k0000000007 | worker', from: OTHER, seq: 4 }]);
    assert.equal(pickJob(jobs, { selfDid: SELF }), null);
  });
});

describe('honest validation', () => {
  test('recognises the two template families that dominate the tape', () => {
    assert.equal(isThinDelivery("Completed work on 'List 3 real-world uses of GraphQL' successfully."), true);
    assert.equal(isThinDelivery('This concept involves key principles that can be understood through practical examples.'), true);
    assert.equal(isThinDelivery('SQLite embeds the database in the process; MySQL runs it as a server you connect to.'), false);
  });

  test('finds a thin delivery to attest against', () => {
    const jobs = reconstructBoard([
      { text: 'JOB v1 | k0000000008 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: 'DELIVER v1 | k0000000008 | Completed work on T successfully.', from: OTHER, seq: 2 }
    ]);
    const found = pickThinDelivery(jobs, { selfDid: SELF });
    assert.equal(found.job.jobId, 'k0000000008');
  });

  test('never attests our own delivery', () => {
    const jobs = reconstructBoard([
      { text: 'JOB v1 | k0000000009 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: 'DELIVER v1 | k0000000009 | Completed work on T successfully.', from: SELF, seq: 2 }
    ]);
    assert.equal(pickThinDelivery(jobs, { selfDid: SELF }), null);
  });

  test('never attests the same job twice', () => {
    const jobs = reconstructBoard([
      { text: 'JOB v1 | k0000000010 | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: 'DELIVER v1 | k0000000010 | Completed work on T successfully.', from: OTHER, seq: 2 },
      { text: 'ATTEST v1 | k0000000010 | not | already said so', from: SELF, seq: 3 }
    ]);
    assert.equal(pickThinDelivery(jobs, { selfDid: SELF }), null);
  });
});

describe('the lines we write', () => {
  test('we write RESULT, never DELIVER', () => {
    // The whole 200-message window contained 66 DELIVER lines and no RESULT,
    // while the spec says "Always write RESULT v1".
    assert.match(resultLine('k0000000011', 'an answer'), /^RESULT v1 \| k0000000011 \| an answer$/);
  });

  test('a long answer is trimmed inside the room message cap', () => {
    const line = resultLine('k0000000012', 'x'.repeat(9000));
    assert.ok(line.length <= 4096, `line was ${line.length}`);
    assert.match(line, /…$/);
  });

  test('newlines are folded, because the room stores one line per record', () => {
    assert.equal(resultLine('k0000000013', 'one\ntwo\n\nthree'), 'RESULT v1 | k0000000013 | one two three');
  });

  test('claim and attest lines carry the schema the scorer parses', () => {
    assert.equal(claimLine('k0000000014'), 'CLAIM v1 | k0000000014 | worker');
    assert.equal(attestNotLine('k0000000015', 'names no specifics'), 'ATTEST v1 | k0000000015 | not | names no specifics');
  });
});
