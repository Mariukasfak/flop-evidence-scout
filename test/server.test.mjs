import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { EVENT_TYPES } from '../src/core/contracts.mjs';
import { LearningRegistry } from '../src/core/learning-registry.mjs';

let tempRoot;
let server;
let baseUrl;
let providerCalls;

function createTestProviders() {
  const agentIds = ['codex', 'claude', 'gemini'];
  return agentIds.map((id) => ({
    id,
    async health() {
      return { id, available: true, councilAvailable: true, transport: 'test-live', version: 'test' };
    },
    async generate(request) {
      providerCalls.push({ agentId: id, ...request });
      if (request.phase === 'proposal') {
        return {
          summary: `${id} pateikia konkretų ir patikrinamą live tarybos pasiūlymą.`,
          approach: [`${id} atlieka aiškų žingsnį`],
          bestFit: `${id} tinka šiam ribotam testiniam darbui.`,
          skills: ['testing'],
          risks: [],
          verification: ['node --test']
        };
      }
      if (request.phase === 'critique') {
        const context = JSON.parse(request.contextCheckpoint);
        return {
          reviews: context.proposals
            .filter((proposal) => proposal.agentId !== id)
            .map((proposal) => ({
              proposalId: proposal.id,
              scores: Object.fromEntries(
                ['correctness', 'taskFit', 'safety', 'evidence', 'clarity'].map((key) => [key, 8])
              ),
              verdict: `${proposal.agentId} pasiūlymas patikrintas`,
              risks: []
            }))
        };
      }
      if (request.phase === 'delegation' && id === 'gemini') {
        const context = JSON.parse(request.contextCheckpoint);
        const { owner, reviewer } = context.fixedDecision;
        return {
          answer: 'Tikra live taryba paskirstė patikrinamus darbus.',
          approach: ['Apibrėžti rezultatą', 'Įgyvendinti', 'Patikrinti'],
          owner,
          reviewer,
          reason: 'Live tarybos peer-review reitingas.',
          assignments: context.eligibleAgentIds.map((agentId) => ({
            agentId,
            task: `${agentId} ribotas darbas`,
            verify: `${agentId} patikra`
          })),
          dissent: []
        };
      }
      throw new Error(`Unexpected test phase ${request.phase}`);
    }
  }));
}

async function importRequired(relativePath) {
  try {
    return await import(pathToFileURL(path.resolve(relativePath)));
  } catch (error) {
    assert.fail(`Expected ${relativePath} to be importable: ${error.message}`);
  }
}

async function waitForTerminalEvents(runId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}/events`);
    const body = await response.json();
    if (body.events.some((event) => [EVENT_TYPES.RUN_COMPLETED, EVENT_TYPES.RUN_FAILED].includes(event.type))) {
      return body.events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Run ${runId} did not reach a terminal state`);
}

beforeEach(async () => {
  providerCalls = [];
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triagent-server-'));
  const webRoot = path.join(tempRoot, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>TriAgent test</title>');

  const { createTriAgentServer } = await importRequired('src/app.mjs');
  server = createTriAgentServer({
    dataRoot: path.join(tempRoot, 'runs'),
    webRoot,
    workspace: process.cwd(),
    liveProviders: createTestProviders(),
    learningRegistry: new LearningRegistry({ root: path.join(tempRoot, 'learning') })
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('TriAgent HTTP app', () => {
  test('serves health, provider capabilities and the local UI', async () => {
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.name, 'TriAgent');
    assert.equal(health.status, 'ok');

    const providers = await (await fetch(`${baseUrl}/api/providers`)).json();
    assert.deepEqual(Object.keys(providers.profiles), ['codex', 'claude', 'gemini']);
    assert.equal(providers.live.length, 3);
    assert.equal(Object.hasOwn(providers, 'demo'), false);
    assert.equal(providers.learning.totalRuns, 0);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /TriAgent test/);
  });

  test('rejects invalid run requests', async () => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /prompt/i);
  });

  test('rejects demo mode instead of silently running fake providers', async () => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Tikra užduotis', mode: 'demo' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /live/i);
  });

  test('persists topic-isolated chats and includes only the current chat history in later turns', async () => {
    const createChat = async () => {
      const response = await fetch(`${baseUrl}/api/chats`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      assert.equal(response.status, 201);
      return response.json();
    };
    const sendMessage = async (chatId, prompt) => {
      const response = await fetch(`${baseUrl}/api/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      assert.equal(response.status, 202);
      const payload = await response.json();
      await waitForTerminalEvents(payload.runId);
      return payload;
    };

    const emptyList = await (await fetch(`${baseUrl}/api/chats`)).json();
    assert.deepEqual(emptyList.chats, []);

    const chatA = await createChat();
    const chatB = await createChat();
    assert.notEqual(chatA.chatId, chatB.chatId);
    assert.equal(chatA.title, 'Naujas pokalbis');

    const firstA = await sendMessage(chatA.chatId, 'A tema: sukurk puslapio struktūrą');
    const secondA = await sendMessage(chatA.chatId, 'Dabar pridėk kontaktų skiltį');
    const firstB = await sendMessage(chatB.chatId, 'B tema: suplanuok savaitę');

    const persistedA = await (await fetch(`${baseUrl}/api/chats/${chatA.chatId}`)).json();
    assert.equal(persistedA.messages.length, 4);
    assert.deepEqual(persistedA.messages.map((message) => message.role), [
      'user', 'assistant', 'user', 'assistant'
    ]);
    assert.equal(persistedA.messages[0].runId, firstA.runId);
    assert.equal(persistedA.messages[2].runId, secondA.runId);
    assert.equal(persistedA.messages[1].council.answer, 'Tikra live taryba paskirstė patikrinamus darbus.');
    assert.match(persistedA.title, /A tema/);

    const secondAProposal = providerCalls.find((call) => (
      call.runId === secondA.runId && call.phase === 'proposal' && call.agentId === 'codex'
    ));
    const firstBProposal = providerCalls.find((call) => (
      call.runId === firstB.runId && call.phase === 'proposal' && call.agentId === 'codex'
    ));
    assert.match(secondAProposal.contextCheckpoint, /A tema: sukurk puslapio struktūrą/);
    assert.match(secondAProposal.contextCheckpoint, /Tikra live taryba paskirstė patikrinamus darbus/);
    assert.doesNotMatch(firstBProposal.contextCheckpoint, /A tema|kontaktų skiltį/);

    const sortedList = await (await fetch(`${baseUrl}/api/chats`)).json();
    assert.equal(sortedList.chats[0].chatId, chatB.chatId);
    assert.equal(sortedList.chats[0].messageCount, 2);
  });

  test('starts a live-only council run and replays its append-only events', async () => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Sukurk puslapio planą' })
    });
    assert.equal(response.status, 202);
    const { runId, mode } = await response.json();
    assert.match(runId, /^run-[a-zA-Z0-9_-]+$/);
    assert.equal(mode, 'live');

    const events = await waitForTerminalEvents(runId);
    assert.equal(events[0].type, EVENT_TYPES.RUN_CREATED);
    assert.equal(events.filter((event) => event.type === EVENT_TYPES.PROPOSAL).length, 3);
    const delegation = events.find((event) => event.type === EVENT_TYPES.DELEGATION);
    const final = events.find((event) => event.type === EVENT_TYPES.FINAL);
    assert.equal(delegation.agentId, 'gemini');
    assert.equal(delegation.payload.conductorId, 'gemini');
    assert.equal(delegation.payload.assignments.length, 3);
    assert.equal(final.payload.decisionSource, 'gemini-conductor');
    assert.equal(final.payload.degraded, false);
    assert.equal(events.at(-1).type, EVENT_TYPES.RUN_COMPLETED);

    const replay = await (await fetch(`${baseUrl}/api/runs/${runId}/events`)).json();
    assert.deepEqual(replay.events, events);

    const learning = await (await fetch(`${baseUrl}/api/learning?taskClass=planning`)).json();
    assert.equal(learning.totalRuns, 1);
    assert.equal(learning.agents.codex.runs, 1);
  });

  test('streams existing run events over SSE through the terminal event', async () => {
    const start = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Pasitarimas' })
    });
    const { runId } = await start.json();
    await waitForTerminalEvents(runId);

    const response = await fetch(`${baseUrl}/api/runs/${runId}/stream`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const streamBody = await response.text();
    assert.match(streamBody, /event: triagent/);
    assert.match(streamBody, new RegExp(EVENT_TYPES.FINAL));
    assert.match(streamBody, new RegExp(EVENT_TYPES.RUN_COMPLETED));
  });

  test('does not expose files outside the configured web root', async () => {
    const response = await fetch(`${baseUrl}/..%2Fpackage.json`);
    assert.ok([400, 404].includes(response.status));
    assert.doesNotMatch(await response.text(), /triagent-core/);
  });
});
