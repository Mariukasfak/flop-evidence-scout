import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrCreateIdentity } from './identity.mjs';
import { TechnocoreClient } from './technocore-client.mjs';
import { Guardrails } from './guardrails.mjs';
import { ScoutEngine } from './scout-engine.mjs';
import { ScribeEngine } from './scribe-engine.mjs';
import { updateDashboardFile } from './dashboard.mjs';

function parseArgs(argv) {
  const options = {
    intervalMs: 60_000,
    dryRun: false,
    identityPath: path.resolve('.secrets/scout-identity.json'),
    scribeIdentityPath: path.resolve('.secrets/scribe-identity.json'),
    serverUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat',
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
  
  // 1. Initialize Scout Agent (Agent #1)
  const scoutIdentity = loadOrCreateIdentity(config.identityPath, 'SCOUT_IDENTITY_JSON');
  console.log(`[Agent #1 - Scout] DID: ${scoutIdentity.did}`);

  // 2. Initialize Scribe Agent (Agent #2)
  const scribeIdentity = loadOrCreateIdentity(config.scribeIdentityPath, 'SCRIBE_IDENTITY_JSON');
  console.log(`[Agent #2 - Scribe] DID: ${scribeIdentity.did}`);

  const client = new TechnocoreClient({ baseUrl: config.serverUrl });
  const scoutGuardrails = new Guardrails({ maxPerHour: 2, minCooldownMs: 60_000 });
  const scribeGuardrails = new Guardrails({ maxPerHour: 2, minCooldownMs: 60_000 });

  const scoutEngine = new ScoutEngine({ identity: scoutIdentity, client, guardrails: scoutGuardrails });
  const scribeEngine = new ScribeEngine({ identity: scribeIdentity, scoutIdentity, client, guardrails: scribeGuardrails });

  console.log(`[Dual Agent Mesh] Connected to: ${config.serverUrl} (Rooms: ${config.room} & events)`);

  let running = true;
  const stop = () => {
    if (!running) return;
    console.log('\n[Dual Agent Mesh] Shutting down gracefully...');
    running = false;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const heartbeatPath = path.resolve('data/scout-heartbeat.json');
  const writeHeartbeat = async (status, lastResult = {}) => {
    try {
      fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
      fs.writeFileSync(heartbeatPath, JSON.stringify({
        status,
        did: scoutIdentity.did,
        scribeDid: scribeIdentity.did,
        serverUrl: config.serverUrl,
        room: config.room,
        intervalMs: config.intervalMs,
        lastHeartbeat: new Date().toISOString(),
        turns: lastResult.turns ?? scoutEngine.localState.totalTurns,
        lastAction: lastResult.action ?? status,
        handledCount: (scoutEngine.localState.handledCount || 0) + (scribeEngine.localState.syncedWithScoutCount || 0),
        lastSeenSeq: lastResult.lastSeenSeq ?? scoutEngine.localState.lastSeenSeq
      }, null, 2), 'utf8');
      await updateDashboardFile('docs', config.serverUrl);
    } catch {
      // ignore
    }
  };

  appendAudit(config.auditLogPath, { event: 'startup', did: scoutIdentity.did, scribeDid: scribeIdentity.did, server: config.serverUrl });
  await writeHeartbeat('started');

  do {
    try {
      // Step A: Scout Agent Turn (/r/lobby)
      const scoutResult = await scoutEngine.runTurn({ room: config.room });
      console.log(`[Scout #${scoutResult.turns}] Action: ${scoutResult.action} | Seq: ${scoutResult.lastSeenSeq}`);
      appendAudit(config.auditLogPath, { agent: 'scout', ...scoutResult });

      // Stagger 2s between agents to ensure clean separation
      await new Promise((r) => setTimeout(r, 2000));

      // Step B: Scribe Agent Turn (/r/events & Co-op Mesh)
      const scribeResult = await scribeEngine.runTurn();
      console.log(`[Scribe #${scribeResult.turns}] Action: ${scribeResult.action} | EventsSeq: ${scribeResult.lastEventsSeq}`);
      appendAudit(config.auditLogPath, { agent: 'scribe', ...scribeResult });

      await writeHeartbeat('active', scoutResult);
    } catch (err) {
      console.error('[Mesh Error]:', err.message);
      appendAudit(config.auditLogPath, { event: 'error', error: err.message });
      await writeHeartbeat('error', { action: `error: ${err.message}` });
    }

    if (config.dryRun || !running) break;

    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  } while (running);

  appendAudit(config.auditLogPath, { event: 'shutdown', did: scoutIdentity.did });
  await writeHeartbeat('stopped');
  console.log('[Dual Agent Mesh] Stopped.');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runScoutDaemon().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
