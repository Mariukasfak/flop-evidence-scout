import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOrCreateIdentity } from './identity.mjs';
import { TechnocoreClient, READ_WINDOW } from './technocore-client.mjs';
import { Guardrails } from './guardrails.mjs';
import { ScoutEngine } from './scout-engine.mjs';
import { ScribeEngine } from './scribe-engine.mjs';
import { KibbleEngine } from './kibble-engine.mjs';
import { MailboxService } from './mailbox-service.mjs';
import { Lease, makeHolderId, DEFAULT_TTL_MS } from './lease.mjs';
import { recordCycle } from './shared-state.mjs';
import { runBurst } from './workload-runner.mjs';
import { loadSeen, saveSeen, trimSeen } from './seen-work.mjs';
import { compactIfLarge } from './inference-ledger.mjs';
import { selectBackend, apiBackend } from './inference-backends.mjs';
import { TelemetryFeed } from './telemetry-feed.mjs';
import { FACTS } from './flop-facts.mjs';
import { updateDashboardFile } from './dashboard.mjs';
import { analyzeChatArchives, getLatestLearningReport } from './learning-engine.mjs';
import { sayOnce, clearOnce } from './log-once.mjs';
import { checkOneSurface } from './surface-watch.mjs';
import { OFFER_ROOM as TCLK_OFFER_ROOM } from './tclk.mjs';
import { TclkEngine } from './tclk-engine.mjs';
import { TclkPayer } from './tclk-payer.mjs';
import { QUESTION_BANK } from './kibble-jobs.mjs';
import { mirrorConsole } from './console-mirror.mjs';

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
    surfaceStatePath: o.surfaceStatePath || path.join(dataDir, 'surface-state.json'),
    tclkStatePath: o.tclkStatePath || path.join(dataDir, 'tclk-state.json'),
    tclkPayerStatePath: o.tclkPayerStatePath || path.join(dataDir, 'tclk-payer-state.json'),
    kibblePairsPath: o.kibblePairsPath || path.join(dataDir, 'kibble-useful-pairs.json'),
    roomBudgetPath: o.roomBudgetPath || path.join(dataDir, 'room-budget.json'),
    payerRepPath: o.payerRepPath || path.join(dataDir, 'tclk-payers.json'),
    consoleLogPath: o.consoleLogPath || path.join(dataDir, 'daemon-console.log'),
    heartbeatPath: o.heartbeatPath || path.join(dataDir, 'scout-heartbeat.json'),
    feedStatePath: o.feedStatePath || path.join(dataDir, 'feed-state.json'),
    feedPath: o.feedPath || path.join(docsDir, 'feed.json'),
    chatArchiveDir: o.chatArchiveDir || path.join(dataDir, 'chats')
  };
}

export function parseArgs(argv) {
  const options = {
    intervalMs: 60_000,
    /** Null means "take the interval-proportional share", which is the old behaviour. */
    workDeadlineMs: null,
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
    /**
     * How long the inference burst may run, when the machine cannot afford the
     * default share of the interval.
     *
     * Measured on the Helsinki box 2026-09-04, over its own receipts only:
     * classify-message took 40% of all inference time to read 187 tokens and
     * write 6 — bookkeeping — while the kibble lanes that carry the score
     * queued behind it. A controlled request of that size answers in 2.1s and
     * the median under load was 6.8s, so two thirds of the wait was the queue,
     * not the work. On two shared vCPUs the burst is what to shrink: it is the
     * one consumer whose output nobody outside this repository reads.
     *
     * Unset, nothing changes — the PC keeps the interval-proportional default.
     */
    else if (arg.startsWith('--work-deadline-ms=')) options.workDeadlineMs = Number(arg.slice(19)) || null;
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

/**
 * The commit this checkout is currently on, or null.
 *
 * Exported and given a directory so it can be tested, because the version that
 * lived inline read HEAD three times in one expression and nothing checked it.
 * A daemon that silently never notices new code looks exactly like a daemon
 * that never needs to, and this whole mechanism exists to stop that.
 *
 * null means "no answer" and never "restart": a detached checkout, a repo mid
 * write, a packed ref we cannot resolve, or no .git at all are all reasons to
 * carry on rather than to stand down.
 */
/**
 * What an unsuccessful lease attempt means for this cycle.
 *
 * Three outcomes, and for a long time there were two. A lease we could not
 * reach was treated exactly like a lease somebody else was holding: skip the
 * cycle, sleep, try again. On 2026-09-01 technocore.chat returned Cloudflare
 * 1033 for half an hour and this agent logged `lease_unreachable` 94 times and
 * ran zero cycles — the second time an outage has stranded it.
 *
 * They are not the same event. A lease held by somebody else means another
 * writer is working and a second one would collide. A lease we cannot reach
 * means the server is down, and the lease lives on that same server: nobody
 * can write, including whoever we would have collided with. Standing down
 * protects nothing and costs everything local — the archive, the dashboard,
 * the learning pass, and most of all the surface watcher, which goes blind
 * through exactly the window where a redeploy might publish a new route.
 *
 * So an unreachable lease runs the cycle with writes refused. The mutual
 * exclusion guarantee is untouched: a write still requires a lease we hold.
 */
export function leaseOutcome(attempt) {
  if (attempt?.acquired) return 'proceed';
  return attempt?.transient ? 'proceed_readonly' : 'stand_down';
}

export function readGitHead(repoDir = process.cwd()) {
  try {
    const head = fs.readFileSync(path.join(repoDir, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head || null;      // detached: HEAD is the sha
    const ref = head.slice(4).trim();
    // A ref whose loose file is missing lives in packed-refs; resolving that is
    // more machinery than this is worth, and "unknown" is the safe answer.
    const sha = fs.readFileSync(path.join(repoDir, '.git', ref), 'utf8').trim();
    return sha || null;
  } catch {
    return null;
  }
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

/**
 * Messages from the archive on disk, for a cycle whose reads all failed.
 *
 * Technocore flaps: on 2026-08-31 two of eight consecutive cycles read nothing
 * at all, and a cycle that reads nothing plans nothing, so those cycles ran
 * zero inference sessions. That is a local GPU and 99,095 archived messages
 * sitting idle because somebody else's server returned 503 — the one part of
 * this agent that needs no network was the part that stopped.
 *
 * This is not a way to manufacture work. The planner still keys work by message
 * TEMPLATE and skips anything it has already classified, so replaying the
 * archive yields sessions only for shapes never seen before and otherwise
 * yields nothing, exactly as it should. The outage changes where the messages
 * are read from, never what counts as work worth doing.
 */
export function readArchiveTail(archiveDir, rooms, perRoom = 200) {
  const out = [];
  for (const room of rooms) {
    const archivePath = path.join(archiveDir, `${room}-archive.jsonl`);
    let stat;
    try {
      stat = fs.statSync(archivePath);
    } catch {
      continue;                       // a room we have never archived
    }
    // Read a bounded tail rather than the file: these reach 3 MB each and the
    // point is to fill an idle cycle, not to spend it on disk.
    const want = Math.min(stat.size, 256 * 1024);
    const start = stat.size - want;
    let text;
    try {
      const fd = fs.openSync(archivePath, 'r');
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, start);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter(Boolean);
    // The first line is very likely cut in half by the byte offset.
    if (start > 0) lines.shift();
    for (const line of lines.slice(-perRoom)) {
      try {
        const message = JSON.parse(line);
        const body = message.content ?? message.text;
        if (body) out.push({ room, text: body });
      } catch { /* a truncated line is not worth failing a fallback over */ }
    }
  }
  return out;
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

  /**
   * Keep a copy of everything printed from here on. Until 2026-09-02 this
   * output lived only in the launcher window, so an outage could only be
   * reconstructed from the audit log's decisions - never from what the
   * daemon actually said while making them.
   */
  if (config.consoleLogPath) mirrorConsole(config.consoleLogPath);
  
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

  // Scout claims and delivers; Scribe validates. The spec requires poster, worker
  // and validator to be three different parties, so this is never one identity
  // doing both jobs. See src/kibble-engine.mjs for why.
  const kibbleEngine = new KibbleEngine({
    workerIdentity: scoutIdentity, validatorIdentity: scribeIdentity, client,
    // The attestor->worker budget. Named here rather than defaulted in the
    // engine, so nothing but the running agent ever writes the live book.
    pairsPath: config.kibblePairsPath
  });
  // Scout takes the deals; Scribe's key is named so its offers are never ours to accept.
  const tclkEngine = new TclkEngine({
    identity: scoutIdentity, client, statePath: config.tclkStatePath, otherDids: [scribeIdentity.did],
    roomBudgetPath: config.roomBudgetPath, payerRepPath: config.payerRepPath
  });
  /**
   * The other side of the same convention, on Scribe's key.
   *
   * Two keys, two roles, and never each other's counterparty: the payee lane
   * already refuses offers from Scribe, and the payer lane refuses acceptances
   * from Scout. A deal between two of our own processes would be a transcript
   * of nothing.
   *
   * Why take the payer side at all, when the spec says the asymmetry runs
   * against it: on the paper rail there is nothing to lose, and measured
   * 2026-09-03 over 100 messages of tclk-offers the room now completes deals
   * (42 offers, 28 accepts, 3 locks, 3 reveals) while still being short of
   * anyone posting real work to be done.
   */
  const tclkPayer = new TclkPayer({
    identity: scribeIdentity, client, statePath: config.tclkPayerStatePath,
    otherDids: [scoutIdentity.did], questionBank: QUESTION_BANK,
    roomBudgetPath: config.roomBudgetPath
  });

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
  /** Which published surface this cycle checks; see the rotation in surface-watch.mjs. */
  let surfaceIndex = 0;
  /** The tclk lane's last outcome, so a quiet outcome is audited once rather than every cycle. */
  let lastTclkAction = null;
  /** The payer lane's, kept apart from the payee's so one lane cannot mute the other. */
  let lastPayerAction = null;
  const stop = () => {
    if (!running) return;
    console.log('\n[Dual Agent Mesh] Shutting down gracefully...');
    running = false;
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  /**
   * Stand down when the code on disk is no longer the code we are running.
   *
   * Every fix in this repository needed a human to notice and press restart,
   * because a daemon loads its modules once and then runs the version it
   * started with. Half a day of this session's improvements sat committed and
   * inert for exactly that reason, and the operator was told to press [14]
   * after nearly every one of them.
   *
   * So the daemon watches the commit it was launched from and exits cleanly
   * when the working tree has moved past it. paleisti-nuolat.bat restarts after
   * 30 seconds, on the new code, having released the lease properly on the way
   * out — which is the difference between this and being killed.
   *
   * Deliberately not a git pull. Fetching and merging on a machine that another
   * agent is editing is a way to lose someone's uncommitted work; noticing that
   * HEAD moved is not.
   */
  const headNow = () => readGitHead();
  const startedFrom = headNow();
  const codeChanged = () => {
    if (!startedFrom) return false;
    const now = headNow();
    return Boolean(now) && now !== startedFrom;
  };

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
        kibbleResultsDelivered: kibbleEngine.localState.resultsDelivered || 0,
        kibbleAttestsPosted: kibbleEngine.localState.attestsPosted || 0,
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

  // The commit is recorded so anything reading this log can tell whether the
  // running process is the code on disk. Without it, a pending restart is
  // invisible — which is how half a day of fixes stayed inert.
  appendAudit(config.auditLogPath, { event: 'startup', did: scoutIdentity.did, scribeDid: scribeIdentity.did, server: config.serverUrl, commit: readGitHead() });
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
  /**
   * The same holder id across restarts on this machine, remembered on disk.
   *
   * The id carries a random suffix so that two processes running at once are two
   * writers — that part is essential and unchanged. But a process that dies and
   * is restarted by the launcher is not a second writer; it is the same one,
   * back. With a fresh id it could not recognise its own abandoned lease, so it
   * stood down for the full TTL every time — and after the TTL was widened to
   * survive outages, that meant up to eight minutes of doing nothing after each
   * crash. Restarting every ten minutes, that is most of the agent's life.
   *
   * Reusing the id is safe precisely because the lease is a compare-and-set: if
   * an older process with this id were somehow still alive and renewing, our
   * write would still be ordered by the server, and only one of us can hold the
   * value at a time. What changes is only that we can now tell "this lease is
   * mine, I just restarted" from "somebody else is working".
   */
  const holderLabel = process.env.LEASE_HOLDER || (process.env.CI === 'true' ? 'github' : 'local');
  const holderIdPath = path.join(config.dataDir, 'lease-holder-id');
  let holderId;
  try {
    const remembered = fs.readFileSync(holderIdPath, 'utf8').trim();
    // Only reuse an id that still belongs to this role; a machine that switched
    // from local to github must not inherit the other one's identity.
    holderId = remembered.startsWith(`${holderLabel}-`) ? remembered : makeHolderId(holderLabel);
  } catch {
    holderId = makeHolderId(holderLabel);
  }
  try {
    fs.mkdirSync(path.dirname(holderIdPath), { recursive: true });
    fs.writeFileSync(holderIdPath, holderId, 'utf8');
  } catch { /* a forgotten id costs one standdown, not correctness */ }

  /**
   * The lease only has to outlive a missed renewal, not a coffee break.
   *
   * A flat ten minutes meant that closing one window and opening another left
   * the new process standing down for up to ten minutes against a holder that no
   * longer existed — a graceful shutdown releases the lease, but a killed window
   * cannot. Three cycles is enough slack to survive a slow cycle or a blip, and
   * it makes a dead holder clear in minutes instead of tens of them.
   *
   * Three was too few once the server started refusing writes. The TTL is also
   * the grace window: while the server is unreachable we keep working on a lease
   * we already hold, and we stop a third of the way from expiry rather than risk
   * two writers. At three cycles that is barely two minutes of cover, and the
   * audit log showed it running out mid-outage — the renewal could not land
   * either, so the clock simply ran down. Eight cycles gives roughly five
   * minutes of cover against measured outage bursts of about forty-five
   * seconds.
   *
   * The cost is what it always was, and it is small: if this process is killed
   * rather than stopped, the next writer waits out the remainder. Nothing else
   * competes for this lease today — cloud writes are switched off — and even
   * when they are on, a few extra minutes before a takeover is worth less than
   * the cycles this was throwing away.
   */
  const LEASE_CYCLES = 8;

  /**
   * Headroom left between the fast lane's deadline and the next cycle.
   *
   * The lane is awaited before the cycle's gap, so any overrun is time the next
   * cycle starts late. Wide enough to absorb one in-flight long poll (capped at
   * 10s by the protocol) plus the claim behind it.
   */
  const MIN_LANE_MARGIN_MS = 12_000;
  const leaseTtl = Math.min(10 * 60_000, Math.max(2 * 60_000, config.intervalMs * LEASE_CYCLES));

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
  /** When the current outage was last announced, so it is said once, not every minute. */
  let outageAnnouncedAt = null;

  /** Fallback for "since when has it been quiet" before anything has answered. */
  const startedAt = Date.now();

  /** Tracks the backend across cycles so a downgrade is announced once, not endlessly. */
  let lastBackendWasReal = null;
  const seenWorkPath = path.join(config.dataDir, 'seen-work.json');
  const seenWork = loadSeen(seenWorkPath);
  if (seenWork.size > 0) console.log(`[Work] Resuming with ${seenWork.size} jobs already done.`);

  /**
   * What the previous cycle gathered, so this one's burst can start immediately.
   *
   * Measured on the server 2026-09-05 over 38 cycles: a 65.5s cycle spent 27.4s
   * in the burst and 21.6s in network steps (scout 6.5, scribe 4.5, tclk 3.2,
   * mailbox 2.9, rooms 2.9, events 1.1, surface 0.5) during which the CPU sat at
   * 4-12% while ollama did nothing. Sampling every 2s showed the box pinned at
   * 100% for the whole burst and idle either side of it, so the two halves of the
   * cycle each waited for a resource the other was not using.
   *
   * The burst therefore starts at the top of the cycle on the PREVIOUS cycle's
   * messages, and is awaited where it always was. One cycle of staleness is the
   * price: a room read returns mostly what it returned a minute ago, and the
   * planner already refuses anything whose template it has classified before, so
   * the work is the same work a minute later.
   */
  let carriedWorkState = null;

  /**
   * One deadline, computed once, used by both the overlapped and the first-cycle
   * path — they must not drift apart.
   */
  const workDeadlineMs = config.workDeadlineMs
    ? Math.max(2_000, config.workDeadlineMs)
    : Math.max(20_000, Math.floor(config.intervalMs * 0.4));

  const useLease = config.lease !== false;
  const lease = useLease
    ? new Lease({
      client,
      name: config.leaseName || 'scout-cycle',
      holder: holderId,
      ttlMs: config.leaseTtlMs || leaseTtl
    })
    : null;

  /**
   * A lease we still hold survives a restart.
   *
   * Without this the agent strands itself: the degraded path needs proof the
   * lease is ours, a fresh process has none, and during an outage it can
   * neither acquire nor continue. Observed 2026-09-01 — restarted into a 503,
   * then twelve minutes of lease_unreachable every eighteen seconds and not one
   * cycle run, while a lease held moments earlier was still valid.
   */
  const leaseStatePath = path.join(config.dataDir, 'lease-held.json');
  if (lease) {
    try {
      const saved = JSON.parse(fs.readFileSync(leaseStatePath, 'utf8'));
      if (lease.resume(saved)) {
        const leftSec = Math.round((saved.heldUntil - Date.now()) / 1000);
        console.log(`[Lease] Resumed the lease this machine already held — ${leftSec}s left on it.`);
        appendAudit(config.auditLogPath, { event: 'lease_resumed', secondsLeft: leftSec });
      }
    } catch { /* no saved lease, or unreadable: acquire from scratch */ }
  }

  /** Written after every successful acquire or renew, so a restart can resume. */
  const rememberLease = () => {
    if (!lease) return;
    const snap = lease.snapshot();
    if (!snap) return;
    try {
      fs.mkdirSync(path.dirname(leaseStatePath), { recursive: true });
      fs.writeFileSync(leaseStatePath, JSON.stringify(snap), 'utf8');
    } catch { /* losing this costs a restart's worth of cover, never a cycle */ }
  };

  do {
    /**
     * The top of the cycle, held outside the try so the sleep below can subtract
     * the work from the interval rather than adding to it.
     */
    const cycleTop = Date.now();

    /** The in-flight fast-lane poll, awaited before this cycle's gap. */
    let kibbleFastLane = null;

    /** Set when this cycle runs without a lease because the server is down. */
    let writesSuppressed = false;

    try {
      if (lease) {
        // Acquire covers all three cases: unheld, expired, and already ours.
        const attempt = await lease.acquire();
        // Remember it while it is ours, so a restart mid-outage resumes rather
        // than standing down until the server comes back.
        if (attempt.acquired) rememberLease();
        if (attempt.acquired && attempt.degraded) {
          // Working on trust rather than on a fresh read. Recorded, because
          // "we kept going" and "we confirmed we could" are different facts and
          // the audit trail should never blur them.
          console.log(`[Lease] ${attempt.reason}`);
          appendAudit(config.auditLogPath, { event: 'lease_degraded', reason: attempt.reason });
        }
        const outcome = leaseOutcome(attempt);
        if (outcome !== 'proceed') {
          // A blip and a genuine handover are different events and deserve
          // different words. Reporting an outage as "lost the race" sent the
          // first reader of this looking for a competing process that did not
          // exist.
          appendAudit(config.auditLogPath, {
            event: attempt.transient ? 'lease_unreachable' : 'lease_declined',
            reason: attempt.reason,
            heldBy: attempt.heldBy ?? null
          });

          if (outcome === 'stand_down') {
            // Somebody else is working. A second writer would collide, and
            // waiting out an interval to learn that again burns nothing useful.
            console.log(`[Lease] Standing down — ${attempt.reason}.`);
            if (config.dryRun || config.once || !running) break;
            /**
             * Still take new code. This branch used to `continue` straight past
             * the update check at the bottom of the loop, which made it a trap:
             * a process stuck here could never restart onto the fix for being
             * stuck here. Today that cost an operator a manual restart during
             * an outage, and the fix for the outage was already pushed.
             */
            if (codeChanged()) {
              console.log('[Update] New code on disk while we hold no lease. Standing down for it.');
              appendAudit(config.auditLogPath, { event: 'restart_for_update', from: startedFrom });
              stop();
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
            continue;
          }

          // Unreachable. Run the cycle for everything that is not a write —
          // see leaseOutcome for why that is safe rather than merely useful.
          sayOnce('lease:outage', `[Lease] Technocore unreachable — ${attempt.reason}. `
            + 'Running read-only until it answers; nothing can be written by anyone meanwhile.');
          writesSuppressed = true;
          client.readOnly = true;
          client.readOnlyReason = `writes suppressed this cycle, lease unconfirmed (${attempt.reason})`;
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

      const ledgerPath = path.join(config.dataDir, 'inference-receipts.jsonl');

      /**
       * Pick the backend before anything else, because the burst below needs it.
       *
       * It used to be selected beside the burst, halfway down the cycle. Nothing
       * else here depends on it, so moving it up costs one reachability check at
       * a different moment and buys the whole overlap.
       */
      let cycleBackend = null;
      let cycleReal = false;
      try {
        const picked = await timed('backend', () => selectBackend({}));
        cycleBackend = picked.backend;
        cycleReal = picked.real;
        if (cycleReal !== lastBackendWasReal) {
          console.log(cycleReal
            ? `[Work] Real model reachable again — ${cycleBackend.id}${cycleBackend.model ? ` (${cycleBackend.model})` : ''}.`
            : '[Work] NO REAL MODEL — falling back to the simulator. These sessions count for nothing. '
              + 'Start Ollama, or set an inference API key.');
          lastBackendWasReal = cycleReal;
        }
      } catch (err) {
        console.log(`[Work] Backend selection failed — ${err.message}`);
      }

      /**
       * The burst runs alongside the network lanes instead of after them.
       *
       * Not awaited here on purpose — it is awaited at Step D, where it always
       * was, so the ordering of everything that reads `work` is unchanged. The
       * catch is attached now rather than there: an un-awaited promise that
       * rejects in between would be an unhandled rejection, which on this daemon
       * means the process, not the cycle.
       *
       * The kibble lanes still call the same model and will now queue behind
       * this. That is deliberate and it is the trade: measured 2026-09-05, the
       * board's scorer sits half a million messages behind a room that retains
       * an hour and a half, so those lanes are writing into a hole, while this
       * one is the throughput the testnet is scored on.
       */
      /**
       * A better model for the few tasks that earn one — see STRONG_TASKS.
       *
       * Only when an API key is configured, and only when it is not already the
       * primary: if Ollama is down and the API took over, routing it to itself
       * is a wasted branch. Unset, every job runs exactly where it ran before.
       */
      let strongBackend = null;
      if (cycleBackend && cycleBackend.id !== 'api') {
        const api = apiBackend();
        if (await api.available()) strongBackend = api;
      }

      let burstInFlight = null;
      if (carriedWorkState && cycleBackend) {
        burstInFlight = runBurst({
          state: carriedWorkState,
          seen: seenWork,
          backend: cycleBackend,
          strongBackend,
          identity: scoutIdentity,
          deadlineMs: workDeadlineMs,
          ledgerPath
        }).catch((err) => {
          console.log(`[Work] Burst failed — ${err.message}`);
          return { planned: 0, scheduled: 0, completed: 0, genuineSessions: 0, genuineSpend: 0, elapsedMs: 0, byTask: {}, stoppedBecause: `failed: ${err.message}` };
        });
      }

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
      /**
       * The board our score is computed from is archived like any other room.
       *
       * It was the one room we read constantly and kept no copy of, on the
       * assumption that /r/kibble/export was always there to reconstruct it.
       * On 2026-09-02 the export answered 200 with the body "Service
       * Unavailable" for twenty minutes while the ordinary read lane was fine,
       * and the question waiting on it was worth 72 points: 24 not-useful
       * verdicts against our deliveries that nothing local could explain.
       *
       * A 200-limit read per cycle covers a room moving at a few hundred
       * messages a minute only in part, so this is a sample and not the ring —
       * but a sample we hold beats a complete record we cannot fetch.
       */
      const archiveRooms = [...new Set([config.room, ...scoutEngine.watchRooms, kibbleEngine.room])];
      const reads = await timed('rooms', () => Promise.all(archiveRooms.map((archiveRoom) => {
        /**
         * The board is read as JSON, and only the board.
         *
         * The text view renders a writer as `<z6Mk…eaD4>` — sixteen characters
         * where a 56-character DID was. For the six chat rooms that costs
         * nothing: the archive feeds a planner that reads message text and
         * never cares who wrote it. For /r/kibble it destroys the only thing
         * the archive was added for. Within an hour of adding it the first
         * question asked of it — who wrote the 24 not-useful verdicts against
         * our deliveries, worth -72 — came back "0 found" against a full file,
         * because no truncated DID can equal ours.
         *
         * The JSON view carries `from` whole and `sig` beside it, so a line in
         * this file can still be re-verified against the signature it was
         * accepted on, months after the room ring has forgotten it.
         */
        // tclk-offers joins the board for the same reason: a deal frame names
        // its counterparty by DID, and a rendered `<z6Mk…eaD4>` names nobody.
        const identityRooms = new Set([kibbleEngine.room, TCLK_OFFER_ROOM]);
        const format = identityRooms.has(archiveRoom) ? 'json' : 'text';
        // A room that cannot be read is not worth failing the cycle over, and
        // one failure must not cancel the other five reads — hence a resolved
        // null rather than a rejection.
        return client.readRoom(archiveRoom, { limit: READ_WINDOW, format }).catch(() => null);
      })));

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

      /**
       * Step A2: one published surface, in rotation.
       *
       * The hourly CI watcher in tools/watch-sources.mjs is the durable record;
       * this is the part that runs between its runs. On 2026-09-01 /llms.txt
       * gained the official MCP endpoint somewhere inside the five hours between
       * two CI passes — the day after Hayes said work-coordination and
       * completion-proof functionality was landing that week. An hour is a long
       * time to be last to read a new route.
       *
       * One fetch, on a path the manual itself lists as never rate limited, so
       * six cycles cover the whole set and no cycle pays for more than one.
       */
      try {
        let surfaceState = {};
        try { surfaceState = JSON.parse(fs.readFileSync(config.surfaceStatePath, 'utf8')); }
        catch { /* no baseline yet; the first pass of each surface writes one */ }

        const check = await timed('surface', () => checkOneSurface({
          fetchFn: globalThis.fetch,
          baseUrl: config.serverUrl,
          state: surfaceState,
          index: surfaceIndex
        }));
        surfaceIndex += 1;
        fs.writeFileSync(config.surfaceStatePath, JSON.stringify(check.state, null, 2));

        if (check.action === 'capability_signal') {
          // Loud on purpose, and deliberately not through sayOnce: this is the
          // single event the whole watcher exists for, and repeating it until
          // somebody acts is the correct behaviour.
          console.log('='.repeat(64));
          console.log(`[SURFACE] ${check.surface} CHANGED AND NAMES A NEW CAPABILITY`);
          for (const line of check.signals) console.log(`  + ${line}`);
          console.log('='.repeat(64));
        } else if (check.action === 'changed') {
          console.log(`[Surface] ${check.surface} changed (${check.was} -> ${check.chars} chars), nothing named`);
        }
        if (check.action !== 'unchanged' && check.action !== 'baseline') {
          appendAudit(config.auditLogPath, { agent: 'surface', ...check, state: undefined });
        }
        if (check.action === 'check_failed' && check.consecutiveFailures >= 6) {
          // Six is a full rotation, so this is a surface that is reliably
          // unreadable rather than one 503 in a flappy hour.
          sayOnce(`surface:blind:${check.surface}`,
            `[Surface] ${check.surface} unreadable on ${check.consecutiveFailures} checks running: ${check.error}`);
        }
      } catch (err) {
        sayOnce('surface:watch', `[Surface] watcher failed: ${err.message}`);
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
      try {
        /**
         * Both picked at the top of the cycle now, so the burst could start
         * against them while the network lanes ran. The announce-on-transition
         * logic moved up with them; a model that vanishes is still said once.
         */
        const backend = cycleBackend;
        const real = cycleReal;
        if (!backend) throw new Error('no backend this cycle');

        // Step D0: the kibble board. Scout answers one job for real (never on
        // the simulator) and Scribe hygiene-attests one thin delivery — the two
        // roles the spec requires to stay separate DIDs. Best-effort: a public
        // board being slow or unreachable must not cost the rest of the cycle.
        //
        // Behind its own switch, unlike the rest of the writes in this cycle.
        // Everything else here posts as this agent has always posted; kibble is
        // a standing entry in someone else's permanent scoring ledger, where a
        // rejected line costs -3 forever and the operator's key is the one
        // signing it. That is a decision for the operator, not a default, and
        // it stayed a default for one cycle before this landed — long enough to
        // put a CLAIM, a RESULT and an ATTEST on the public tape under both
        // keys. Off unless KIBBLE_WRITES says otherwise.
        const kibbleWrites = /^(1|true|yes|on)$/i.test(process.env.KIBBLE_WRITES || '');
        if (!kibbleWrites) {
          sayOnce('kibble:off',
            '[Kibble] Board writes are OFF — npm run kibble-preview shows what they would be. '
            + 'Set KIBBLE_WRITES=true to take part.');
        } else {
          // Runs concurrently with the rest of the cycle now that the engine
          // stops re-reading its note mid-run: memory is the authority, so two
          // lanes can no longer clobber each other's claims. That matters
          // because coverage is the whole game here — a lane confined to the
          // cycle's tail saw about 58% of the interval, and every job posted in
          // the other 42% was one we never had a chance at.
          //
          // Sized to end just before the next cycle would start, so it is
          // always awaited below rather than left running into it.
          const laneMs = Math.max(5_000, config.intervalMs - (Date.now() - cycleTop) - MIN_LANE_MARGIN_MS);
          kibbleFastLane = kibbleEngine
            .runFastLane({ maxMs: laneMs })
            .catch((err) => ({ action: 'failed', error: err.message }));

          try {
            const kibbleWorker = await timed('kibbleWorker', () => kibbleEngine.runWorkerTurn({ backend, real, ledgerPath }));
            if (kibbleWorker.action !== 'no_job') {
              console.log(`[Kibble/Worker] ${kibbleWorker.action}${kibbleWorker.jobId ? ` — ${kibbleWorker.jobId}` : ''}`);
            }
            appendAudit(config.auditLogPath, { agent: 'kibble-worker', ...kibbleWorker });
          } catch (err) {
            console.log(`[Kibble/Worker] Skipped — ${err.message}`);
          }
          try {
            const ownVerdict = await timed('kibbleOwnVerdict',
              () => kibbleEngine.runPosterVerdictTurn({ backend, real, ledgerPath }));
            if (ownVerdict.action === 'rejected_own_job_delivery') {
              console.log(`[Kibble/Poster] rejected a non-answer to our own question — ${ownVerdict.jobId}`);
              appendAudit(config.auditLogPath, { agent: 'kibble-own-verdict', ...ownVerdict });
            }
          } catch (err) {
            console.log(`[Kibble/Poster] Verdict skipped — ${err.message}`);
          }
          try {
            /**
             * Runs until Scribe has one RESULT of its own, then never again.
             * Its 142 useful verdicts are worth nothing to the agents they
             * praise until it does — see runFranchiseTurn.
             */
            const franchise = await timed('kibbleFranchise',
              () => kibbleEngine.runFranchiseTurn({ backend, real, ledgerPath }));
            if (franchise.action !== 'already_franchised' && franchise.action !== 'no_franchise_job') {
              console.log(`[Kibble/Franchise] ${franchise.action}${franchise.jobId ? ` — ${franchise.jobId}` : ''}`);
              appendAudit(config.auditLogPath, { agent: 'kibble-franchise', ...franchise });
            }
          } catch (err) {
            console.log(`[Kibble/Franchise] skipped — ${err.message}`);
          }
          try {
            /**
             * One tclk deal at a time, payee side, paper rail. Quiet while it
             * waits; every step that posts something is audited, and the
             * secret is never in any of it.
             */
            const tclk = await timed('tclk', () => tclkEngine.runTurn({ backend, real, ledgerPath }));
            /**
             * Quiet outcomes are audited when they change, failures always.
             *
             * The first version audited neither, and the lane's second live
             * cycle taught why that is wrong: the step took exactly 15,008 ms
             * — the client's read timeout — returned read_failed, and left no
             * trace. Thirteen acceptable offers sat in the room and the audit
             * looked identical to "nothing to do". A lane that cannot read and
             * a lane with nothing to read must not write the same silence.
             */
            const quiet = ['no_acceptable_offer', 'waiting_for_lock', 'lock_not_verified', 'rooms_refused'];
            const changed = tclk.action !== lastTclkAction;
            lastTclkAction = tclk.action;
            if (!quiet.includes(tclk.action) || changed) {
              console.log(`[tclk] ${tclk.action}${tclk.contract ? ` — ${tclk.contract.slice(0, 18)}` : ''}${tclk.error ? ` (${tclk.error})` : ''}`);
              appendAudit(config.auditLogPath, { agent: 'tclk', ...tclk });
            }
          } catch (err) {
            sayOnce('tclk:lane', `[tclk] lane failed: ${err.message}`);
          }
          try {
            /**
             * The payer lane. Same quiet-when-unchanged rule as the payee side,
             * for the same reason: `waiting_for_accept` every minute for an
             * hour is not information, but a lane that stopped being able to
             * read has to be distinguishable from one with nothing to read.
             */
            const payer = await timed('tclkPayer', () => tclkPayer.runTurn());
            const quietPayer = ['offer_paced', 'waiting_for_accept', 'waiting_for_reveal', 'no_question_left',
              'rooms_refused', 'lock_unannounced_rooms_refused'];
            const payerChanged = payer.action !== lastPayerAction;
            lastPayerAction = payer.action;
            if (!quietPayer.includes(payer.action) || payerChanged) {
              console.log(`[tclk/payer] ${payer.action}${payer.contract ? ` — ${payer.contract.slice(0, 18)}` : ''}${payer.error ? ` (${payer.error})` : ''}`);
              appendAudit(config.auditLogPath, { agent: 'tclk-payer', ...payer });
            }
          } catch (err) {
            sayOnce('tclk:payer-lane', `[tclk] payer lane failed: ${err.message}`);
          }
          try {
            const kibbleBrief = await timed('kibbleBrief', () => kibbleEngine.runBriefTurn());
            if (kibbleBrief.action === 'brief_posted') {
              console.log(`[Kibble/Brief] ${kibbleBrief.headline}`);
              appendAudit(config.auditLogPath, { agent: 'kibble-brief', ...kibbleBrief });
            }
          } catch (err) {
            console.log(`[Kibble/Brief] Skipped — ${err.message}`);
          }
          try {
            const kibblePoster = await timed('kibblePoster', () => kibbleEngine.runPosterTurn());
            if (kibblePoster.action === 'job_posted') {
              console.log(`[Kibble/Poster] asked ${kibblePoster.key} (${kibblePoster.jobId})`);
              appendAudit(config.auditLogPath, { agent: 'kibble-poster', ...kibblePoster });
            }
          } catch (err) {
            console.log(`[Kibble/Poster] Skipped — ${err.message}`);
          }
          try {
            /**
             * Whatever this cycle can spare, but never most of it.
             *
             * "Whatever is left" was the whole rule until the useful lane started
             * spending its full three-verdict allowance, at which point each
             * verdict costs a model session rather than a regex. Measured
             * 2026-09-03, straight after that change: the validator step reached
             * 22.3s and one cycle ran 79.6s against a 60s interval, with the
             * average moving 23.2s -> 33.8s. This file already carries the same
             * lesson from an earlier round -- the validator grew to 8.7s and
             * cycles per hour fell from 58 to 44 -- so the bound is a share of
             * the interval, which still fits three sessions at the ~7s each they
             * were measured to take, and cannot starve the eleven other lanes.
             */
            const validatorMs = Math.max(3_000, Math.min(
              config.intervalMs - (Date.now() - cycleTop) - MIN_LANE_MARGIN_MS - 8_000,
              Math.floor(config.intervalMs * 0.4)));
            const kibbleValidator = await timed('kibbleValidator',
              () => kibbleEngine.runValidatorTurn({ backend, real, ledgerPath, maxMs: validatorMs }));
            if (kibbleValidator.action !== 'no_target') {
              console.log(`[Kibble/Validator] ${kibbleValidator.action}`
                + `${kibbleValidator.posted ? ` ×${kibbleValidator.posted}` : ''}`
                + `${kibbleValidator.jobId ? ` — ${kibbleValidator.jobId}` : ''}`);
            }
            appendAudit(config.auditLogPath, { agent: 'kibble-validator', ...kibbleValidator });
          } catch (err) {
            console.log(`[Kibble/Validator] Skipped — ${err.message}`);
          }

        }

        // Every room read failed this cycle, so there is nothing fresh to think
        // about — but there are 99,095 archived messages and a local model that
        // needs no network. Read from disk instead of standing idle; the planner
        // still refuses anything whose template it has already classified.
        if (recentMessages.length === 0) {
          const fromDisk = readArchiveTail(config.chatArchiveDir, archiveRooms);
          if (fromDisk.length) {
            recentMessages.push(...fromDisk);
            sayOnce('work:archive-fallback',
              `[Work] No room reads this cycle — planning from ${fromDisk.length} archived messages instead.`);
          }
        }

        /**
         * All four sources of work, not just the one.
         *
         * The planner reads five task kinds and only ever received messages to
         * classify, so 10,792 of 10,792 receipts on disk were one task —
         * measurable proof that three capabilities were built, tested and then
         * never handed an input. The series and the questions were already in
         * scope here; nothing was missing but the wiring.
         */
        const gathered = {
          unclassified: recentMessages,
          sourceChange: readSourceChange(config.dataDir),
          measurements: readMeasurements(),
          pendingQuestions: pendingQuestions.map((q) => ({ text: q.text, facts: FACTS }))
        };

        /**
         * Either the burst that has been running since the top of this cycle, or
         * — on the very first cycle, when there was nothing carried to run — the
         * old inline burst on what we just gathered. After the first cycle the
         * inline path is never taken again.
         */
        work = burstInFlight
          ? await burstInFlight
          : await runBurst({
            state: gathered,
            seen: seenWork,
            backend,
            strongBackend,
            identity: scoutIdentity,
            deadlineMs: workDeadlineMs,
            ledgerPath
          });

        carriedWorkState = gathered;
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
        if (!recorded.recorded) sayOnce('activity', `[Activity] Not recorded — ${recorded.reason}`);
      } catch (err) {
        sayOnce('activity', `[Activity] Not recorded — ${err.message}`);
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
    } finally {
      // Restore rather than clear: --dry-run sets this for the whole process,
      // and a cycle that ran through an outage must not quietly re-enable
      // writing for a run the operator asked to be silent.
      if (writesSuppressed) { client.readOnly = readOnly; client.readOnlyReason = null; }
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

    // The fast lane holds a long poll open through the idle part of the cycle.
    // Awaited here rather than left running, so it can never overlap the next
    // cycle's worker turn and race it for the same state note.
    if (kibbleFastLane) {
      const lane = await kibbleFastLane;
      kibbleFastLane = null;
      if (lane?.claimed) {
        console.log(`[Kibble/Fast] claimed ${lane.claimed}, holding ${lane.held}`);
        appendAudit(config.auditLogPath, { agent: 'kibble-fast', ...lane });
      }
    }

    const elapsed = Date.now() - cycleTop;

    /**
     * Stand off a server that is properly down, and say so once.
     *
     * This is different from the flapping the lease already survives. On
     * 2026-08-31 Technocore returned 503 to everything including its own front
     * page, for hours. Each cycle then produced the same twenty failure lines a
     * minute — state write failed, activity not recorded, post failed — and
     * twenty pointless requests with them. The agent was healthy the whole time
     * and its log said nothing but "broken", which is exactly how a working
     * agent comes to look like a dead one.
     *
     * So: after three cycles in which nothing reached the server, slow down to
     * at most five minutes and print one line instead of the flood. Any answer
     * at all resets it immediately — the next cycle runs in full, so a recovery
     * is noticed by working, not by a separate probe.
     *
     * Capped below the lease TTL on purpose: backing off past our own renewal
     * window would hand the lease away while we sat quiet.
     */
    /**
     * Measured in time, not in failed requests. My first version of this counted
     * three consecutive failures and fired within seconds, then announced
     * "answered nothing for 0 min" — a backoff triggered by one bad moment,
     * describing an outage that had not happened. A cycle makes about twenty
     * requests, so three in a row is a blink; what matters is how long it has
     * been since anything at all got through.
     */
    const OUTAGE_QUIET_MS = 2 * 60_000;
    const OUTAGE_MAX_GAP_MS = 5 * 60_000;
    let gapMs = Math.max(MIN_GAP_MS, config.intervalMs - elapsed);

    const downFor = Date.now() - (client.lastOkAt ?? startedAt);
    if (client.consecutiveFailures > 0 && downFor >= OUTAGE_QUIET_MS) {
      gapMs = Math.min(OUTAGE_MAX_GAP_MS, Math.max(gapMs, config.intervalMs * 3));
      if (!outageAnnouncedAt || Date.now() - outageAnnouncedAt > 10 * 60_000) {
        outageAnnouncedAt = Date.now();
        const mins = Math.max(1, Math.round(downFor / 60_000));
        console.log(`[Outage] Technocore has answered nothing for ${mins} min. `
          + `Backing off to ${Math.round(gapMs / 1000)}s between cycles. `
          + 'The agent is fine; there is nothing here to fix.');
        appendAudit(config.auditLogPath, { event: 'outage', downMin: mins, gapMs });
      }
    } else if (client.consecutiveFailures === 0) {
      /**
       * Say that it stopped, not just stop saying it.
       *
       * A stream of failures that simply goes quiet is indistinguishable from a
       * process that died — which is the confusion this whole log is trying to
       * end. Each recovered condition reports how long it lasted and how many
       * times it happened while it was being summarised.
       */
      for (const key of ['scout:state-write', 'scout:post', 'scribe:state-write',
        'scribe:post', 'mailbox:state-write', 'activity']) {
        clearOnce(key);
      }
      if (outageAnnouncedAt) {
        outageAnnouncedAt = null;
        console.log('[Outage] Technocore is answering again.');
        appendAudit(config.auditLogPath, { event: 'outage_over' });
      }
    }

    // New code on disk: finish this gap, then stand down so the launcher can
    // bring us back on it. Checked here rather than mid-cycle so nothing is
    // ever abandoned half-done.
    if (codeChanged()) {
      console.log('[Update] The repository moved past the commit this process started from. '
        + 'Standing down so the launcher restarts on the new code.');
      appendAudit(config.auditLogPath, { event: 'restart_for_update', from: startedFrom });
      stop();
    }

    await new Promise((resolve) => setTimeout(resolve, gapMs));
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
  /**
   * A crash that says nothing is a crash you cannot fix.
   *
   * On 2026-08-31 the daemon died roughly every ten minutes and the launcher
   * restarted it, so from outside it looked like an agent that "does not really
   * work". The audit log had a `startup` for each life and NO `shutdown` and NO
   * `error` — the process was not exiting through any path this file knows
   * about, which is exactly the shape of an uncaught exception or a rejected
   * promise nobody awaited. Neither leaves a trace here by default, and the
   * console output scrolls away in a window nobody is watching at 03:00.
   *
   * Memory was 230 MB, so it was not the machine running out of anything.
   *
   * These two handlers do not fix the crash. They make the next one name
   * itself, in the same log every other finding in this project came from.
   */
  const recordFatal = (kind) => (err) => {
    const detail = err instanceof Error ? `${err.message}
${err.stack}` : String(err);
    console.error(`Fatal (${kind}):`, detail);
    try {
      const { auditLogPath } = deriveFrom(parseArgs(process.argv));
      appendAudit(auditLogPath, { event: 'fatal', kind, error: detail.slice(0, 2000) });
    } catch { /* if even this fails, the console line above is what is left */ }
    process.exit(1);
  };

  process.on('uncaughtException', recordFatal('uncaughtException'));
  process.on('unhandledRejection', recordFatal('unhandledRejection'));

  runScoutDaemon().catch(recordFatal('fatal'));
}
