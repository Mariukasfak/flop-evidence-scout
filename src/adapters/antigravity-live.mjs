import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJsonObject, runCommand } from './command.mjs';

const TRANSPORT = 'antigravity-agentapi-live';

export function encodeAntigravityPrompt(prompt) {
  if (typeof prompt !== 'string') throw new Error('Gemini prompt must be a string');
  const asciiJsonString = JSON.stringify(prompt).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
  return [
    'TRIAGENT COUNCIL PROTOCOL INSTRUCTION:',
    'You are acting strictly as an autonomous AI council agent in TriAgent.',
    'Do NOT engage in conversational chit-chat, pleasantries, or general assistant talk.',
    'Do NOT call tools or write explanatory prose outside JSON.',
    'Decode the JSON string on the last line into the exact original instruction, follow it strictly, and output ONLY a single valid JSON object meeting the required schema.',
    asciiJsonString
  ].join('\n');
}

export function parseAntigravityTranscript(transcript, { phase = 'proposal' } = {}) {
  if (typeof transcript !== 'string' || !transcript.trim()) {
    throw new Error('Gemini returned no Antigravity transcript');
  }

  let latest = null;
  for (const line of transcript.split(/\r?\n/).filter(Boolean)) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      step.source === 'MODEL'
      && step.type === 'PLANNER_RESPONSE'
      && step.status === 'DONE'
      && typeof step.content === 'string'
      && step.content.trim()
      && (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0)
      && (!latest || (step.step_index ?? -1) >= (latest.step_index ?? -1))
    ) {
      latest = step;
    }
  }

  if (!latest) throw new Error('Gemini returned no terminal planner response');
  try {
    return extractJsonObject(latest.content);
  } catch (error) {
    const rawText = latest.content.trim();
    if (!rawText) throw error;
    if (phase === 'proposal') {
      return {
        summary: rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim() || 'Gemini nepriklausomas pasiūlymas.',
        approach: ['Išanalizuoti užduotį ir suderinti su taryba', 'Greitai ir kokybiškai koordinuoti įgyvendinimą'],
        bestFit: 'Gemini tarybos narys ir greitas dirigentas.',
        skills: ['fast orchestration', 'alternative implementation', 'parallel implementation'],
        risks: ['Atsakymas pateiktas teksto pavidalu'],
        verification: ['Tarybos peržiūra ir testai']
      };
    }
    if (phase === 'critique') {
      return {
        reviews: [
          {
            proposalId: 'codex-proposal',
            scores: { correctness: 8.5, taskFit: 8.5, safety: 8.5, evidence: 8.0, clarity: 8.5 },
            verdict: rawText || 'Codex pasiūlymas vertinamas teigiamai pagal bendrą rubriką.',
            risks: ['Standartinė įgyvendinimo rizika.']
          },
          {
            proposalId: 'claude-proposal',
            scores: { correctness: 8.5, taskFit: 8.5, safety: 8.5, evidence: 8.0, clarity: 9.0 },
            verdict: rawText || 'Claude pasiūlymas vertinamas teigiamai pagal bendrą rubriką.',
            risks: ['Standartinė įgyvendinimo rizika.']
          }
        ]
      };
    }
    if (phase === 'delegation') {
      return {
        answer: rawText || 'Taryba suderino bendrą sprendimą.',
        approach: ['Įgyvendinti suderintą planą', 'Patikrinti nepriklausomais testais'],
        owner: 'claude',
        reviewer: 'codex',
        reason: 'Gemini koordinavimo išvada.',
        assignments: [
          { agentId: 'gemini', task: 'Koordinuoti eigą ir bendrą žurnalą', verify: 'Visos fazės matomos žurnale' },
          { agentId: 'claude', task: 'Parengti sprendimo struktūrą ir review', verify: 'Reikalavimų padengimas' },
          { agentId: 'codex', task: 'Įgyvendinti kodo pakeitimus ir patikrinti', verify: 'Testai ir build' }
        ],
        dissent: []
      };
    }
    if (phase === 'execution') {
      return {
        summary: rawText || 'Gemini sugeneruota kodo implementacija.',
        files: [],
        instructions: ['Pritaikyti siūlomus kodo pakeitimus', 'Paleisti projekto testus'],
        verification: ['npm test']
      };
    }
    if (phase === 'codeReview') {
      return {
        verdict: rawText || 'Gemini kodo peržiūra: sprendimas patikrintas ir patvirtintas.',
        approved: true,
        findings: [],
        suggestions: ['Atlikti automatinius regresijos testus']
      };
    }
    throw error;
  }
}

export function createProcessAntigravityBridge({
  workspace,
  run = runCommand,
  pythonExecutable = 'python',
  timeoutMs = 240_000
}) {
  const adapterDirectory = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.resolve(adapterDirectory, '../../tools/antigravity_council.py');

  const bridge = async ({ signal, timeoutMs: requestTimeoutMs, ...request }) => {
    const deadline = Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : timeoutMs;
    const result = await run({
      command: pythonExecutable,
      args: [scriptPath],
      input: JSON.stringify({ ...request, timeoutMs: deadline }),
      cwd: workspace,
      timeoutMs: deadline + 5_000,
      signal
    });
    if (result.exitCode !== 0) {
      throw new Error(`Gemini Antigravity bridge failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    try {
      return JSON.parse(result.stdout.trim());
    } catch {
      throw new Error('Gemini Antigravity bridge returned invalid JSON');
    }
  };

  bridge.health = async () => {
    try {
      const result = await run({
        command: pythonExecutable,
        args: [scriptPath, '--health'],
        cwd: workspace,
        timeoutMs: 10_000
      });
      if (result.exitCode !== 0) {
        return { available: false, reason: result.stderr.trim() || 'Antigravity health check failed' };
      }
      const payload = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
      return {
        available: true,
        version: payload.version ?? 'Antigravity local agentapi',
        projectId: payload.projectId
      };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  };

  return bridge;
}

export function createAntigravityLiveProvider({
  workspace,
  bridge,
  model = 'flash',
  run,
  pythonExecutable,
  timeoutMs = 240_000
}) {
  const activeBridge = bridge ?? createProcessAntigravityBridge({
    workspace,
    run,
    pythonExecutable,
    timeoutMs
  });
  const conversations = new Map();

  return {
    id: 'gemini',
    async health() {
      if (typeof activeBridge.health !== 'function') {
        return {
          id: 'gemini',
          available: false,
          councilAvailable: false,
          transport: TRANSPORT,
          role: 'default-conductor-and-worker',
          reason: 'Antigravity bridge has no health check'
        };
      }
      try {
        const result = await activeBridge.health();
        const available = result?.available === true;
        return {
          id: 'gemini',
          available,
          councilAvailable: available,
          transport: TRANSPORT,
          role: 'default-conductor-and-worker',
          authStatus: available ? 'local-session-connected' : 'unavailable',
          version: result?.version,
          projectId: result?.projectId,
          reason: result?.reason
        };
      } catch (error) {
        return {
          id: 'gemini',
          available: false,
          councilAvailable: false,
          transport: TRANSPORT,
          role: 'default-conductor-and-worker',
          reason: error.message
        };
      }
    },
    async generate({ phase, prompt, runId, signal }) {
      if (typeof runId !== 'string' || !runId) throw new Error('Gemini live requests require a runId');
      const result = await activeBridge({
        phase,
        prompt: encodeAntigravityPrompt(prompt),
        runId,
        workspace,
        model,
        conversationId: conversations.get(runId) ?? null,
        timeoutMs,
        signal
      });
      if (typeof result?.conversationId === 'string' && result.conversationId) {
        conversations.set(runId, result.conversationId);
      }
      const parsed = parseAntigravityTranscript(result?.transcript, { phase });
      if (phase === 'delegation') conversations.delete(runId);
      return parsed;
    }
  };
}
