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

    const formatted = formatKnowledgeResponse('kas yra /kv/ notes?');
    assert.match(formatted, /FLOP Scout Helper/);
    assert.match(formatted, /kv_persistence/);
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
    }
  };
  const mockKv = new Map();
  const postedMessages = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: 'technocore-0.9' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/r/lobby') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mockRooms.lobby));
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

      const kvSetMatch = url.pathname.match(/^\/kv\/([^/]+)\/([^/]+)\/set\/(.*)$/);
      if (kvSetMatch) {
        const [, ns, key, encodedValue] = kvSetMatch;
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
            res.writeHead(200, { 'content-type': typeof data === 'object' ? 'application/json' : 'text/plain' });
            res.end(typeof data === 'object' ? JSON.stringify(data) : String(data));
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
    const engine = new ScoutEngine({ identity, client, guardrails });

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
      room: 'lobby'
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
