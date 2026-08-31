import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrCreateIdentity } from './identity.mjs';
import { TechnocoreClient, READ_WINDOW } from './technocore-client.mjs';
import { Guardrails } from './guardrails.mjs';
import { ScoutEngine } from './scout-engine.mjs';
import { ScribeEngine } from './scribe-engine.mjs';
import { MailboxService } from './mailbox-service.mjs';
import { Lease, makeHolderId, DEFAULT_TTL_MS } from './lease.mjs';
import { recordCycle } from './shared-state.mjs';
import { runBurst } from './workload-runner.mjs';
import { loadSeen, saveSeen, trimSeen } from './seen-work.mjs';
import { compactIfLarge } from './inference-ledger.mjs';
import { selectBackend } from './inference-backends.mjs';
import { TelemetryFeed } from './telemetry-feed.mjs';
import { FACTS } from './flop-facts.mjs';
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

export function parseArgs(argv) {
  const options = {
    intervalMs: 60_000,
    dryRun: false,
    /**
     * One real cycle, then exit. This is what a scheduled cloud run needs.
     *
     * The cloud workflow ran `--dry-run`, and dryRun implies readOnly, so every
     * scheduled run did exactly zero writes: it could not take the lease, could
     * not post, could not record a cycle. The failover the launcher and the
     * documentation both promised had never once happened, which is the whole
     * explanation for a 21-hour outage that no second machine covered.
     *
     * `--dry-run` keeps its meaning — a rehearsal that writes nothing. `--once`
     * is the opposite: a genuine cycle that happens to be the only one.
     */
    once: false,
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
    else if (arg === '--once') options.once = true;
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

/** The watcher's finding, if there is one waiting. */
function readSourceChange(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'source-change.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The DID population series, for the task that explains what it is doing.
 *
 * Committed to the repository rather than written per-run, so it is the same
 * series on both machines and a cloud run explains the same numbers a local one
 * would. Missing or unreadable simply means there is nothing to explain yet.
 */
function readMeasurements() {
  try {
    const series = JSON.parse(fs.readFileSync(path.resolve('docs/measurements/timeseries.json'), 'utf8'));
    return Array.isArray(series.observations) ? series.observations : [];
  } catch {
    return [];
  }
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

/**
 * Seqs already archived per room, and the byte offset they were read up to.
 *
 * The duplicate check used to re-read and re-parse the entire archive on every
 * append — the same O(n²) shape that was costing the inference ledger 1.2 s a
 * cycle, in a second file. Measured here at 31 ms per append on a 2.8 MB
 * archive, across six watched rooms, every cycle, growing with the archive.
 */
const archiveIndex = new Map();

/** Forget every cached archive index. Tests write archives behind our back. */
export function resetArchiveIndex() {
  archiveIndex.clear();
}

/**
 * Keep the archive useful without keeping it forever.
 *
 * These are a learning corpus, not a record of anything: the template analysis
 * wants a representative sample of how rooms talk, and the ten-thousandth copy
 * of "gm" teaches it nothing the first thousand did not. Left alone they reached
 * 17 MB across six rooms and every cycle re-read all of it twice — once to
 * archive, once to analyse.
 *
 * Trimming keeps the NEWEST lines, because room language drifts and a stale
 * corpus describes a room that no longer exists.
 */
export const ARCHIVE_MAX_BYTES = 3 * 1024 * 1024;

export function trimArchive(archivePath, { maxBytes = ARCHIVE_MAX_BYTES } = {}) {
  if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size <= maxBytes) {
    return { trimmed: false };
  }
  const lines = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);
  // Halve rather than trim to the line: trimming to the cap would re-trim on
  // the very next append, which is the cost this exists to avoid.
  const kept = lines.slice(Math.floor(lines.length / 2));
  const temp = `${archivePath}.trimming`;
  fs.writeFileSync(temp, kept.join('\n') + '\n', 'utf8');
  fs.renameSync(temp, archivePath);
  archiveIndex.delete(path.resolve(archivePath));
  return { trimmed: true, dropped: lines.length - kept.length, kept: kept.length };
}

export function archiveRoomMessages(room, messages = [], archiveDir = path.resolve('data/chats')) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const archivePath = path.join(archiveDir, `${room}-archive.jsonl`);
  try {
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });

    const key = path.resolve(archivePath);
    let entry = archiveIndex.get(key);
    const size = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;

    // A shrunken file was trimmed or replaced, so the index is rebuilt rather
    // than trusted — a stale index would silently drop new messages as dupes.
    if (!entry || size < entry.offset) {
      entry = { offset: 0, seqs: new Set() };
      archiveIndex.set(key, entry);
    }
    if (size > entry.offset) {
      const fd = fs.openSync(archivePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(size - entry.offset);
        fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const p = JSON.parse(line); if (p.seq) entry.seqs.add(p.seq); } catch { /* torn line */ }
        }
      } finally {
        fs.closeSync(fd);
      }
      entry.offset = size;
    }

    const newLines = [];
    for (const m of messages) {
      if (m && m.seq && !entry.seqs.has(m.seq)) {
        newLines.push(JSON.stringify(m) + '\n');
        entry.seqs.add(m.seq);
      }
    }
    if (newLines.length > 0) {
      const payload = newLines.join('');
      fs.appendFileSync(archivePath, payload, 'utf8');
      entry.offset += Buffer.byteLength(payload, 'utf8');
    }

    trimArchive(archivePath);
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

  /**
   * --dry-run carries two meanings that were quietly one: stop after a cycle,
   * and write nothing. It only ever did the first, so a dry run posted signed
   * messages to the live lobby exactly as a real run did.
   *
   * They are separate options now, and readOnly follows dryRun unless a caller
   * says otherwise — the CLI flag does the safe thing, while a test driving a
   * single cycle against its own mock server can still exercise the write path
   * by asking for it explicitly.
   */
  const readOnly = config.readOnly ?? config.dryRun;
  const client = new TechnocoreClient({ baseUrl: config.serverUrl, readOnly });
  if (readOnly) console.log('[Dry Run] Reads only — every write will be refused.');
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
    guardrails: new Guardrails({ maxPerHour: 2, minCooldownMs: 30_000 }),
    // Naming the peer is what turns a refused stranger into an acknowledged
    // exchange. Without it the Scribe's six-hourly sync reached the reply gate,
    // was correctly judged not to be a question, and was dropped.
    peerDid: scribeIdentity.did
  });

  // A channel of our own. Measurements have been going into a web page nobody on
  // the network can read; an owned d- room is a publication the swarm cannot
  // flood, advertised free by its topic note in /rooms.
  const telemetryFeed = new TelemetryFeed({
    identity: scribeIdentity,
    client,
    statePath: config.feedStatePath,
    feedPath: config.feedPath,
    dryRun: config.dryRun
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
  /** The corpus analysis runs on this clock rather than every cycle. */
  const ANALYSIS_INTERVAL_MS = 30 * 60 * 1000;
  let lastAnalysisAt = 0;
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
      
      /**
       * Re-analyse the corpus on a clock, not on every cycle.
       *
       * It costs 140-190 ms and re-reads every archive. It feeds one thing: the
       * feed's "where the signal is" post, which has a twelve-hour minimum gap.
       * Running it sixty times an hour to supply a post made twice a day was
       * pure overhead, and the report is written to a file that
       * getLatestLearningReport reads independently — so a slightly older
       * report costs nothing.
       */
      const sinceAnalysis = Date.now() - lastAnalysisAt;
      if (sinceAnalysis > ANALYSIS_INTERVAL_MS) {
        lastAnalysisAt = Date.now();
        /**
         * Told where the archives are, and whose messages are ours.
         *
         * Called bare, this read learning-engine's own default of data/chats
         * while the six topical rooms had been archiving to dataDir/chats for
         * three days. So the pass that decides "what should we have answered?"
         * was studying the /r/events firehose — the one room the agent
         * deliberately ignores — plus a frozen snapshot of everything else.
         * It reported a healthy 12,032-message corpus throughout, which is why
         * nothing looked wrong.
         *
         * Without selfDid it also counted our own posts as other people's.
         */
        analyzeChatArchives({ archiveDir: config.chatArchiveDir, selfDid: scoutIdentity.did });
      }
      await updateDashboardFile(config.docsDir || 'docs', config.serverUrl, config.dataDir);
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
  // Named once so the lease and the shared activity record agree on who we are.
  const holderId = makeHolderId(process.env.LEASE_HOLDER || (process.env.CI === 'true' ? 'github' : 'local'));

  /**
   * The lease only has to outlive a missed renewal, not a coffee break.
   *
   * A flat ten minutes meant that closing one window and opening another left
   * the new process standing down for up to ten minutes against a holder that no
   * longer existed — a graceful shutdown releases the lease, but a killed window
   * cannot. Three cycles is enough slack to survive a slow cycle or a blip, and
   * it makes a dead holder clear in minutes instead of tens of them.
   */
  const leaseTtl = Math.min(10 * 60_000, Math.max(2 * 60_000, config.intervalMs * 3));

  /**
   * Work already done, so a cycle does not redo the previous one's.
   *
   * A room read returns mostly what it returned a minute ago, so without this the
   * planner produced the same twenty classifications every cycle — visible in the
   * log as an unvarying "20/20 sessions", forever. Harmless while a session is
   * free; the moment one costs $FLOP it is spending the airdrop budget to
   * re-answer questions already answered.
   *
   * Bounded, because an unbounded set in a process meant to run for months is a
   * leak. The oldest keys fall out first and the worst case is that a very old
   * message gets classified a second time.
   *
   * Loaded from disk, because it used to be memory-only and a restart therefore
   * wiped the whole history — seven restarts in one day of audit log, each one
   * quietly re-doing everything the next room read returned.
   */
  /** Tracks the backend across cycles so a downgrade is announced once, not endlessly. */
  let lastBackendWasReal = null;
  const seenWorkPath = path.join(config.dataDir, 'seen-work.json');
  const seenWork = loadSeen(seenWorkPath);
  if (seenWork.size > 0) console.log(`[Work] Resuming with ${seenWork.size} jobs already done.`);

  const useLease = config.lease !== false;
  const lease = useLease
    ? new Lease({
      client,
      name: config.leaseName || 'scout-cycle',
      holder: holderId,
      ttlMs: config.leaseTtlMs || leaseTtl
    })
    : null;

  do {
    /**
     * The top of the cycle, held outside the try so the sleep below can subtract
     * the work from the interval rather than adding to it.
     */
    const cycleTop = Date.now();
    try {
      if (lease) {
        // Acquire covers all three cases: unheld, expired, and already ours.
        const attempt = await lease.acquire();
        if (attempt.acquired && attempt.degraded) {
          // Working on trust rather than on a fresh read. Recorded, because
          // "we kept going" and "we confirmed we could" are different facts and
          // the audit trail should never blur them.
          console.log(`[Lease] ${attempt.reason}`);
          appendAudit(config.auditLogPath, { event: 'lease_degraded', reason: attempt.reason });
        }
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
          // A scheduled run that does not get the lease has nothing to do:
          // the holder is working. Waiting out an interval would just burn
          // runner minutes to arrive at the same answer.
          if (config.dryRun || config.once || !running) break;
          const wait = attempt.transient ? Math.min(15_000, config.intervalMs) : config.intervalMs;
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
      }

      /**
       * Cycle timing, measured rather than assumed.
       *
       * Two O(n-squared) re-reads hid in this loop for weeks — the inference
       * ledger and the chat archive — and neither showed up as an error. A
       * number printed every cycle is what turns that class of problem from an
       * archaeology exercise into something visible the day it starts.
       */
      const cycleStartedAt = Date.now();

      /**
       * A stopwatch per step, because "everything else" is not a diagnosis.
       *
       * Splitting the cycle into inference and remainder answered "is the model
       * the bottleneck?" — it was not — and then stopped being useful. Reading
       * the six rooms in parallel was supposed to take seven seconds off the
       * remainder and visibly did not, which means the remainder was never
       * mostly room reads and one more guess would have been one too many.
       */
      const steps = {};
      const timed = async (name, fn) => {
        const at = Date.now();
        try { return await fn(); } finally { steps[name] = Date.now() - at; }
      };

      // Step A: Scout Agent Turn (/r/lobby)
      const scoutResult = await timed('scout', () => scoutEngine.runTurn({ room: config.room }));
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

          const feedResult = await timed('feed', () => telemetryFeed.runTurn({
            observations: series.observations,
            caps: series.caps,
            sourceChange,
            faucetHits: scribeEngine.localState.faucetHits || [],
            learningReport: getLatestLearningReport()
          }));
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
      //
      // Read together, written in order.
      //
      // These six reads are independent — nothing in one informs the next — but
      // they ran one after another, and Technocore answers a room read in
      // roughly a second. Measured: 9.5s serial against 2.4s in parallel, out of
      // a 47s cycle. That time was not idle in a harmless way; the inference
      // burst runs on whatever is left before the deadline, so it was coming
      // straight out of the sessions that produce the evidence.
      //
      // The archiving stays sequential and in a fixed room order so the audit
      // trail does not reshuffle itself run to run for no reason.
      const recentMessages = [];
      const archiveRooms = [...new Set([config.room, ...scoutEngine.watchRooms])];
      const reads = await timed('rooms', () => Promise.all(archiveRooms.map((archiveRoom) =>
        // A room that cannot be read is not worth failing the cycle over, and
        // one failure must not cancel the other five reads — hence a resolved
        // null rather than a rejection.
        client.readRoom(archiveRoom, { limit: READ_WINDOW }).catch(() => null))));

      for (const [i, data] of reads.entries()) {
        const archiveRoom = archiveRooms[i];
        if (!data?.messages) continue;
        archiveRoomMessages(archiveRoom, data.messages, config.chatArchiveDir);
        // Collected as they are archived rather than re-fetched. The
        // inference workload wants exactly the messages this cycle just
        // read, and reading them again would spend read budget to learn
        // nothing new.
        for (const m of data.messages) {
          const text = m?.content || m?.text;
          if (text) recentMessages.push({ room: archiveRoom, text });
        }
      }

      // Stagger 2s between agents to ensure clean separation
      await new Promise((r) => setTimeout(r, 2000));

      // Step B: Scribe Agent Turn (/r/events & Co-op Mesh)
      const scribeResult = await timed('scribe', () => scribeEngine.runTurn());
      console.log(`[Scribe #${scribeResult.turns}] Action: ${scribeResult.action} | EventsSeq: ${scribeResult.lastEventsSeq}`);
      appendAudit(config.auditLogPath, { agent: 'scribe', ...scribeResult });

      // Step C: answer anything a stranger sent to our mailbox.
      const mailboxResult = await timed('mailbox', () => mailboxService.runTurn());
      // Questions a stranger actually asked, for the workload to draft answers to.
      const pendingQuestions = Array.isArray(mailboxResult.questions) ? mailboxResult.questions : [];
      console.log(`[Mailbox #${mailboxResult.turns}] Action: ${mailboxResult.action} | Inbound: ${mailboxResult.details?.inbound ?? 0}`);
      appendAudit(config.auditLogPath, mailboxResult);

      // Archive events messages if any
      try {
        const eventsData = await timed('events', () => client.readRoom('events', { limit: READ_WINDOW }));
        // The archive directory is not optional here. Left to its default this
        // one call wrote events into data/chats while every other room went to
        // dataDir/chats, splitting the corpus in two.
        if (eventsData.messages) archiveRoomMessages('events', eventsData.messages, config.chatArchiveDir);
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

      // Step D: the inference workload. This is the activity the airdrop is
      // actually scored on, and until now the runner existed without ever being
      // called. The deadline keeps a slow model from eating the whole cycle.
      let work = { genuineSessions: 0, genuineSpend: 0, completed: 0 };
      const ledgerPath = path.join(config.dataDir, 'inference-receipts.jsonl');
      try {
        const { backend, real } = await selectBackend({});
        /**
         * Say it out loud when the model is gone.
         *
         * Falling back to the simulator is silent by design — nothing errors, the
         * cycle completes, sessions are counted. But a simulated receipt can
         * never be evidence, so an agent quietly running on it is doing work
         * that scores zero, indefinitely. Ollama does not start with Windows, so
         * one reboot is all it takes.
         *
         * Announced on the transition rather than every cycle: a warning that
         * repeats sixty times an hour is one nobody reads.
         */
        if (real !== lastBackendWasReal) {
          console.log(real
            ? `[Work] Real model reachable again — ${backend.id}${backend.model ? ` (${backend.model})` : ''}.`
            : '[Work] NO REAL MODEL — falling back to the simulator. These sessions count for nothing. '
              + 'Start Ollama, or set an inference API key.');
          lastBackendWasReal = real;
        }
        work = await runBurst({
          /**
           * All four sources of work, not just the one.
           *
           * The planner reads five task kinds and only ever received messages to
           * classify, so 10,792 of 10,792 receipts on disk were one task —
           * measurable proof that three capabilities were built, tested and then
           * never handed an input. The series and the questions were already in
           * scope here; nothing was missing but the wiring.
           */
          state: {
            unclassified: recentMessages,
            sourceChange: readSourceChange(config.dataDir),
            measurements: readMeasurements(),
            pendingQuestions: pendingQuestions.map((q) => ({ text: q.text, facts: FACTS }))
          },
          seen: seenWork,
          backend,
          identity: scoutIdentity,
          deadlineMs: Math.max(20_000, Math.floor(config.intervalMs * 0.4)),
          ledgerPath
        });
        trimSeen(seenWork);
        saveSeen(seenWork, seenWorkPath);
        if (work.scheduled > 0) {
          const kinds = Object.entries(work.byTask || {}).map(([t, n]) => `${t}×${n}`).join(' ');
          console.log(`[Work] ${work.completed}/${work.scheduled} sessions | genuine: ${work.genuineSessions} | ${kinds || work.stoppedBecause}`);
        }
      } catch (err) {
        console.log(`[Work] Skipped — ${err.message}`);
      }

      /**
       * Keep the ledger from strangling the work it exists to record.
       *
       * Every receipt so far is simulated, and a simulated receipt can never be
       * evidence — yet they accumulated at 8 MB a day and the duplicate check
       * re-read all of it on every append. Left alone, that check would have
       * consumed the entire per-cycle inference deadline within about three
       * weeks. Genuine receipts are never dropped; only the rehearsal tail is.
       */
      try {
        const compaction = compactIfLarge(ledgerPath);
        if (compaction.compacted) {
          console.log(`[Ledger] Compacted — ${compaction.dropped} rehearsal receipts dropped, ${compaction.kept} kept. No evidence discarded.`);
        }
      } catch (err) {
        console.log(`[Ledger] Compaction skipped — ${err.message}`);
      }

      // The shared record is the only place both machines' work adds up. Local
      // runs write to data/local and cloud runs are destroyed after the job, so
      // without this the combined picture exists nowhere.
      //
      // Best-effort: failing to record a cycle must never fail the cycle.
      try {
        const recorded = await recordCycle(client, scoutIdentity.did, {
          holder: holderId,
          // The delta for THIS cycle. Recording a running total would compound
          // every cycle into the shared sum.
          sessions: work.genuineSessions,
          spendFlop: work.genuineSpend
        });
        if (!recorded.recorded) console.log(`[Activity] Not recorded — ${recorded.reason}`);
      } catch (err) {
        console.log(`[Activity] Not recorded — ${err.message}`);
      }

      const cycleMs = Date.now() - cycleStartedAt;
      if (cycleMs > config.intervalMs * 0.75) {
        console.log(`[Cycle] ${(cycleMs / 1000).toFixed(1)}s of a ${(config.intervalMs / 1000).toFixed(0)}s interval — the loop is falling behind.`);
      }
      /**
       * Split the cycle into the inference and everything else.
       *
       * A single total cannot answer "is the model the bottleneck, or are we?"
       * — and that is the only question worth asking of a loop that now spends
       * real seconds on a real model. `workMs` is what the burst took; the
       * remainder is network round-trips, state writes and the dashboard.
       */
      appendAudit(config.auditLogPath, {
        event: 'cycle_timing',
        cycleMs,
        workMs: work.elapsedMs ?? 0,
        otherMs: cycleMs - (work.elapsedMs ?? 0),
        sessions: work.completed ?? 0,
        planned: work.planned ?? 0,
        intervalMs: config.intervalMs,
        steps
      });

      await writeHeartbeat('active', scoutResult);
    } catch (err) {
      console.error('[Mesh Error]:', err.message);
      appendAudit(config.auditLogPath, { event: 'error', error: err.message });
      await writeHeartbeat('error', { action: `error: ${err.message}` });
    }

    if (config.dryRun || config.once || !running) break;

    /**
     * Sleep the REMAINDER of the interval, not the whole of it.
     *
     * This slept a full intervalMs after the cycle finished, which made the real
     * period cycle + interval rather than interval. It cost almost nothing while
     * a cycle took 7 s against a simulated backend. With a real model a cycle
     * takes ~52 s, so the period had silently become 112 s — the agent was idle
     * for 60 s out of every 112 while every duty-cycle metric reported it as
     * keeping up perfectly.
     *
     * A floor rather than zero: a cycle that overruns the interval must not spin
     * straight into the next one, both to stay polite to a shared server and to
     * leave the log readable when something is wrong.
     */
    const MIN_GAP_MS = 5_000;
    const elapsed = Date.now() - cycleTop;
    await new Promise((resolve) => setTimeout(resolve, Math.max(MIN_GAP_MS, config.intervalMs - elapsed)));
  } while (running);

  // Hand the lease back rather than making the other machine wait out the TTL.
  if (lease) {
    try { await lease.release(); } catch { /* the expiry is the real mechanism */ }
  }

  // A scheduled tick is one process that starts and exits, so "shutdown" on every
  // cloud run read like a crash in the audit trail. Name the two cases apart.
  appendAudit(config.auditLogPath, {
    event: (config.dryRun || config.once) ? 'cycle_complete' : 'shutdown',
    did: scoutIdentity.did
  });
  await writeHeartbeat((config.dryRun || config.once) ? 'cycle_complete' : 'stopped');
  console.log((config.dryRun || config.once) ? '[Dual Agent Mesh] Cycle complete.' : '[Dual Agent Mesh] Stopped.');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runScoutDaemon().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
