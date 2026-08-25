import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAntigravityLiveProvider,
  encodeAntigravityPrompt,
  parseAntigravityTranscript
} from '../src/adapters/antigravity-live.mjs';

function terminalStep(content, stepIndex = 3) {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content,
    tool_calls: []
  });
}

describe('Antigravity live council transport', () => {
  test('transports arbitrary Unicode through the ASCII-only agentapi argument boundary losslessly', () => {
    const original = 'Lietuviškai: ąčęėįšųūž ir emoji 😀';
    const encoded = encodeAntigravityPrompt(original);
    assert.match(encoded, /^[\x00-\x7f]+$/);
    assert.match(encoded, /\\u0161/);
    const jsonString = encoded.split('\n').at(-1);
    assert.equal(JSON.parse(jsonString), original);
  });

  test('reads the latest terminal Gemini JSON response from a transcript', () => {
    const transcript = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '{"task":"Labas"}' }),
      terminalStep('{"summary":"Pirmas atsakymas"}', 1),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'dar dirbu', tool_calls: [{ name: 'tool' }] }),
      terminalStep('```json\n{"summary":"Galutinis Gemini atsakymas"}\n```', 3)
    ].join('\n');

    assert.deepEqual(parseAntigravityTranscript(transcript), {
      summary: 'Galutinis Gemini atsakymas'
    });
  });

  test('uses fast Gemini by default and reuses one conversation during a run', async () => {
    const calls = [];
    const bridge = async (request) => {
      calls.push(request);
      return {
        conversationId: 'gemini-conversation-1',
        transcript: terminalStep(`{"summary":"${request.phase} atsakymas"}`)
      };
    };
    bridge.health = async () => ({ available: true, version: 'Antigravity test' });

    const provider = createAntigravityLiveProvider({
      workspace: 'C:\\workspace',
      bridge
    });

    assert.equal(provider.id, 'gemini');
    const health = await provider.health();
    assert.equal(health.id, 'gemini');
    assert.equal(health.available, true);
    assert.equal(health.councilAvailable, true);
    assert.equal(health.transport, 'antigravity-agentapi-live');
    assert.equal(health.role, 'default-conductor-and-worker');

    assert.deepEqual(await provider.generate({
      phase: 'triage',
      prompt: 'Suskirstyk užduotį',
      runId: 'run-1'
    }), { summary: 'triage atsakymas' });
    assert.deepEqual(await provider.generate({
      phase: 'proposal',
      prompt: 'Pateik pasiūlymą',
      runId: 'run-1'
    }), { summary: 'proposal atsakymas' });

    assert.equal(calls[0].model, 'flash');
    assert.equal(calls[0].conversationId, null);
    assert.equal(calls[1].conversationId, 'gemini-conversation-1');
    assert.equal(calls[1].workspace, 'C:\\workspace');
  });

  test('keeps separate Antigravity conversations for separate TriAgent runs', async () => {
    let sequence = 0;
    const calls = [];
    const bridge = async (request) => {
      calls.push(request);
      sequence += 1;
      return {
        conversationId: request.conversationId ?? `conversation-${sequence}`,
        transcript: terminalStep('{"summary":"ok"}')
      };
    };

    const provider = createAntigravityLiveProvider({ workspace: process.cwd(), bridge });
    await provider.generate({ phase: 'proposal', prompt: 'A', runId: 'run-a' });
    await provider.generate({ phase: 'proposal', prompt: 'B', runId: 'run-b' });

    assert.equal(calls[0].conversationId, null);
    assert.equal(calls[1].conversationId, null);
  });

  test('does not claim Gemini is available when the live bridge health check fails', async () => {
    const bridge = async () => assert.fail('generate must not run during health');
    bridge.health = async () => ({ available: false, reason: 'Antigravity is closed' });
    const provider = createAntigravityLiveProvider({ workspace: process.cwd(), bridge });

    const health = await provider.health();
    assert.equal(health.available, false);
    assert.equal(health.councilAvailable, false);
    assert.equal(health.reason, 'Antigravity is closed');
  });
});
