import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EVENT_TYPES } from '../src/core/contracts.mjs';
import { RunStore } from '../src/core/run-store.mjs';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function importRequired(relativePath) {
  const absolutePath = path.resolve(relativePath);
  try {
    return await import(pathToFileURL(absolutePath));
  } catch (error) {
    assert.fail(`Expected ${relativePath} to be importable: ${error.message}`);
  }
}

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triagent-orchestrator-'));
  tempRoots.push(root);
  return root;
}

function scores(value) {
  return {
    correctness: value,
    taskFit: value,
    safety: value,
    evidence: value,
    clarity: value
  };
}

class FakeProvider {
  constructor(id, allAgentIds, options = {}) {
    this.id = id;
    this.allAgentIds = allAgentIds;
    this.options = options;
    this.calls = [];
    this.proposalAttempts = 0;
  }

  async health() {
    return { id: this.id, available: true, transport: 'fake', version: 'test' };
  }

  async generate(request) {
    this.calls.push(request);
    if (this.options.failPhase === request.phase) {
      throw new Error(`${this.id} ${request.phase} failed`);
    }

    if (request.phase === 'proposal') {
      this.proposalAttempts += 1;
      if (this.options.placeholderFirstProposal && this.proposalAttempts === 1) {
        return {
          summary: 'Test',
          approach: ['Step one'],
          bestFit: 'Test fit',
          skills: ['Skill one'],
          risks: ['Risk one'],
          verification: ['Check one']
        };
      }
      return {
        summary: `${this.id} pateikia konkretų ir patikrinamą tarybos planą šiai užduočiai.`,
        approach: [`${this.id} įgyvendina aiškiai apribotą žingsnį`],
        bestFit: `${this.id} gali atlikti darbą pagal turimus gebėjimus ir patikras.`,
        skills: ['analysis'],
        risks: [],
        verification: ['test']
      };
    }

    if (request.phase === 'critique') {
      const context = JSON.parse(request.contextCheckpoint);
      return {
        reviews: context.proposals
          .filter((proposal) => proposal.agentId !== this.id)
          .map((proposal) => ({
            proposalId: proposal.id,
            scores: scores(
              this.options.scoreByTarget?.[proposal.agentId]
                ?? (proposal.agentId === 'claude' ? 9 : 7)
            ),
            verdict: `${proposal.agentId} įvertintas`,
            risks: []
          }))
      };
    }

    if (request.phase === 'delegation') {
      const owner = this.options.delegationOwner
        ?? (this.allAgentIds.includes('claude') ? 'claude' : this.allAgentIds[0]);
      const reviewer = this.allAgentIds.find((agentId) => agentId !== owner) ?? null;
      return {
        answer: `${this.id} sujungta tarybos išvada`,
        approach: ['Sujungti geriausias pasiūlymų dalis', 'Patikrinti rezultatą'],
        owner,
        reviewer,
        reason: 'Tarybos peer-review reitingas ir Gemini moderavimas.',
        assignments: this.allAgentIds.map((agentId) => ({
          agentId,
          task: `${agentId} konkretus darbas`,
          verify: `${agentId} objektyvi patikra`
        })),
        dissent: []
      };
    }

    if (request.phase === 'execution') {
      return {
        summary: `${this.id} sugeneravo kodo implementaciją`,
        files: [{ path: 'src/solution.mjs', action: 'create', content: '// solution code' }],
        instructions: ['Pritaikyti pakeitimus faile src/solution.mjs'],
        verification: ['npm test']
      };
    }

    if (request.phase === 'codeReview') {
      return {
        verdict: `${this.id} nepriklausoma peržiūra patvirtinta`,
        approved: true,
        findings: [{ severity: 'info', file: 'src/solution.mjs', note: 'Kodo struktūra tvarkinga' }],
        suggestions: ['Paleisti testus']
      };
    }

    throw new Error(`Unexpected phase ${request.phase}`);
  }
}

describe('command adapter primitives', () => {
  test('runs a child process with stdin and captures stdout', async () => {
    const { runCommand } = await importRequired('src/adapters/command.mjs');
    const result = await runCommand({
      command: process.execPath,
      args: ['-e', "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))"],
      input: 'triagent',
      cwd: process.cwd(),
      timeoutMs: 2_000
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'TRIAGENT');
  });

  test('terminates a child process after the configured deadline', async () => {
    const { runCommand, CommandTimeoutError } = await importRequired('src/adapters/command.mjs');
    await assert.rejects(
      runCommand({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        timeoutMs: 50
      }),
      CommandTimeoutError
    );
  });

  test('extracts a JSON object without trusting surrounding prose', async () => {
    const { extractJsonObject } = await importRequired('src/adapters/command.mjs');
    assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
    assert.throws(() => extractJsonObject('no structured result'), /valid JSON object/);
  });

  test('safe child environment omits API keys and unrelated variables', async () => {
    const { createSafeEnv } = await importRequired('src/adapters/command.mjs');
    const safe = createSafeEnv({
      PATH: 'bin',
      USERPROFILE: 'C:\\Users\\test',
      TEMP: 'C:\\Temp',
      OPENAI_API_KEY: 'secret',
      RANDOM_PRIVATE_VALUE: 'secret-two'
    });

    assert.equal(safe.PATH, 'bin');
    assert.equal(safe.USERPROFILE, 'C:\\Users\\test');
    assert.equal(safe.OPENAI_API_KEY, undefined);
    assert.equal(safe.RANDOM_PRIVATE_VALUE, undefined);
  });

  test('safe child environment accepts Windows key casing without widening the allowlist', async () => {
    const { createSafeEnv } = await importRequired('src/adapters/command.mjs');
    const safe = createSafeEnv({
      ProgramData: 'C:\\ProgramData',
      SystemRoot: 'C:\\Windows',
      anthropic_api_key: 'secret'
    });

    assert.equal(safe.ProgramData, 'C:\\ProgramData');
    assert.equal(safe.SystemRoot, 'C:\\Windows');
    assert.equal(safe.anthropic_api_key, undefined);
  });
});

describe('CouncilOrchestrator', () => {
  test('gives every agent the same checkpoint and records a complete council run', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const providers = agentIds.map((id) => new FakeProvider(id, agentIds));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-council-complete',
      prompt: 'Sukurk svetainės planą',
      mode: 'live'
    });

    assert.equal(result.owner, 'claude');
    assert.notEqual(result.reviewer, result.owner);
    assert.equal(result.conductorId, 'gemini');
    assert.equal(result.decisionSource, 'gemini-conductor');
    assert.equal(result.assignments.length, 3);

    const proposalCalls = providers.flatMap((provider) => provider.calls)
      .filter((call) => call.phase === 'proposal');
    assert.equal(proposalCalls.length, 3);
    assert.equal(new Set(proposalCalls.map((call) => call.contextCheckpoint)).size, 1);

    const critiqueCalls = providers.flatMap((provider) => provider.calls)
      .filter((call) => call.phase === 'critique');
    assert.equal(critiqueCalls.length, 3);
    assert.equal(new Set(critiqueCalls.map((call) => call.contextCheckpoint)).size, 1);

    const delegationCalls = providers.flatMap((provider) => provider.calls)
      .filter((call) => call.phase === 'delegation');
    assert.equal(delegationCalls.length, 1);
    assert.equal(delegationCalls[0], providers.find((provider) => provider.id === 'gemini').calls.at(-1));

    const events = await store.readEvents('run-council-complete');
    assert.equal(events[0].type, EVENT_TYPES.RUN_CREATED);
    assert.equal(events.filter((event) => event.type === EVENT_TYPES.PROPOSAL).length, 3);
    assert.equal(events.filter((event) => event.type === EVENT_TYPES.CRITIQUE).length, 3);
    const proposals = events.filter((event) => event.type === EVENT_TYPES.PROPOSAL);
    const critiques = events.filter((event) => event.type === EVENT_TYPES.CRITIQUE);
    const delegation = events.find((event) => event.type === EVENT_TYPES.DELEGATION);
    const final = events.find((event) => event.type === EVENT_TYPES.FINAL);
    assert.ok(Math.max(...proposals.map((event) => event.seq)) < Math.min(...critiques.map((event) => event.seq)));
    assert.ok(Math.max(...critiques.map((event) => event.seq)) < delegation.seq);
    assert.equal(delegation.agentId, 'gemini');
    assert.equal(final.agentId, 'gemini');
    assert.ok(delegation.seq < final.seq);
    assert.equal(events.at(-2).type, EVENT_TYPES.FINAL);
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);
  });

  test('includes a bounded current-chat history in the shared proposal checkpoint', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const providers = agentIds.map((id) => new FakeProvider(id, agentIds));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });
    const conversationHistory = [
      { role: 'user', content: 'Ankstesnis tik šio pokalbio klausimas' },
      { role: 'assistant', content: 'Ankstesnis tik šio pokalbio atsakymas' }
    ];

    await orchestrator.run({
      runId: 'run-chat-context',
      prompt: 'Tęsk tą pačią temą',
      conversationHistory,
      mode: 'live'
    });

    const checkpoints = providers.map((provider) => (
      JSON.parse(provider.calls.find((call) => call.phase === 'proposal').contextCheckpoint)
    ));
    assert.ok(checkpoints.every((value) => (
      value.conversationHistory[0].content === conversationHistory[0].content
      && value.conversationHistory[1].content === conversationHistory[1].content
    )));
    assert.equal(new Set(checkpoints.map((value) => JSON.stringify(value))).size, 1);
  });

  test('continues in degraded mode when one provider fails', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude'];
    const providers = [
      new FakeProvider('codex', agentIds, { failPhase: 'proposal' }),
      new FakeProvider('claude', agentIds)
    ];
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-degraded',
      prompt: 'Patikrink planą',
      mode: 'live'
    });

    assert.equal(result.owner, 'claude');
    assert.equal(result.degraded, true);
    assert.equal(result.decisionSource, 'deterministic-fallback');
    assert.ok(result.degradedReasons.includes('gemini_conductor_unavailable'));
    const events = await store.readEvents('run-degraded');
    assert.ok(events.some((event) => event.type === EVENT_TYPES.ERROR && event.agentId === 'codex'));
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);
  });

  test('uses deterministic degraded fallback when Gemini conductor fails', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const providers = agentIds.map((id) => new FakeProvider(
      id,
      agentIds,
      id === 'gemini' ? { failPhase: 'delegation' } : {}
    ));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-conductor-fallback',
      prompt: 'Suskirstyk darbus',
      mode: 'live'
    });

    assert.equal(result.owner, 'claude');
    assert.equal(result.decisionSource, 'deterministic-fallback');
    assert.equal(result.degraded, true);
    assert.ok(result.degradedReasons.includes('gemini_conductor_failed'));
    const events = await store.readEvents('run-conductor-fallback');
    assert.ok(events.some((event) => event.type === EVENT_TYPES.ERROR
      && event.agentId === 'gemini'
      && event.payload.phase === 'delegation'));
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);
  });

  test('retries one schema-valid but placeholder proposal before admitting it to the council', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const providers = agentIds.map((id) => new FakeProvider(
      id,
      agentIds,
      id === 'claude' ? { placeholderFirstProposal: true } : {}
    ));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-placeholder-retry',
      prompt: 'Pateik kokybišką planą',
      mode: 'live'
    });

    const claude = providers.find((provider) => provider.id === 'claude');
    assert.equal(claude.calls.filter((call) => call.phase === 'proposal').length, 2);
    assert.equal(result.participantCoverage.proposals, '3/3');
    assert.equal(result.degraded, false);
    const events = await store.readEvents('run-placeholder-retry');
    assert.ok(events.some((event) => event.type === EVENT_TYPES.AGENT_STATUS
      && event.agentId === 'claude'
      && event.payload.status === 'retrying'));
  });

  test('learns only from completed TriAgent evidence and uses bounded priors on the next run', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const scoreByTarget = { codex: 8, claude: 8, gemini: 8 };
    const providers = agentIds.map((id) => new FakeProvider(id, agentIds, {
      scoreByTarget,
      ...(id === 'gemini' ? { delegationOwner: 'codex' } : {})
    }));
    const store = new RunStore(makeTempRoot());
    const recorded = [];
    const learningRegistry = {
      async priors(taskClass) {
        assert.equal(taskClass, 'code');
        return { codex: 0.7, claude: 0.3, gemini: 0.5 };
      },
      async recordRun(evidence) {
        recorded.push(evidence);
        return true;
      }
    };
    const orchestrator = new CouncilOrchestrator({ store, providers, learningRegistry });

    const result = await orchestrator.run({
      runId: 'run-learning-evidence',
      prompt: '/code Sukurk patikrintą modulį',
      mode: 'live'
    });

    assert.equal(result.owner, 'codex');
    assert.equal(result.learning.taskClass, 'code');
    assert.equal(result.learning.persisted, true);
    assert.deepEqual(result.learning.priors, { codex: 0.7, claude: 0.3, gemini: 0.5 });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].runId, 'run-learning-evidence');
    assert.equal(recorded[0].taskClass, 'code');
    assert.deepEqual(recorded[0].agents.map((agent) => agent.agentId), agentIds);
    assert.ok(recorded[0].agents.every((agent) => Number.isFinite(agent.latencyMs) && agent.latencyMs >= 0));
    assert.match(providers[0].calls[0].contextCheckpoint, /"learnedPriors"/);
  });

  test('orchestrates complete /code execution and code review flow', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    const providers = agentIds.map((id) => new FakeProvider(id, agentIds));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-code-complete',
      prompt: '/code Sukurk naują savybę sistemoje',
      mode: 'live'
    });

    assert.equal(result.isCodeTask, true);
    assert.equal(result.owner, 'claude');
    assert.equal(result.reviewer, 'codex');
    assert.ok(Array.isArray(result.files) && result.files.length > 0);
    assert.equal(result.codeReview?.approved, true);

    const events = await store.readEvents('run-code-complete');
    const executionEvent = events.find((event) => event.type === EVENT_TYPES.EXECUTION);
    const reviewEvent = events.find((event) => event.type === EVENT_TYPES.CODE_REVIEW);
    assert.ok(executionEvent, 'EXECUTION event should be emitted');
    assert.equal(executionEvent.agentId, 'claude');
    assert.ok(reviewEvent, 'CODE_REVIEW event should be emitted');
    assert.equal(reviewEvent.agentId, 'codex');
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);
    assert.equal(events.at(-1).payload.isCodeTask, true);
  });

  test('emits QUOTA_STATUS event and handles quota limit exhaustion gracefully', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const agentIds = ['codex', 'claude', 'gemini'];
    class QuotaFailProvider extends FakeProvider {
      async generate(request) {
        if (this.id === 'codex' && request.phase === 'proposal') {
          throw new Error('429 Too Many Requests: Rate limit and quota exceeded for codex');
        }
        return super.generate(request);
      }
    }
    const providers = agentIds.map((id) => new QuotaFailProvider(id, agentIds));
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    const result = await orchestrator.run({
      runId: 'run-quota-warning',
      prompt: 'Sukurk planą',
      mode: 'live'
    });

    assert.equal(result.degraded, true);
    const events = await store.readEvents('run-quota-warning');
    const quotaEvent = events.find((event) => event.type === EVENT_TYPES.QUOTA_STATUS);
    assert.ok(quotaEvent, 'QUOTA_STATUS event must be emitted on quota error');
    assert.equal(quotaEvent.agentId, 'codex');
    assert.equal(quotaEvent.payload.status, 'quota_warning');
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);
  });

  test('does not mark a run complete when every provider fails', async () => {
    const { CouncilOrchestrator } = await importRequired('src/orchestrator.mjs');
    const providers = [new FakeProvider('codex', ['codex'], { failPhase: 'proposal' })];
    const store = new RunStore(makeTempRoot());
    const orchestrator = new CouncilOrchestrator({ store, providers });

    await assert.rejects(
      orchestrator.run({
        runId: 'run-all-failed',
        prompt: 'Užduotis',
        mode: 'live'
      }),
      /No provider produced a proposal/
    );

    const events = await store.readEvents('run-all-failed');
    assert.ok(events.some((event) => event.type === EVENT_TYPES.ERROR));
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_FAILED);
    assert.equal(events.some((event) => event.type === EVENT_TYPES.RUN_COMPLETED), false);
  });
});
