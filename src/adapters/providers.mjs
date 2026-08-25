import fs from 'node:fs';
import path from 'node:path';

import { extractJsonObject, runCommand } from './command.mjs';
import { createAntigravityLiveProvider } from './antigravity-live.mjs';
import { PHASE_SCHEMAS } from '../core/council.mjs';

const ELIGIBLE_ROLES = Object.freeze(['proposer', 'critic', 'owner', 'reviewer', 'worker']);

export const AGENT_PROFILES = Object.freeze({
  codex: Object.freeze({
    name: 'Codex',
    role: 'Tarybos narys · programavimas ir patikra',
    strengths: ['codebase work', 'tests and verification', 'structured implementation'],
    eligibleRoles: ELIGIBLE_ROLES,
    defaultConductor: false,
    routingPreference: 'quality-and-verification',
    localPrior: 0.5,
    calibration: 'pending-local-evals'
  }),
  claude: Object.freeze({
    name: 'Claude',
    role: 'Tarybos narys · samprotavimas ir review',
    strengths: ['system reasoning', 'risk review', 'clear documentation'],
    eligibleRoles: ELIGIBLE_ROLES,
    defaultConductor: false,
    routingPreference: 'reasoning-and-review',
    localPrior: 0.5,
    calibration: 'pending-local-evals'
  }),
  gemini: Object.freeze({
    name: 'Gemini',
    role: 'Numatytasis dirigentas · tarybos narys · vykdytojas',
    strengths: ['fast orchestration', 'independent alternative', 'parallel implementation'],
    eligibleRoles: ELIGIBLE_ROLES,
    defaultConductor: true,
    routingPreference: 'fast-and-cost-efficient',
    localPrior: 0.5,
    calibration: 'pending-local-evals'
  })
});

function ensureSuccess(providerId, result) {
  if (result.exitCode !== 0) {
    let detail = result.stderr.trim();
    if (!detail && result.stdout.trim()) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (typeof parsed.result === 'string') detail = parsed.result;
      } catch {
        detail = result.stdout.trim().slice(0, 500);
      }
    }
    detail ||= `exit code ${result.exitCode}`;
    throw new Error(`${providerId} failed: ${detail}`);
  }
  return result.stdout;
}

export function parseCodexOutput(stdout) {
  const messages = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      messages.push(event.item.text);
    }
  }
  if (messages.length === 0) throw new Error('Codex returned no final agent message');
  return extractJsonObject(messages.at(-1));
}

export function parseClaudeOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new Error('Claude returned invalid JSON output');
  }
  if (envelope.structured_output && typeof envelope.structured_output === 'object') {
    return envelope.structured_output;
  }
  if (typeof envelope.result !== 'string') throw new Error('Claude returned no result');
  return extractJsonObject(envelope.result);
}

function unavailableProvider(id, transport, reason) {
  return {
    id,
    async health() {
      return { id, available: false, councilAvailable: false, transport, reason };
    },
    async generate() {
      throw new Error(`${id} is not available: ${reason}`);
    }
  };
}

async function versionHealth({ id, transport, executable, args, workspace, run }) {
  if (!executable) {
    return {
      id,
      available: false,
      councilAvailable: false,
      transport,
      reason: 'CLI executable not found',
      quota: { status: 'unavailable', label: 'CLI nerastas', actionHint: 'Įdiekite CLI įrankį.' }
    };
  }
  try {
    const result = await run({
      command: executable,
      args,
      cwd: workspace,
      timeoutMs: 5_000
    });
    const output = (result.stdout || result.stderr).trim();
    if (result.exitCode !== 0) {
      return {
        id,
        available: false,
        councilAvailable: false,
        transport,
        reason: output,
        quota: { status: 'auth_required', label: 'Reikia patikros / login', actionHint: output.slice(0, 100) }
      };
    }
    return {
      id,
      available: true,
      councilAvailable: true,
      transport,
      authStatus: 'unverified',
      version: output,
      quota: { status: 'ok', label: 'Aktyvus · Paruoštas' }
    };
  } catch (error) {
    return {
      id,
      available: false,
      councilAvailable: false,
      transport,
      reason: error.message,
      quota: { status: 'error', label: 'Klaida', actionHint: error.message }
    };
  }
}

export function createCodexProvider({ executable, workspace, run = runCommand, timeoutMs = 120_000 }) {
  if (!executable) return unavailableProvider('codex', 'codex-exec-jsonl', 'CLI executable not found');
  return {
    id: 'codex',
    health: () => versionHealth({
      id: 'codex',
      transport: 'codex-exec-jsonl',
      executable,
      args: ['--version'],
      workspace,
      run
    }),
    async generate({ prompt, signal }) {
      const result = await run({
        command: executable,
        args: [
          '-C', workspace,
          '-s', 'read-only',
          '-a', 'never',
          'exec',
          '--json',
          '--ephemeral',
          '-'
        ],
        input: prompt,
        cwd: workspace,
        timeoutMs,
        signal
      });
      return parseCodexOutput(ensureSuccess('codex', result));
    }
  };
}

export function createClaudeProvider({ executable, workspace, run = runCommand, timeoutMs = 240_000 }) {
  if (!executable) return unavailableProvider('claude', 'claude-print-json', 'CLI executable not found');
  return {
    id: 'claude',
    health: () => versionHealth({
      id: 'claude',
      transport: 'claude-print-json',
      executable,
      args: ['--version'],
      workspace,
      run
    }),
    async generate({ phase = 'proposal', prompt, signal }) {
      const schema = PHASE_SCHEMAS[phase] ?? PHASE_SCHEMAS.proposal;
      const result = await run({
        command: executable,
        args: [
          '-p',
          '--input-format', 'text',
          '--output-format', 'json',
          '--permission-mode', 'dontAsk',
          '--tools', '',
          '--no-session-persistence',
          '--json-schema', JSON.stringify(schema)
        ],
        input: prompt,
        cwd: workspace,
        timeoutMs,
        signal
      });
      return parseClaudeOutput(ensureSuccess('claude', result));
    }
  };
}

export function discoverExecutables(userProfile = process.env.USERPROFILE, appData = process.env.APPDATA) {
  const candidates = {
    codex: appData && path.join(
      appData,
      'npm', 'node_modules', '@openai', 'codex', 'node_modules',
      '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
    ),
    claude: appData && path.join(
      appData,
      'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'
    ),
    cgw: userProfile && path.join(userProfile, '.codex', 'bin', 'cgw.ps1')
  };
  return Object.fromEntries(Object.entries(candidates).map(([id, candidate]) => [
    id,
    candidate && fs.existsSync(candidate) ? candidate : null
  ]));
}

export function createLocalProviders({
  workspace,
  executables = discoverExecutables(),
  timeoutMs,
  antigravityBridge,
  geminiModel = 'flash'
} = {}) {
  return [
    createCodexProvider({ executable: executables.codex, workspace, timeoutMs }),
    createClaudeProvider({ executable: executables.claude, workspace, timeoutMs }),
    createAntigravityLiveProvider({
      workspace,
      bridge: antigravityBridge,
      model: geminiModel,
      timeoutMs
    })
  ];
}
