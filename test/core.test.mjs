import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunStore } from '../src/core/run-store.mjs';
import {
  aggregateScores,
  RUBRIC,
  PHASE_SCHEMAS,
  buildProposalPrompt,
  buildCritiquePrompt,
  buildDelegationPrompt,
  buildExecutionPrompt,
  buildCodeReviewPrompt,
  isCodeTask,
  extractCodePrompt,
  validateDelegation,
  validateExecution,
  validateCodeReview
} from '../src/core/council.mjs';
import { AGENTS, EVENT_TYPES, isValidAgent, isValidEventType, classifyProviderError } from '../src/core/contracts.mjs';

describe('TriAgent core tests', () => {
  let testRoot;
  
  before(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triagent-test-'));
  });

  after(() => {
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('contracts validation', () => {
    assert.strictEqual(isValidAgent(AGENTS.CODEX), true);
    assert.strictEqual(isValidAgent('invalid'), false);
    assert.strictEqual(isValidEventType(EVENT_TYPES.PROPOSAL), true);
    assert.strictEqual(isValidEventType(EVENT_TYPES.RUN_CREATED), true);
    assert.strictEqual(isValidEventType(EVENT_TYPES.RUN_FAILED), true);
    assert.strictEqual(isValidEventType('INVALID'), false);
  });

  test('RunStore runId validation (unsafe runId)', () => {
    const store = new RunStore(testRoot);
    assert.throws(() => store.createRun('../escaped'), /Invalid runId/);
    assert.throws(() => store.createRun('a:b'), /Invalid runId/);
    assert.throws(() => store.createRun(''), /Invalid runId/);
    assert.throws(() => store.createRun(null), /Invalid runId/);
  });

  test('RunStore createRun duplicate validation', () => {
    const store = new RunStore(testRoot);
    const runId = 'test-dup-run';
    store.createRun(runId, { some: 'meta' });
    assert.throws(() => store.createRun(runId, {}), /Run test-dup-run already exists/);
  });

  test('RunStore invalid event type / agent', () => {
    const store = new RunStore(testRoot);
    const runId = 'test-invalid-run';
    store.createRun(runId);
    assert.throws(() => store.appendEvent(runId, { type: 'INVALID' }), /Invalid event type/);
    assert.throws(() => store.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId: 'unknown' }), /Invalid agentId/);
  });

  test('RunStore create/replay ordering and fresh-instance sequence continuation', async () => {
    const runId = 'test-seq-run';
    const store1 = new RunStore(testRoot);
    const ev1 = store1.createRun(runId);
    assert.strictEqual(ev1.seq, 1);
    assert.strictEqual(ev1.type, EVENT_TYPES.RUN_CREATED);
    
    const ev2 = store1.appendEvent(runId, { type: EVENT_TYPES.PROPOSAL, agentId: AGENTS.CODEX });
    assert.strictEqual(ev2.seq, 2);

    const store2 = new RunStore(testRoot);
    const ev3 = store2.appendEvent(runId, { type: EVENT_TYPES.SCORE, agentId: AGENTS.CLAUDE });
    assert.strictEqual(ev3.seq, 3);
    
    const events = await store2.readEvents(runId);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].seq, 1);
    assert.strictEqual(events[1].seq, 2);
    assert.strictEqual(events[2].seq, 3);
  });

  test('RunStore corrupt log failure', async () => {
    const runId = 'test-corrupt';
    const store = new RunStore(testRoot);
    store.createRun(runId);
    
    const filePath = store.getRunFilePath(runId);
    fs.appendFileSync(filePath, '{"type": "SCORE", "invalid_json...\n');
    
    // readEvents should throw
    await assert.rejects(store.readEvents(runId), SyntaxError);
    
    // Sequence continuation must fail loudly too
    const store2 = new RunStore(testRoot);
    assert.throws(() => store2.appendEvent(runId, { type: EVENT_TYPES.FINAL }), SyntaxError);
  });

  test('council aggregate weighted calculation and validation', () => {
    const proposals = [
      { id: 'p1', agentId: AGENTS.CODEX },
      { id: 'p2', agentId: AGENTS.CLAUDE }
    ];
    
    const scores = [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } },
      { proposalId: 'p2', agentId: AGENTS.CODEX, scores: { correctness: 5, taskFit: 5, safety: 5, evidence: 5, clarity: 5 } }
    ];
    
    const results = aggregateScores(proposals, scores);
    assert.strictEqual(results[0].id, 'p1');
    assert.strictEqual(results[0].average, 10);
    assert.strictEqual(results[1].id, 'p2');
    assert.strictEqual(results[1].average, 5);
  });

  test('council rejects missing/extra dimension, unknown proposal, duplicate proposal', () => {
    const proposals = [{ id: 'p1', agentId: AGENTS.CODEX }];
    
    assert.throws(() => aggregateScores([...proposals, { id: 'p1', agentId: AGENTS.CLAUDE }], []), /Duplicate proposal ID: p1/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'unknown', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } }
    ]), /Unknown proposal ID/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10 } }
    ]), /Missing or extra rubric dimensions/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10, extra: 10 } }
    ]), /Missing or extra rubric dimensions/);
  });

  test('council rejects self-score, unknown agent, duplicate review', () => {
    const proposals = [{ id: 'p1', agentId: AGENTS.CODEX }];
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CODEX, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } }
    ]), /cannot score its own proposal/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: 'unknown', scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } }
    ]), /Unknown agent/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } },
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 } }
    ]), /Duplicate review for pair/);
  });

  test('council rejects out-of-range and non-finite score', () => {
    const proposals = [{ id: 'p1', agentId: AGENTS.CODEX }];
    const validScores = { correctness: 10, taskFit: 10, safety: 10, evidence: 10, clarity: 10 };
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { ...validScores, correctness: 11 } }
    ]), /Invalid score/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { ...validScores, correctness: -1 } }
    ]), /Invalid score/);
    
    assert.throws(() => aggregateScores(proposals, [
      { proposalId: 'p1', agentId: AGENTS.CLAUDE, scores: { ...validScores, correctness: NaN } }
    ]), /Invalid score/);
  });

  test('council handles deterministic tie-break lexicographically', () => {
    const proposals = [
      { id: 'b', agentId: AGENTS.CODEX },
      { id: 'a', agentId: AGENTS.CLAUDE }
    ];
    
    const validScores = { correctness: 8, taskFit: 8, safety: 8, evidence: 8, clarity: 8 };
    const scores = [
      { proposalId: 'b', agentId: AGENTS.CLAUDE, scores: { ...validScores } },
      { proposalId: 'a', agentId: AGENTS.CODEX, scores: { ...validScores } }
    ];
    
    const results = aggregateScores(proposals, scores);
    assert.strictEqual(results[0].id, 'a');
    assert.strictEqual(results[1].id, 'b');
  });

  test('council uses conservative learned priors only as a bounded tie influence', () => {
    const proposals = [
      { id: 'codex-proposal', agentId: AGENTS.CODEX },
      { id: 'claude-proposal', agentId: AGENTS.CLAUDE }
    ];
    const tied = { correctness: 8, taskFit: 8, safety: 8, evidence: 8, clarity: 8 };
    const scores = [
      { proposalId: 'codex-proposal', agentId: AGENTS.CLAUDE, scores: tied },
      { proposalId: 'claude-proposal', agentId: AGENTS.CODEX, scores: tied }
    ];

    const results = aggregateScores(proposals, scores, {
      learnedPriors: { codex: 0.7, claude: 0.3 },
      priorWeight: 0.15
    });

    assert.equal(results[0].id, 'codex-proposal');
    assert.equal(results[0].peerAverage, 8);
    assert.equal(results[0].learnedPrior, 0.7);
    assert.ok(results[0].average < 8 && results[0].average > 7.5);
    assert.throws(
      () => aggregateScores(proposals, scores, { learnedPriors: { codex: 2 }, priorWeight: 0.15 }),
      /learned prior/i
    );
  });

  test('council phase prompt differences sharing the same context', () => {
    const ctx = 'test-context';
    const role = 'test-role';
    
    const prop = buildProposalPrompt(ctx, role);
    const crit = buildCritiquePrompt(ctx, role);
    const del = buildDelegationPrompt(ctx, role);
    
    const sharedPart = `Context: ${ctx}\nRubric (weights sum to 1): ${JSON.stringify(RUBRIC)}\nOutput format: one valid JSON object only. Do not use Markdown fences or prose outside JSON.`;
    
    assert.ok(prop.includes(sharedPart));
    assert.ok(crit.includes(sharedPart));
    assert.ok(del.includes(sharedPart));
    
    assert.ok(prop.includes('Phase: PROPOSAL'));
    assert.ok(crit.includes('Phase: CRITIQUE'));
    assert.ok(del.includes('Phase: DELEGATION'));
  });

  test('council prompts define phase-specific JSON contracts', () => {
    const prop = buildProposalPrompt('context', AGENTS.CODEX);
    const crit = buildCritiquePrompt('context', AGENTS.CLAUDE);
    const del = buildDelegationPrompt('context', AGENTS.GEMINI);

    assert.match(prop, /"summary"/);
    assert.match(prop, /"approach"/);
    assert.match(prop, /"verification"/);
    assert.match(crit, /"reviews"/);
    assert.match(crit, /"proposalId"/);
    assert.match(crit, /"correctness"/);
    assert.match(del, /"owner"/);
    assert.match(del, /"reviewer"/);
    assert.match(del, /"assignments"/);
    assert.match(del, /"answer"/);
    assert.match(del, /"dissent"/);
    assert.deepEqual(PHASE_SCHEMAS.proposal.required, [
      'summary', 'approach', 'bestFit', 'skills', 'risks', 'verification'
    ]);
    assert.equal(PHASE_SCHEMAS.critique.additionalProperties, false);
    assert.equal(PHASE_SCHEMAS.delegation.additionalProperties, false);
  });

  test('delegation validation keeps owner/reviewer independent and assignments eligible', () => {
    const eligibleAgentIds = [AGENTS.CODEX, AGENTS.CLAUDE, AGENTS.GEMINI];
    for (const owner of eligibleAgentIds) {
      const reviewer = eligibleAgentIds.find((id) => id !== owner);
      const delegation = {
        answer: `${owner} atsakymas`,
        approach: ['žingsnis'],
        owner,
        reviewer,
        reason: 'Peer-review reitingas.',
        assignments: eligibleAgentIds.map((agentId) => ({
          agentId,
          task: `${agentId} darbas`,
          verify: 'testas'
        })),
        dissent: []
      };
      assert.equal(validateDelegation(delegation, {
        eligibleAgentIds,
        expectedOwner: owner,
        expectedReviewer: reviewer
      }).owner, owner);
    }

    const base = {
      answer: 'atsakymas',
      approach: [],
      owner: AGENTS.CODEX,
      reviewer: AGENTS.CLAUDE,
      reason: 'reitingas',
      assignments: [{ agentId: AGENTS.CODEX, task: 'darbas', verify: 'testas' }],
      dissent: []
    };
    assert.throws(() => validateDelegation({ ...base, reviewer: AGENTS.CODEX }, {
      eligibleAgentIds,
      expectedOwner: AGENTS.CODEX,
      expectedReviewer: AGENTS.CLAUDE
    }), /reviewer must differ/);
    assert.throws(() => validateDelegation({
      ...base,
      assignments: [{ agentId: 'unknown', task: 'darbas', verify: 'testas' }]
    }, {
      eligibleAgentIds,
      expectedOwner: AGENTS.CODEX,
      expectedReviewer: AGENTS.CLAUDE
    }), /ineligible assignment agent/);
  });

  test('classifyProviderError distinguishes auth, quota, timeout and missing CLI', () => {
    assert.equal(classifyProviderError('OAuth session expired and could not be refreshed').status, 'auth_required');
    assert.equal(classifyProviderError('Failed to authenticate: please run /login').status, 'auth_required');
    assert.equal(classifyProviderError('429 Too Many Requests - quota exceeded').status, 'quota_warning');
    assert.equal(classifyProviderError('Rate limit reached for model').status, 'quota_warning');
    assert.equal(classifyProviderError('Command exceeded the 120000 ms deadline').status, 'timeout');
    assert.equal(classifyProviderError('spawn ENOENT: CLI executable not found').status, 'unavailable');
    assert.equal(classifyProviderError('syntax error').status, 'error');
  });

  test('isCodeTask and extractCodePrompt identify /code commands and coding keywords', () => {
    assert.equal(isCodeTask('/code Sukurk funkciją'), true);
    assert.equal(extractCodePrompt('/code Sukurk funkciją'), 'Sukurk funkciją');
    assert.equal(isCodeTask('Parašyk kodo modulį'), true);
    assert.equal(isCodeTask('Koks šiandien oras?'), false);
    assert.equal(extractCodePrompt('Koks šiandien oras?'), 'Koks šiandien oras?');
  });

  test('execution and codeReview validation and prompt contracts', () => {
    const execPrompt = buildExecutionPrompt('ctx', AGENTS.CODEX);
    const revPrompt = buildCodeReviewPrompt('ctx', AGENTS.CLAUDE);
    assert.match(execPrompt, /Phase: EXECUTION/);
    assert.match(revPrompt, /Phase: CODE_REVIEW/);

    const validExec = {
      summary: 'Kodo pakeitimai',
      files: [{ path: 'a.js', action: 'create', content: 'code' }],
      instructions: ['step 1'],
      verification: ['npm test']
    };
    assert.deepEqual(validateExecution(validExec), validExec);
    assert.throws(() => validateExecution({ summary: '' }), /summary/);

    const validRev = {
      verdict: 'Patvirtinta',
      approved: true,
      findings: [{ severity: 'info', file: 'a.js', note: 'ok' }],
      suggestions: ['none']
    };
    assert.deepEqual(validateCodeReview(validRev), validRev);
    assert.throws(() => validateCodeReview({ verdict: '' }), /verdict/);
  });
});
