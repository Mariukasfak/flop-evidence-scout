import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrCreateIdentity } from './identity.mjs';
import { TechnocoreClient } from './technocore-client.mjs';
import { Guardrails } from './guardrails.mjs';
import { ScoutEngine } from './scout-engine.mjs';

function parseArgs(argv) {
  const options = {
    intervalMs: 60_000,
    dryRun: false,
    identityPath: path.resolve('.secrets/scout-identity.json'),
    serverUrl: process.env.TECHNOCORE_URL || 'http://localhost:8080',
    room: 'lobby',
    auditLogPath: path.resolve('data/scout-audit.jsonl')
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--interval-ms=')) options.intervalMs = Number(arg.slice(14)) || options.intervalMs;
    else if (arg.startsWith('--identity=')) options.identityPath = path.resolve(arg.slice(11));
    else if (arg.startsWith('--url=')) options.serverUrl = arg.slice(6);
    else if (arg.startsWith('--room=')) options.room = arg.slice(7);
  }

  return options;
}

function appendAudit(logPath, record) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

export async function runScoutDaemon(options = {}) {
  const config = { ...parseArgs(process.argv), ...options };
  console.log(`[FLOP Scout] Initializing identity at: ${config.identityPath}`);
  
  const identity = loadOrCreateIdentity(config.identityPath);
  console.log(`[FLOP Scout] DID: ${identity.did}`);

  const client = new TechnocoreClient({ baseUrl: config.serverUrl });
  const guardrails = new Guardrails();
  const engine = new ScoutEngine({ identity, client, guardrails });

  console.log(`[FLOP Scout] Connected to: ${config.serverUrl} (Room: ${config.room})`);

  let running = true;
  const stop = () => {
    if (!running) return;
    console.log('\n[FLOP Scout] Shutting down gracefully...');
    running = false;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const heartbeatPath = path.resolve('data/scout-heartbeat.json');
  const writeHeartbeat = (status, lastResult = {}) => {
    try {
      fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
      fs.writeFileSync(heartbeatPath, JSON.stringify({
        status,
        did: identity.did,
        serverUrl: config.serverUrl,
        room: config.room,
        intervalMs: config.intervalMs,
        lastHeartbeat: new Date().toISOString(),
        turns: lastResult.turns ?? engine.localState.totalTurns,
        lastAction: lastResult.action ?? status,
        handledCount: lastResult.handledCount ?? engine.localState.handledCount,
        lastSeenSeq: lastResult.lastSeenSeq ?? engine.localState.lastSeenSeq
      }, null, 2), 'utf8');
    } catch {
      // ignore
    }
  };

  appendAudit(config.auditLogPath, { event: 'startup', did: identity.did, server: config.serverUrl });
  writeHeartbeat('started');

  do {
    try {
      const result = await engine.runTurn({ room: config.room });
      console.log(`[FLOP Scout Turn ${result.turns}] Action: ${result.action} | LastSeq: ${result.lastSeenSeq}`);
      appendAudit(config.auditLogPath, { event: 'turn', ...result });
      writeHeartbeat('active', result);
    } catch (err) {
      console.error('[FLOP Scout Error]:', err.message);
      appendAudit(config.auditLogPath, { event: 'error', error: err.message });
      writeHeartbeat('error', { action: `error: ${err.message}` });
    }

    if (config.dryRun || !running) break;

    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  } while (running);

  appendAudit(config.auditLogPath, { event: 'shutdown', did: identity.did });
  writeHeartbeat('stopped');
  console.log('[FLOP Scout] Stopped.');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runScoutDaemon().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
