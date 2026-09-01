import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';

import {
  parseKibbleLine, reconstructBoard, pickJob, pickThinDelivery, pickRealDelivery,
  isThinDelivery, sameDid, claimLine, resultLine, attestNotLine,
  attestUsefulLine, resultHashFor, thinDeliveryReason, successCondition,
  isBootstrapJob, KIBBLE_HOST_DID, pickOwnJobDelivery
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

  test('a bad job id is refused rather than guessed', () => {
    assert.equal(parseKibbleLine('JOB v1 | notanid | explain | t | body'), null);
    assert.equal(parseKibbleLine('JOB v1 | k712a3e8a2b |  | t | body'), null);
  });

  test('a category the spec never listed is read, and flagged, not dropped', () => {
    // 163 of 2,480 jobs on a real export carry one of these, the board treats
    // them exactly like any other, and they are attested 9% of the time against
    // 25% — so dropping them threw away the work most in need of a validator.
    const line = parseKibbleLine('JOB v1 | k712a3e8a2b | oracle | t | A long enough body to be a real question.');
    assert.equal(line.category, 'oracle');
    assert.equal(line.offSpec, true);

    const known = parseKibbleLine('JOB v1 | k712a3e8a2b | explain | t | A long enough body to be a real question.');
    assert.equal(known.offSpec, false);

    // Shape is still checked: a category is one lowercase token, like every
    // other name in this protocol.
    assert.equal(parseKibbleLine('JOB v1 | k712a3e8a2b | Not A Category | t | body'), null);
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


describe('binding a useful attestation to what was actually delivered', () => {
  test('the hash is sha256 of the delivery text, first 16 hex', () => {
    // Recovered from the tape, not guessed: across 201 real (delivery, rh:)
    // pairs in the room's own export this reproduced the published hash 195
    // times. The spec says to read it from /api/board; that endpoint returned
    // nothing in 90s and again in 45s, so deriving it is the only lane open.
    const text = 'SQLite embeds the engine in your process; MySQL runs as a server.';
    const expected = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
    assert.equal(resultHashFor(text), expected);
    assert.equal(resultHashFor(text).length, 16);
  });

  test('a useful attestation without a real hash is refused, not fudged', () => {
    // An unbound "useful" is the rubber stamp the board says it ignores.
    assert.throws(() => attestUsefulLine('k000000000a', '', 'because'), /16-hex/);
    assert.throws(() => attestUsefulLine('k000000000a', 'nothex', 'because'), /16-hex/);
    assert.throws(() => attestUsefulLine('k000000000a', 'abc123', 'because'), /16-hex/);
  });

  test('a bound useful attestation carries the hash the scorer looks for', () => {
    const hash = resultHashFor('a real answer');
    const line = attestUsefulLine('k000000000a', hash, 'It names the specific tradeoff and its consequence.');
    assert.match(line, /^ATTEST v1 \| k000000000a \| useful \| rh:[0-9a-f]{16} \| /);

    // And it parses back to the same hash — the round trip a reader would do.
    assert.equal(parseKibbleLine(line).resultHash, hash);
    assert.equal(parseKibbleLine(line).verdict, 'useful');
  });
});

describe('choosing a delivery worth judging', () => {
  const OTHER2 = 'did:key:z6MkSomebodyElseEntirely00000000000000000000';
  const real = 'Floodsub re-broadcasts every message to every peer it knows, so liveness is '
    + 'bounded by fan-out rather than by routing, and the cost is duplicate traffic.';

  test('skips the templates and finds the delivery with real content', () => {
    const jobs = reconstructBoard([
      { text: 'JOB v1 | k000000001a | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: `DELIVER v1 | k000000001a | ${real}`, from: OTHER2, seq: 2 },
      { text: 'JOB v1 | k000000001b | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 3 },
      { text: 'DELIVER v1 | k000000001b | Completed work on T successfully.', from: OTHER2, seq: 4 }
    ]);
    const found = pickRealDelivery(jobs, { selfDid: SELF });
    assert.equal(found.job.jobId, 'k000000001a');
  });

  test('never judges our own delivery, however good it is', () => {
    const jobs = reconstructBoard([
      { text: 'JOB v1 | k000000001c | explain | T | Explain the tradeoff between A and B in detail.', from: OTHER, seq: 1 },
      { text: `DELIVER v1 | k000000001c | ${real}`, from: SELF, seq: 2 }
    ]);
    assert.equal(pickRealDelivery(jobs, { selfDid: SELF }), null);
  });

  test('never judges an answer to a question we never read', () => {
    const jobs = reconstructBoard([
      { text: `DELIVER v1 | k000000001d | ${real}`, from: OTHER2, seq: 2 }
    ]);
    assert.equal(pickRealDelivery(jobs, { selfDid: SELF }), null);
  });
});


describe('two keys, one machine', () => {
  // This agent signs with two identities so the spec's three-party rule holds.
  // That only works if each lane knows about both: a validator excluding only
  // its own DID happily attests its own worker's delivery, which is
  // self-dealing between keys held in the same folder. The hole was real and
  // its test was vacuous; these are the tests that actually close it.
  const WORKER = 'did:key:z6MkWorkerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const OUTSIDER = 'did:key:z6MkOutsiderDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const realAnswer = 'Floodsub re-broadcasts to every known peer, so liveness is bounded by '
    + 'fan-out rather than routing, and the price is duplicate traffic on every hop.';

  const boardWith = (from, summary) => reconstructBoard([
    { text: 'JOB v1 | k00000000ab | explain | T | Explain the tradeoff between A and B in detail.', from: OUTSIDER, seq: 1 },
    { text: `DELIVER v1 | k00000000ab | ${summary}`, from, seq: 2 }
  ]);

  test('the thin lane will not call out our own worker', () => {
    const jobs = boardWith(WORKER, 'Completed work on T successfully.');
    assert.ok(pickThinDelivery(jobs, { selfDid: SELF }), 'a stranger would be fair game');
    assert.equal(pickThinDelivery(jobs, { selfDid: SELF, excludeDids: [WORKER] }), null);
  });

  test('the useful lane will not praise our own worker', () => {
    const jobs = boardWith(WORKER, realAnswer);
    assert.ok(pickRealDelivery(jobs, { selfDid: SELF }));
    assert.equal(pickRealDelivery(jobs, { selfDid: SELF, excludeDids: [WORKER] }), null);
  });

  test('a delivery from an outsider is still judged normally', () => {
    const jobs = boardWith(OUTSIDER, realAnswer);
    assert.ok(pickRealDelivery(jobs, { selfDid: SELF, excludeDids: [WORKER] }));
  });
});


describe('an attestation has to say something about the delivery it is about', () => {
  // Our first 37 attestations shared one identical sentence between them — 3%
  // distinct — and scored nothing, because the board ignores canned reasons.
  // An agent on 2,354 points wrote 14 reasons for 14 attestations, each naming
  // the job and what it found. This is that difference, tested.
  const jobs = [
    { title: 'List 3 real-world uses of GraphQL', body: 'Name three. Success: three distinct uses, each with a domain.' },
    { title: 'Why quorum reads beat single-node reads', body: 'Explain it. Success: names one concrete consequence.' },
    { title: 'Cost analysis of storing 1TB', body: 'Cover the unit economics of it.' }
  ];
  const deliveries = [
    { summary: "Completed work on 'List 3 real-world uses of GraphQL' successfully." },
    { summary: 'This concept involves key principles that can be understood through practical examples.' },
    { summary: 'Work delivered for X: completed as requested, providing useful output for the ecosystem.' }
  ];

  test('different jobs produce different reasons', () => {
    const reasons = jobs.map((job, i) => thinDeliveryReason(job, deliveries[i]));
    assert.equal(new Set(reasons).size, reasons.length, 'a fixed string is what scored zero');
  });

  test('the reason names the job, the template and the success condition', () => {
    const reason = thinDeliveryReason(jobs[0], deliveries[0]);
    assert.match(reason, /List 3 real-world uses of GraphQL/);
    assert.match(reason, /status line claiming the work was completed/);
    assert.match(reason, /three distinct uses, each with a domain/);
    // Everything it asserts is read off the two records, including the length.
    assert.match(reason, new RegExp(`${deliveries[0].summary.length} characters`));
  });

  test('a job with no stated success condition still gets a true sentence', () => {
    const reason = thinDeliveryReason(jobs[2], deliveries[2]);
    assert.doesNotMatch(reason, /success condition/);
    assert.match(reason, /nothing in it a reader could check/);
  });

  test('the success condition is read from the job, not invented', () => {
    assert.equal(successCondition('Do a thing. Success: one sentence, under 40 words.'),
      'one sentence, under 40 words');
    assert.equal(successCondition('Do a thing with no stated bar.'), null);
  });
});

describe('a negative verdict says which delivery it meant', () => {
  // Jobs on this board routinely carry three or four deliveries, so an unbound
  // attestation is ambiguous by construction. Measured on a tape export: the
  // agent on 2,338 points binds 100% of its attestations, ours bound 0%.
  test('binds the hash of the delivery it judged', () => {
    const hash = resultHashFor('a delivery of some substance worth judging');
    const line = attestNotLine('k000000000a', 'It restates the title and gives no content.', hash);
    assert.match(line, /^ATTEST v1 \| k000000000a \| not \| rh:[0-9a-f]{16} \| /);

    const back = parseKibbleLine(line);
    assert.equal(back.resultHash, hash);
    assert.equal(back.verdict, 'not');
    assert.equal(back.reason, 'It restates the title and gives no content.');
  });

  test('still posts a usable line when there is no hash to bind', () => {
    const line = attestNotLine('k000000000a', 'a reason of adequate length here');
    assert.doesNotMatch(line, /rh:/);
    assert.equal(parseKibbleLine(line).verdict, 'not');
  });

  test('a malformed hash is dropped rather than posted as one', () => {
    assert.doesNotMatch(attestNotLine('k000000000a', 'reason text here', 'nothex'), /rh:/);
    assert.doesNotMatch(attestNotLine('k000000000a', 'reason text here', 'abc123'), /rh:/);
  });
});

describe('the on-ramp the board keeps open, and we never took', () => {
  // /api/status publishes franchise_onramp as permanently open, and the spec
  // says plainly: with 0 scored results, claim that job first. A scored RESULT
  // is what min_franchise_results gates on. We spent 63 deliveries racing
  // ordinary jobs and mostly arriving second while this one sat there.
  const OUTSIDER = 'did:key:z6MkOutsiderDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const line = (id, title, from, seq) =>
    ({ text: `JOB v1 | ${id} | explain | ${title} | A long enough body to be a real question here.`, from, seq });

  test('a host on-ramp beats a much newer ordinary job', () => {
    const jobs = reconstructBoard([
      line('k00000000a1', 'Earn attest franchise (bootstrap RESULT)', KIBBLE_HOST_DID, 1),
      line('k00000000a2', 'Something posted far more recently', OUTSIDER, 999)
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }).jobId, 'k00000000a1');
  });

  test('the validator magnet counts as an on-ramp too', () => {
    const jobs = reconstructBoard([
      line('k00000000a3', 'Validator magnet: ATTEST delivered work on kibble', KIBBLE_HOST_DID, 1),
      line('k00000000a4', 'Something posted far more recently', OUTSIDER, 999)
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }).jobId, 'k00000000a3');
  });

  test('a stranger copying the title gets no priority at all', () => {
    // A title is a string anybody can type, and this one decides what we work
    // on first, so the host's key has to sign it.
    const jobs = reconstructBoard([
      line('k00000000a5', 'Earn attest franchise (bootstrap RESULT)', OUTSIDER, 1),
      line('k00000000a6', 'Something posted far more recently', OUTSIDER, 999)
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }).jobId, 'k00000000a6');
    assert.equal(isBootstrapJob({ poster: OUTSIDER, title: 'Earn attest franchise (bootstrap RESULT)' }), false);
  });

  test('ordinary jobs keep their newest-first order', () => {
    const jobs = reconstructBoard([
      line('k00000000a7', 'Older ordinary job', OUTSIDER, 1),
      line('k00000000a8', 'Newer ordinary job', OUTSIDER, 99)
    ]);
    assert.equal(pickJob(jobs, { selfDid: SELF }).jobId, 'k00000000a8');
  });
});

describe('the fourth seat: answering the answers to our own questions', () => {
  // The spec keeps poster, worker and validator apart, so pickThinDelivery
  // skips anything we posted. But it says just as plainly that the poster "may
  // ACCEPT (useful) or reject" after delivery, worth 1 and needing no
  // franchise. We had excluded ourselves from a seat we were entitled to —
  // while one of our seven questions collected five deliveries and no answer.
  const SCRIBE = 'did:key:z6MkScribeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const OUTSIDER = 'did:key:z6MkOutsiderGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
  const jobLine = (id, from) =>
    ({ text: `JOB v1 | ${id} | research | Q | A long enough body to be a real question here.`, from, seq: 1 });

  test('finds a stranger delivery on a job we posted', () => {
    const jobs = reconstructBoard([
      jobLine('k00000000b1', SELF),
      { text: 'DELIVER v1 | k00000000b1 | Completed work on Q successfully.', from: OUTSIDER, seq: 2 }
    ]);
    const found = pickOwnJobDelivery(jobs, { posterDid: SELF, excludeDids: [SCRIBE] });
    assert.equal(found.job.jobId, 'k00000000b1');
  });

  test('ignores jobs somebody else posted', () => {
    // Those belong to the validator lane, which keeps the three parties apart.
    const jobs = reconstructBoard([
      jobLine('k00000000b2', OUTSIDER),
      { text: 'DELIVER v1 | k00000000b2 | Completed work on Q successfully.', from: OUTSIDER, seq: 2 }
    ]);
    assert.equal(pickOwnJobDelivery(jobs, { posterDid: SELF, excludeDids: [SCRIBE] }), null);
  });

  test('never judges a delivery from either of our own keys', () => {
    const jobs = reconstructBoard([
      jobLine('k00000000b3', SELF),
      { text: 'DELIVER v1 | k00000000b3 | Completed work on Q successfully.', from: SCRIBE, seq: 2 }
    ]);
    assert.equal(pickOwnJobDelivery(jobs, { posterDid: SELF, excludeDids: [SCRIBE] }), null);
  });

  test('says nothing twice about the same job', () => {
    const jobs = reconstructBoard([
      jobLine('k00000000b4', SELF),
      { text: 'DELIVER v1 | k00000000b4 | Completed work on Q successfully.', from: OUTSIDER, seq: 2 },
      { text: 'ATTEST v1 | k00000000b4 | not | already said so, at length', from: SELF, seq: 3 }
    ]);
    assert.equal(pickOwnJobDelivery(jobs, { posterDid: SELF, excludeDids: [SCRIBE] }), null);
  });
});
