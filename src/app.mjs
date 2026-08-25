import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AGENT_PROFILES } from './adapters/providers.mjs';
import { ChatStore } from './core/chat-store.mjs';
import { EVENT_TYPES } from './core/contracts.mjs';
import { RunStore } from './core/run-store.mjs';
import { CouncilOrchestrator } from './orchestrator.mjs';

const TERMINAL_EVENTS = new Set([EVENT_TYPES.RUN_COMPLETED, EVENT_TYPES.RUN_FAILED]);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function readJson(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function createRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function compactCouncilAudit(events, finalPayload) {
  return {
    answer: finalPayload.answer,
    approach: finalPayload.approach,
    owner: finalPayload.owner,
    reviewer: finalPayload.reviewer,
    conductorId: finalPayload.conductorId,
    decisionSource: finalPayload.decisionSource,
    reason: finalPayload.reason,
    assignments: finalPayload.assignments,
    dissent: finalPayload.dissent,
    ranking: finalPayload.ranking,
    degraded: finalPayload.degraded,
    degradedReasons: finalPayload.degradedReasons,
    participantCoverage: finalPayload.participantCoverage,
    learning: finalPayload.learning,
    note: finalPayload.note,
    isCodeTask: finalPayload.isCodeTask,
    execution: finalPayload.execution,
    codeReview: finalPayload.codeReview,
    proposals: events
      .filter((event) => event.type === EVENT_TYPES.PROPOSAL)
      .map((event) => ({ agentId: event.agentId, ...event.payload })),
    critiques: events
      .filter((event) => event.type === EVENT_TYPES.CRITIQUE)
      .map((event) => ({ agentId: event.agentId, reviews: event.payload.reviews })),
    errors: events
      .filter((event) => event.type === EVENT_TYPES.ERROR)
      .map((event) => ({ agentId: event.agentId ?? null, ...event.payload }))
  };
}

function safeStaticPath(webRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = path.resolve(webRoot);
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

async function serveStatic(response, webRoot, pathname) {
  const filePath = safeStaticPath(webRoot, pathname);
  if (!filePath) {
    sendJson(response, 400, { error: 'Invalid path' });
    return;
  }

  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  const resolvedFile = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
  try {
    const body = await fs.promises.readFile(resolvedFile);
    response.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(resolvedFile).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function streamRunEvents(request, response, store, runId) {
  let lastSeq = Number(request.headers['last-event-id'] || 0);
  let closed = false;
  let interval;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    if (!response.writableEnded) response.end();
  };

  const flush = async () => {
    if (closed) return;
    try {
      const events = (await store.readEvents(runId)).filter((event) => event.seq > lastSeq);
      for (const event of events) {
        response.write(`id: ${event.seq}\nevent: triagent\ndata: ${JSON.stringify(event)}\n\n`);
        lastSeq = event.seq;
      }
      if (events.some((event) => TERMINAL_EVENTS.has(event.type))) close();
    } catch (error) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      close();
    }
  };

  request.on('close', close);
  interval = setInterval(flush, 150);
  interval.unref();
  void flush();
}

export function createTriAgentServer({
  dataRoot,
  webRoot,
  workspace,
  liveProviders,
  learningRegistry
}) {
  const store = new RunStore(dataRoot);
  const chatStore = new ChatStore(path.dirname(dataRoot));

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { name: 'TriAgent', status: 'ok', version: '0.1.0' });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/providers') {
      const live = await Promise.all(liveProviders.map((provider) => provider.health()));
      const learning = await learningRegistry.snapshot('general');
      const profiles = Object.fromEntries(Object.entries(AGENT_PROFILES).map(([agentId, profile]) => [
        agentId,
        {
          ...profile,
          localPrior: learning.agents[agentId]?.localPrior ?? 0.5,
          calibration: `triagent-local-runs:${learning.agents[agentId]?.runs ?? 0}`
        }
      ]));
      sendJson(response, 200, { profiles, live, learning });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/learning') {
      try {
        const taskClass = requestUrl.searchParams.get('taskClass') ?? 'general';
        sendJson(response, 200, await learningRegistry.snapshot(taskClass));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/scout/status') {
      try {
        const heartbeatFile = path.resolve(path.dirname(dataRoot), 'data/scout-heartbeat.json');
        const identityFile = path.resolve('.secrets/scout-identity.json');
        let heartbeat = null;
        let identity = null;

        if (fs.existsSync(heartbeatFile)) {
          heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
        }
        if (fs.existsSync(identityFile)) {
          const rawId = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
          identity = { did: rawId.did };
        }

        sendJson(response, 200, {
          agent: 'FLOP / Technocore Evidence Scout',
          status: heartbeat?.status ?? (identity ? 'configured' : 'not_configured'),
          identity,
          heartbeat
        });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/scout/logs') {
      try {
        const logFile = path.resolve(path.dirname(dataRoot), 'data/scout-audit.jsonl');
        const logs = [];
        if (fs.existsSync(logFile)) {
          const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
          for (const line of lines.slice(-50)) {
            try {
              logs.push(JSON.parse(line));
            } catch {
              // skip corrupted
            }
          }
        }
        sendJson(response, 200, { logs });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === 'GET' && pathname === '/api/chats') {
      try {
        sendJson(response, 200, { chats: await chatStore.listChats() });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/api/chats') {
      try {
        const body = await readJson(request);
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
          sendJson(response, 400, { error: 'Chat title must be a non-empty string' });
          return;
        }
        const chat = await chatStore.createChat({ title: body.title });
        sendJson(response, 201, chat);
      } catch (error) {
        if (!response.writableEnded) sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const chatMatch = pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)$/);
    if (request.method === 'GET' && chatMatch) {
      try {
        sendJson(response, 200, await chatStore.getChat(chatMatch[1]));
      } catch (error) {
        sendJson(response, /not found/i.test(error.message) ? 404 : 500, { error: error.message });
      }
      return;
    }

    const chatMessageMatch = pathname.match(/^\/api\/chats\/([a-zA-Z0-9_-]+)\/messages$/);
    if (request.method === 'POST' && chatMessageMatch) {
      try {
        const body = await readJson(request);
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
          sendJson(response, 400, { error: 'Prompt is required' });
          return;
        }

        const chatId = chatMessageMatch[1];
        const existingChat = await chatStore.getChat(chatId);
        const runId = createRunId();
        await chatStore.appendUserMessage(chatId, { content: body.prompt.trim(), runId });
        const orchestrator = new CouncilOrchestrator({
          store,
          providers: liveProviders,
          capabilityProfiles: AGENT_PROFILES,
          learningRegistry
        });
        const completion = orchestrator.run({
          runId,
          prompt: body.prompt,
          mode: 'live',
          conversationHistory: existingChat.messages,
          onFinal: async (finalPayload) => {
            const events = await store.readEvents(runId);
            await chatStore.appendAssistantMessage(chatId, {
              content: finalPayload.answer,
              runId,
              council: compactCouncilAudit(events, finalPayload)
            });
          }
        });
        completion.catch(async (error) => {
          try {
            const chat = await chatStore.getChat(chatId);
            if (!chat.messages.some((message) => message.role === 'assistant' && message.runId === runId)) {
              await chatStore.appendAssistantMessage(chatId, {
                content: `TriAgent užduoties užbaigti nepavyko: ${error.message}`,
                runId,
                council: { failed: true, error: error.message }
              });
            }
          } catch {
            // Run log remains the source of truth if chat persistence itself failed.
          }
        });
        sendJson(response, 202, { chatId, runId, mode: 'live' });
      } catch (error) {
        if (!response.writableEnded) {
          sendJson(response, /not found/i.test(error.message) ? 404 : 400, { error: error.message });
        }
      }
      return;
    }

    if (request.method === 'POST' && pathname === '/api/runs') {
      try {
        const body = await readJson(request);
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
          sendJson(response, 400, { error: 'Prompt is required' });
          return;
        }
        if (body.mode !== undefined && body.mode !== 'live') {
          sendJson(response, 400, { error: 'TriAgent is a live-only product' });
          return;
        }

        const runId = createRunId();
        const orchestrator = new CouncilOrchestrator({
          store,
          providers: liveProviders,
          capabilityProfiles: AGENT_PROFILES,
          learningRegistry
        });
        const completion = orchestrator.run({ runId, prompt: body.prompt, mode: 'live' });
        completion.catch(() => {});
        sendJson(response, 202, { runId, mode: 'live' });
      } catch (error) {
        if (!response.writableEnded) sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const eventMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/events$/);
    if (request.method === 'GET' && eventMatch) {
      try {
        sendJson(response, 200, { runId: eventMatch[1], events: await store.readEvents(eventMatch[1]) });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    const streamMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/stream$/);
    if (request.method === 'GET' && streamMatch) {
      streamRunEvents(request, response, store, streamMatch[1]);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'API route not found' });
      return;
    }

    await serveStatic(response, webRoot, pathname);
  });
}
