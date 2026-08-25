import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function importRequired(relativePath) {
  try {
    return await import(pathToFileURL(path.resolve(relativePath)));
  } catch (error) {
    assert.fail(`Expected ${relativePath} to be importable: ${error.message}`);
  }
}

describe('provider output parsers', () => {
  test('parses the last Codex agent message from JSONL', async () => {
    const { parseCodexOutput } = await importRequired('src/adapters/providers.mjs');
    const output = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"summary":"Codex planas"}' }
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } })
    ].join('\n');

    assert.deepEqual(parseCodexOutput(output), { summary: 'Codex planas' });
  });

  test('parses Claude JSON result envelope', async () => {
    const { parseClaudeOutput } = await importRequired('src/adapters/providers.mjs');
    const output = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '```json\n{"summary":"Claude planas"}\n```'
    });

    assert.deepEqual(parseClaudeOutput(output), { summary: 'Claude planas' });
  });
});

describe('live provider command boundaries', () => {
  test('Codex council requests are read-only, non-interactive and ephemeral', async () => {
    const { createCodexProvider } = await importRequired('src/adapters/providers.mjs');
    const calls = [];
    const provider = createCodexProvider({
      executable: 'codex.exe',
      workspace: 'C:\\workspace',
      run: async (request) => {
        calls.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: '{"summary":"ok"}' }
          })
        };
      }
    });

    assert.deepEqual(await provider.generate({ prompt: 'Užduotis' }), { summary: 'ok' });
    assert.deepEqual(calls[0].args.slice(0, 6), ['-C', 'C:\\workspace', '-s', 'read-only', '-a', 'never']);
    assert.ok(calls[0].args.includes('--ephemeral'));
    assert.equal(calls[0].input, 'Užduotis');
  });

  test('version health never claims that subscription authentication was verified', async () => {
    const { createCodexProvider } = await importRequired('src/adapters/providers.mjs');
    const provider = createCodexProvider({
      executable: 'codex.exe',
      workspace: 'C:\\workspace',
      run: async () => ({ exitCode: 0, stdout: 'codex-cli test', stderr: '' })
    });

    const health = await provider.health();
    assert.equal(health.available, true);
    assert.equal(health.councilAvailable, true);
    assert.equal(health.authStatus, 'unverified');
  });

  test('Claude council requests disable tools without forcing plan mode or a one-turn cutoff', async () => {
    const { createClaudeProvider } = await importRequired('src/adapters/providers.mjs');
    const calls = [];
    const provider = createClaudeProvider({
      executable: 'claude.exe',
      workspace: 'C:\\workspace',
      run: async (request) => {
        calls.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ type: 'result', result: '{"summary":"ok"}' })
        };
      }
    });

    assert.deepEqual(await provider.generate({ phase: 'proposal', prompt: 'Užduotis' }), { summary: 'ok' });
    assert.ok(calls[0].args.includes('dontAsk'));
    assert.ok(calls[0].args.includes('--tools'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
    assert.ok(calls[0].args.includes('--no-session-persistence'));
    assert.equal(calls[0].args.includes('--max-turns'), false);
    assert.equal(calls[0].args.includes('plan'), false);
    const schemaIndex = calls[0].args.indexOf('--json-schema');
    assert.ok(schemaIndex > -1);
    const schema = JSON.parse(calls[0].args[schemaIndex + 1]);
    assert.deepEqual(schema.required, ['summary', 'approach', 'bestFit', 'skills', 'risks', 'verification']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(calls[0].input, 'Užduotis');
  });

  test('Claude non-zero JSON result preserves the real authentication failure', async () => {
    const { createClaudeProvider } = await importRequired('src/adapters/providers.mjs');
    const provider = createClaudeProvider({
      executable: 'claude.exe',
      workspace: 'C:\\workspace',
      run: async () => ({
        exitCode: 1,
        stderr: '',
        stdout: JSON.stringify({ result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })
      })
    });

    await assert.rejects(
      provider.generate({ prompt: 'Užduotis' }),
      /OAuth session expired and could not be refreshed/
    );
  });

  test('a missing executable is reported without attempting a model call', async () => {
    const { createCodexProvider } = await importRequired('src/adapters/providers.mjs');
    const provider = createCodexProvider({ executable: null, workspace: process.cwd() });
    assert.equal((await provider.health()).available, false);
    await assert.rejects(provider.generate({ prompt: 'test' }), /not available/);
  });
});

describe('live provider registry', () => {
  test('exposes three equal council/worker profiles and marks Gemini only as the default conductor', async () => {
    const { AGENT_PROFILES } = await importRequired('src/adapters/providers.mjs');
    assert.deepEqual(Object.keys(AGENT_PROFILES), ['codex', 'claude', 'gemini']);
    for (const [id, profile] of Object.entries(AGENT_PROFILES)) {
      assert.equal(profile.localPrior, 0.5);
      assert.equal(profile.calibration, 'pending-local-evals');
      assert.ok(profile.strengths.length > 0);
      assert.deepEqual(profile.eligibleRoles, ['proposer', 'critic', 'owner', 'reviewer', 'worker']);
      assert.equal(profile.defaultConductor, id === 'gemini');
    }
    assert.equal(AGENT_PROFILES.gemini.routingPreference, 'fast-and-cost-efficient');
  });

  test('does not export deterministic demo providers', async () => {
    const providersModule = await importRequired('src/adapters/providers.mjs');
    assert.equal(Object.hasOwn(providersModule, 'createDemoProviders'), false);
  });

  test('local registry connects Gemini as a live conductor, council member and worker', async () => {
    const { createLocalProviders } = await importRequired('src/adapters/providers.mjs');
    const bridge = async () => ({
      conversationId: 'conversation-1',
      transcript: JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: '{"summary":"Gemini nuomonė"}',
        tool_calls: []
      })
    });
    bridge.health = async () => ({ available: true, version: 'Antigravity test' });
    const providers = createLocalProviders({
      workspace: process.cwd(),
      executables: { codex: null, claude: null, cgw: 'C:\\tools\\cgw.ps1' },
      antigravityBridge: bridge
    });
    const gemini = providers.find((provider) => provider.id === 'gemini');
    const health = await gemini.health();
    assert.equal(health.available, true);
    assert.equal(health.councilAvailable, true);
    assert.equal(health.transport, 'antigravity-agentapi-live');
    assert.equal(health.role, 'default-conductor-and-worker');
    assert.deepEqual(await gemini.generate({ phase: 'proposal', prompt: 'Nuomonė', runId: 'run-1' }), {
      summary: 'Gemini nuomonė'
    });
  });
});
