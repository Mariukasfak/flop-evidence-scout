import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrCreateIdentity } from './identity.mjs';
import { TechnocoreClient } from './technocore-client.mjs';
import { Guardrails } from './guardrails.mjs';
import { ScoutEngine } from './scout-engine.mjs';
import { ScribeEngine } from './scribe-engine.mjs';
import { MailboxService } from './mailbox-service.mjs';
import { Lease, makeHolderId, DEFAULT_TTL_MS } from './lease.mjs';
import { TelemetryFeed } from './telemetry-feed.mjs';
import { updateDashboardFile } from './dashboard.mjs';
import { analyzeChatArchives, getLatestLearningReport } from './learning-engine.mjs';

/**
 * Every writable path the daemon owns, derived from one base directory.
 *
 * This exists because the same bug shipped three times: a hardcoded path let a
 * test run overwrite production state — the faucet alert, then the heartbeat,
 * then the telemetry feed, which recorded a room claim and a publication that
 * had only ever happened against a mock server. Deriving them all from dataDir
 * makes that impossible rather than merely fixed.
 */
export function deriveFrom(o) {
  const dataDir = o.dataDir || path.resolve('data');
  const docsDir = o.docsDir || 'docs';
  return {
    dataDir,
    docsDir,
    auditLogPath: o.auditLogPath || path.join(dataDir, 'scout-audit.jsonl'),
    faucetAlertPath: o.faucetAlertPath || path.join(dataDir, 'faucet-alert.json'),
    heartbeatPath: o.heartbeatPath || path.join(dataDir, 'scout-heartbeat.json'),
    feedStatePath: o.feedStatePath || path.join(dataDir, 'feed-state.json'),
    feedPath: o.feedPath || path.join(docsDir, 'feed.json'),
    chatArchiveDir: o.chatArchiveDir || path.join(dataDir, 'chats')
  };
}

function parseArgs(argv) {
  const options = {
    intervalMs: 60_000,
    dryRun: false,
    identityPath: path.resolve('.secrets/scout-identity.json'),
    scribeIdentityPath: path.resolve('.secrets/scribe-identity.json'),
    serverUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat',
    room: 'lobby',
    watchRooms: null,
    dataDir: path.resolve('data'),
    docsDir: 'docs'
  };



  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--interval-ms=')) options.intervalMs = Number(arg.slice(14)) || options.intervalMs;
    else if (arg === '--no-lease') options.lease = false;
    else if (arg.startsWith('--lease-name=')) options.leaseName = arg.slice(13);
    else if (arg.startsWith('--identity=')) options.identityPath = path.resolve(arg.slice(11));
    else if (arg.startsWith('--url=')) options.serverUrl = arg.slice(6);
    else if (arg.startsWith('--room=')) options.room = arg.slice(7);
    else if (arg.startsWith('--rooms=')) options.watchRooms = arg.slice(8).split(',').map((r) => r.trim()).filter(Boolean);
    else if (arg.startsWith('--docs-dir=')) options.docsDir = arg.slice(11);
    else if (arg.startsWith('--data-dir=')) options.dataDir = path.resolve(arg.slice(11));
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

export function archiveRoomMessages(room, messages = [], archiveDir = path.resolve('data/chats')) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const archivePath = path.join(archiveDir, `${room}-archive.jsonl`);
  try {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const existingSeqs = new Set();
    if (fs.existsSync(archivePath)) {
      const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try { const p = JSON.parse(l); if (p.seq) existingSeqs.add(p.seq); } catch {}
      }
    }
    const newLines = [];
    for (const m of messages) {
      if (m && m.seq && !existingSeqs.has(m.seq)) {
        newLines.push(JSON.stringify(m) + '\n');
        existingSeqs.add(m.seq);
      }
    }
    if (newLines.length > 0) {
      fs.appendFileSync(archivePath, newLines.join(''), 'utf8');
    }
  } catch (err) {
    console.warn(`[Archive Error] ${room}:`, err.message);
  }
}

export async function runScoutDaemon(options = {}) {
  const parsed = parseArgs(process.argv);
  const merged = { ...parsed, ...options };
  // Re-derive after the caller's overrides, so passing only dataDir moves
  // every output rather than just the ones the caller thought to name.
  const config = { ...merged, ...deriveFrom(merged) };
  
  // 1. Initialize Scout Agent (Agent #1)
  const scoutIdentity = loadOrCreateIdentity(config.identityPath, 'SCOUT_IDENTITY_JSON');
  console.log(`[Agent #1 - Scout] DID: ${scoutIdentity.did}`);

  // 2. Initialize Scribe Agent (Agent #2)
  const scribeIdentity = loadOrCreateIdentity(config.scribeIdentityPath, 'SCRIBE_IDENTITY_JSON');
  console.log(`[Agent #2 - Scribe] DID: ${scribeIdentity.did}`);

  const client = new TechnocoreClient({ baseUrl: config.serverUrl });
  const scoutGuardrails = new Guardrails({ maxPerHour: 2, minCooldownMs: 60_000 });
  const scribeGuardrails = new Guardrails({ maxPerHour: 2, minCooldownMs: 60_000 });

  const scoutEngine = new ScoutEngine({
    identity: scoutIdentity,
    scribeIdentity,
    client,
    guardrails: scoutGuardrails,
    ...(config.watchRooms ? { watchRooms: config.watchRooms } : {})
  });
  const scribeEngine = new ScribeEngine({ identity: scribeIdentity, scoutIdentity, client, guardrails: scribeGuardrails });

  // The DID note has advertised a mailbox from the start; this is what finally
  // reads it. Its own guardrails budget, so an inbound question cannot eat the
  // Scout's room budget and vice versa.
  const mailboxService = new MailboxService({
    identity: scoutIdentity,
    client,
    guardrails: new Guardrails({ maxPerHour: 2, minCooldownMs: 30_000 })
  });

  // A channel of our own. Measurements have been going into a web page nobody on
  // the network can read; an owned d- room is a publication the swarm cannot
  // flood, advertised free by its topic note in /rooms.
  const telemetryFeed = new TelemetryFeed({
    identity: scribeIdentity,
    client,
    statePath: config.feedStatePath,
    feedPath: config.feedPath
  });

  console.log(`[Dual Agent Mesh] Connected to: ${config.serverUrl} (Rooms: ${config.room} & events)`);

  let running = true;
  const stop = () => {
    if (!running) return;
    console.log('\n[Dual Agent Mesh] Shutting down gracefully...');
    running = false;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Configurable for the same reason auditLogPath and faucetAlertPath are: a test
  // run that writes into data/ leaves residue the published pages then report as
  // fact. That is exactly how a stale "faucet radar: HIT" reached the front page.
  const heartbeatPath = config.heartbeatPath;
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
        handledCount: scoutEngine.localState.handledCount || 0,
        coopSyncs: scribeEngine.localState.syncedWithScoutCount || 0,
        lastSeenSeq: lastResult.lastSeenSeq ?? scoutEngine.localState.lastSeenSeq,
        watchRooms: scoutEngine.watchRooms,
        faucetDiscovered: Boolean(scribeEngine.localState.faucetDiscovered),
        faucetHits: scribeEngine.localState.faucetHits || [],
        stateOk: !scoutEngine.lastStateError && !scribeEngine.lastStateError,
        stateError: scoutEngine.lastStateError || scribeEngine.lastStateError || null
      }, null, 2), 'utf8');
      
      // Auto-analyze chats and refresh dashboard
      analyzeChatArchives();
      await updateDashboardFile(config.docsDir || 'docs', config.serverUrl);
    } catch {
      // ignore
    }
  };

  appendAudit(config.auditLogPath, { event: 'startup', did: scoutIdentity.did, scribeDid: scribeIdentity.did, server: config.serverUrl });
  await writeHeartbeat('started');

  /**
   * Only one machine may speak as these identities at a time.
   *
   * Running here and in GitHub Actions together is worth doing — they fail for
   * unrelated reasons, so their combined uptime beats either — but two writers
   * sharing one did:key would read the same publication history, both decide the
   * gap had elapsed, and both post. That turns the project whose whole argument
   * is "we are not the agents spamming the lobby" into two of them.
   *
   * The workflow's `concurrency:` group cannot help: it serialises GitHub runs
   * against each other and cannot see a process on someone's desk. The lease is
   * a compare-and-set on a Technocore note, so it works across machines that
   * have no idea the other exists.
   *
   * Disable with --no-lease for a single-writer setup.
   */
  const useLease = config.lease !== false;
  const lease = useLease
    ? new Lease({
      client,
      name: config.leaseName || 'scout-cycle',
      holder: makeHolderId(process.env.LEASE_HOLDER || (process.env.CI === 'true' ? 'github' : 'local')),
      ttlMs: config.leaseTtlMs || DEFAULT_TTL_MS
    })
    : null;

  do {
    try {
      if (lease) {
        // Acquire covers all three cases: unheld, expired, and already ours.
        const attempt = await lease.acquire();
        if (!attempt.acquired) {
          // A blip and a genuine handover are different events and deserve
          // different words. Reporting an outage as "lost the race" sent the
          // first reader of this looking for a competing process that did not
          // exist. A blip also retries quickly rather than sitting out a whole
          // interval for no reason.
          if (attempt.transient) {
            console.log(`[Lease] Technocore unreachable — ${attempt.reason}. Retrying shortly.`);
          } else {
            console.log(`[Lease] Standing down — ${attempt.reason}.`);
          }
          appendAudit(config.auditLogPath, {
            event: attempt.transient ? 'lease_unreachable' : 'lease_declined',
            reason: attempt.reason,
            heldBy: attempt.heldBy ?? null
          });
          if (config.dryRun || !running) break;
          const wait = attempt.transient ? Math.min(15_000, config.intervalMs) : config.intervalMs;
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
      }

      // Step A: Scout Agent Turn (/r/lobby)
      const scoutResult = await scoutEngine.runTurn({ room: config.room });
      console.log(`[Scout #${scoutResult.turns}] Action: ${scoutResult.action} | Seq: ${scoutResult.lastSeenSeq}`);
      appendAudit(config.auditLogPath, { agent: 'scout', ...scoutResult });

      // Step D: publish a telemetry digest, but only when a figure has moved.
      try {
        const seriesPath = path.resolve('docs/measurements/timeseries.json');
        if (fs.existsSync(seriesPath)) {
          const series = JSON.parse(fs.readFileSync(seriesPath, 'utf8'));
          // The feed publishes five kinds of post, and four of them come from
          // work already done this cycle: what the source watch saw, what the
          // faucet radar saw, and what the learning pass measured.
          let sourceChange = null;
          const changePath = path.join(config.dataDir, 'source-change.json');
          if (fs.existsSync(changePath)) {
            try { sourceChange = JSON.parse(fs.readFileSync(changePath, 'utf8')); } catch { /* ignore */ }
          }

          const feedResult = await telemetryFeed.runTurn({
            observations: series.observations,
            caps: series.caps,
            sourceChange,
            faucetHits: scribeEngine.localState.faucetHits || [],
            learningReport: getLatestLearningReport()
          });
          console.log(`[Feed] ${feedResult.action} | ${feedResult.details?.reason || ''}`);
          appendAudit(config.auditLogPath, feedResult);
        }
      } catch (err) {
        console.warn('[Feed] skipped:', err.message);
      }

      // Archive every room the Scout actually works, not just the primary one.
      // Only lobby and events were being archived, so the learning pass could
      // only ever study the firehose the agent deliberately ignores — and never
      // the topical rooms where it does its work.
      for (const archiveRoom of new Set([config.room, ...scoutEngine.watchRooms])) {
        try {
          const data = await client.readRoom(archiveRoom, { limit: 25 });
          if (data.messages) archiveRoomMessages(archiveRoom, data.messages, config.chatArchiveDir);
        } catch { /* a room that cannot be read is not worth failing the cycle */ }
      }

      // Stagger 2s between agents to ensure clean separation
      await new Promise((r) => setTimeout(r, 2000));

      // Step B: Scribe Agent Turn (/r/events & Co-op Mesh)
      const scribeResult = await scribeEngine.runTurn();
      console.log(`[Scribe #${scribeResult.turns}] Action: ${scribeResult.action} | EventsSeq: ${scribeResult.lastEventsSeq}`);
      appendAudit(config.auditLogPath, { agent: 'scribe', ...scribeResult });

      // Step C: answer anything a stranger sent to our mailbox.
      const mailboxResult = await mailboxService.runTurn();
      console.log(`[Mailbox #${mailboxResult.turns}] Action: ${mailboxResult.action} | Inbound: ${mailboxResult.details?.inbound ?? 0}`);
      appendAudit(config.auditLogPath, mailboxResult);

      // Archive events messages if any
      try {
        const eventsData = await client.readRoom('events', { limit: 25 });
        if (eventsData.messages) archiveRoomMessages('events', eventsData.messages);
      } catch {}

      // A faucet room appearing is the one event worth waking a human for, so it
      // is written where the CI job can see it and raise a GitHub issue.
      if (Array.isArray(scribeResult.faucetAlerts) && scribeResult.faucetAlerts.length > 0) {
        try {
          const alertPath = config.faucetAlertPath;
          fs.mkdirSync(path.dirname(alertPath), { recursive: true });
          fs.writeFileSync(alertPath, JSON.stringify({
            detectedAt: new Date().toISOString(),
            rooms: scribeResult.faucetAlerts,
            eventsSeq: scribeResult.lastEventsSeq,
            note: 'Unverified: a room name is a string a stranger chose. Confirm against official Flop Labs channels before interacting.'
          }, null, 2), 'utf8');
          console.log('[FAUCET RADAR] Hit:', scribeResult.faucetAlerts.map((h) => h.room).join(', '));
        } catch (err) {
          console.warn('[FAUCET RADAR] Could not write alert file:', err.message);
        }
      }

      await writeHeartbeat('active', scoutResult);
    } catch (err) {
      console.error('[Mesh Error]:', err.message);
      appendAudit(config.auditLogPath, { event: 'error', error: err.message });
      await writeHeartbeat('error', { action: `error: ${err.message}` });
    }

    if (config.dryRun || !running) break;

    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  } while (running);

  // Hand the lease back rather than making the other machine wait out the TTL.
  if (lease) {
    try { await lease.release(); } catch { /* the expiry is the real mechanism */ }
  }

  // A scheduled tick is one process that starts and exits, so "shutdown" on every
  // cloud run read like a crash in the audit trail. Name the two cases apart.
  appendAudit(config.auditLogPath, {
    event: config.dryRun ? 'cycle_complete' : 'shutdown',
    did: scoutIdentity.did
  });
  await writeHeartbeat(config.dryRun ? 'cycle_complete' : 'stopped');
  console.log(config.dryRun ? '[Dual Agent Mesh] Cycle complete.' : '[Dual Agent Mesh] Stopped.');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runScoutDaemon().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
