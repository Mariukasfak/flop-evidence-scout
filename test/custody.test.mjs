import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateIdentity } from '../src/identity.mjs';
import { encryptVault, decryptVault, MIN_PASSPHRASE_LENGTH } from '../src/vault.mjs';
import { proveControl } from '../tools/claim-rehearsal.mjs';
import { TestnetPolicy, TESTNET_POLICY } from '../src/testnet-policy.mjs';

const PASSPHRASE = 'correct-horse-battery-staple-42';

describe('Identity vault', () => {
  test('round-trips both identities through an encrypted file on disk', () => {
    const scout = generateIdentity();
    const scribe = generateIdentity();

    const vault = encryptVault({ scout, scribe }, PASSPHRASE);

    // Nothing secret may be readable in the envelope itself.
    const serialised = JSON.stringify(vault);
    assert.equal(serialised.includes('BEGIN PRIVATE KEY'), false);
    assert.equal(serialised.includes(scout.privateKeyPem), false);
    assert.equal(serialised.includes(scribe.privateKeyPem), false);
    // Public identifiers are kept, so a backup can be identified without opening it.
    assert.deepEqual(vault.dids.sort(), [scout.did, scribe.did].sort());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
    const file = path.join(dir, 'vault.json');
    fs.writeFileSync(file, JSON.stringify(vault));

    const restored = decryptVault(JSON.parse(fs.readFileSync(file, 'utf8')), PASSPHRASE);
    assert.equal(restored.scout.privateKeyPem, scout.privateKeyPem);
    assert.equal(restored.scribe.did, scribe.did);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses a wrong passphrase, a tampered payload and a weak passphrase', () => {
    const identity = generateIdentity();
    const vault = encryptVault({ scout: identity }, PASSPHRASE);

    assert.throws(() => decryptVault(vault, 'wrong-passphrase-here'), /Decryption failed/);

    // GCM must reject a single flipped byte rather than returning plausible garbage.
    const tampered = { ...vault };
    const bytes = Buffer.from(vault.ciphertext, 'base64');
    bytes[0] ^= 0x01;
    tampered.ciphertext = bytes.toString('base64');
    assert.throws(() => decryptVault(tampered, PASSPHRASE), /Decryption failed/);

    assert.throws(() => encryptVault({ scout: identity }, 'short'), new RegExp(`${MIN_PASSPHRASE_LENGTH} characters`));
  });
});

describe('Claim rehearsal', () => {
  test('proves control using the DID alone, with no access to the key file', () => {
    const identity = generateIdentity();
    const challenge = 'flop-claim-rehearsal|2026-08-25|deadbeef';

    const { signature, verified, verifiedViaDid } = proveControl(identity.did, identity.privateKeyPem, challenge);

    assert.equal(verified, true);
    assert.equal(verifiedViaDid, true);
    assert.equal(signature.length, 86, 'unpadded base64url Ed25519 signature');
    assert.equal(/[=+/]/.test(signature), false, 'base64url, not base64');
  });

  test('a different key cannot forge a proof for someone else DID', () => {
    const real = generateIdentity();
    const impostor = generateIdentity();
    const challenge = 'flop-claim-rehearsal|2026-08-25|cafebabe';

    const forged = proveControl(real.did, impostor.privateKeyPem, challenge);
    assert.equal(forged.verified, false);
    assert.equal(forged.verifiedViaDid, false);
  });

  test('a signature does not carry over to a different challenge', () => {
    const identity = generateIdentity();
    const { signature } = proveControl(identity.did, identity.privateKeyPem, 'challenge-one');
    const other = proveControl(identity.did, identity.privateKeyPem, 'challenge-two');
    assert.notEqual(signature, other.signature);
  });

  test('the encrypted backup alone is enough to sign — the drill that matters', () => {
    const scout = generateIdentity();
    const vault = encryptVault({ scout }, PASSPHRASE);

    // Simulate a cold machine: nothing but the vault file and the passphrase.
    const coldRestore = decryptVault(JSON.parse(JSON.stringify(vault)), PASSPHRASE);
    const proof = proveControl(coldRestore.scout.did, coldRestore.scout.privateKeyPem, 'cold-restore-drill');

    assert.equal(proof.verified, true);
    assert.equal(coldRestore.scout.did, scout.did);
  });
});

describe('Testnet operation policy', () => {
  const at = (ms) => () => ms;

  test('caps the day, caps the hour, and never bursts', () => {
    let clock = 1_000_000;
    const policy = new TestnetPolicy({ now: () => clock });

    // Four in an hour is the ceiling; the fifth waits.
    for (let i = 0; i < TESTNET_POLICY.maxPerHour; i++) {
      assert.equal(policy.canOperate().allowed, true, `operation ${i + 1} should be allowed`);
      policy.recordOperation();
      clock += 11 * 60 * 1000;   // past the 4-10 min jittered gap, inside one hour
    }

    const blocked = policy.canOperate();
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /hourly cap/);
  });

  test('reaches the daily cap and reports how long until it frees up', () => {
    let clock = 1_000_000;
    const policy = new TestnetPolicy({ now: () => clock });

    for (let i = 0; i < TESTNET_POLICY.maxPerDay; i++) {
      policy.recordOperation();
      clock += 55 * 60 * 1000;   // 22h total span, so all 24 stay inside the day
    }

    const blocked = policy.canOperate();
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /daily cap/);
    assert.equal(blocked.waitMs > 0, true);
  });

  test('the gap after an operation is never fixed', () => {
    const gaps = new Set();
    for (let i = 0; i < 40; i++) {
      const policy = new TestnetPolicy({ now: at(0) });
      policy.recordOperation();
      gaps.add(policy.state.nextAllowedAt);
    }
    // A constant cadence is the tell that clustering looks for.
    assert.equal(gaps.size > 20, true, 'jitter must actually vary the next-allowed time');
    for (const g of gaps) {
      assert.equal(g >= TESTNET_POLICY.minGapMs, true, 'never closer than the minimum gap');
      assert.equal(g <= TESTNET_POLICY.minGapMs + TESTNET_POLICY.jitterMs, true);
    }
  });

  test('refuses anything that moves value without a human, terminally', () => {
    const policy = new TestnetPolicy({ now: at(1_000_000) });

    const refused = policy.canOperate({ movesValue: true });
    assert.equal(refused.allowed, false);
    assert.equal(refused.terminal, true, 'not a wait — a refusal');
    assert.match(refused.reason, /never signs for value on its own/);

    // And it is still refused when the rate budget is completely free.
    assert.equal(policy.canOperate({ movesValue: true }).allowed, false);
    // A human-driven path may proceed.
    assert.equal(policy.canOperate({ movesValue: true, humanApproved: true }).allowed, true);
  });

  test('state survives a restart the same way every other cursor does', () => {
    let clock = 1_000_000;
    const first = new TestnetPolicy({ now: () => clock });
    first.recordOperation('faucet_draw');
    first.recordOperation('inference_spend');

    const carried = JSON.parse(JSON.stringify(first.toState()));
    const second = new TestnetPolicy({ state: carried, now: () => clock });

    assert.equal(second.summary().last24h, 2);
    assert.equal(second.summary().totalEver, 2);
  });
});

describe('technocore-contribution-v1 proofs', () => {
  test('canonical payload matches the reference implementation byte for byte', async () => {
    const { contributionPayload } = await import('../src/contribution.mjs');
    // json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",",":"))
    assert.equal(
      contributionPayload('https://example.com/a', 'A'.repeat(40)),
      '{"artifact_url":"https://example.com/a","commit":"' + 'a'.repeat(40) + '","schema":"technocore-contribution-v1"}'
    );
  });

  test('signs and verifies a proof, and rejects a tampered one', async () => {
    const { createContributionProof, verifyContributionProof } = await import('../src/contribution.mjs');
    const identity = generateIdentity();
    const url = 'https://github.com/Mariukasfak/flop-evidence-scout';
    const commit = 'b'.repeat(40);

    const proof = createContributionProof(identity, url, commit);
    assert.equal(verifyContributionProof(proof), true);
    assert.equal(proof.did, identity.did);

    // Swapping the URL after signing must not still verify — that is the whole
    // point of binding the DID to an exact revision.
    assert.throws(
      () => verifyContributionProof({ ...proof, artifact_url: 'https://evil.example/x' }),
      /does not verify/
    );
    assert.throws(() => verifyContributionProof({ ...proof, commit: 'c'.repeat(40) }), /does not verify/);
  });

  test('refuses URLs and commits that cannot be pinned down', async () => {
    const { createContributionProof } = await import('../src/contribution.mjs');
    const identity = generateIdentity();
    const good = 'b'.repeat(40);

    assert.throws(() => createContributionProof(identity, 'http://example.com/a', good), /must be https/);
    assert.throws(() => createContributionProof(identity, 'https://example.com/a#x', good), /fragment/);
    assert.throws(() => createContributionProof(identity, 'https://u:p@example.com/a', good), /credentials/);
    assert.throws(() => createContributionProof(identity, ' https://example.com/a', good), /whitespace/);
    assert.throws(() => createContributionProof(identity, 'https://example.com/a', 'main'), /hexadecimal revision/);
  });

  test('an announcement must carry a real summary, not a fixed sentence', async () => {
    const { createContributionProof, contributionAnnouncement } = await import('../src/contribution.mjs');
    const proof = createContributionProof(generateIdentity(), 'https://example.com/a', 'd'.repeat(40));

    assert.throws(() => contributionAnnouncement(proof, { summary: 'contribution' }), /real one-line summary/);

    const line = contributionAnnouncement(proof, {
      summary: 'Measured Technocore throughput and DID population with a reproducible instrument'
    });
    assert.match(line, /technocore-contribution-v1/);
    assert.match(line, /https:\/\/example\.com\/a/);
    assert.equal(line.includes('\n'), false, 'must survive the single-line sweep unchanged');
  });
});

describe('Generated pages', () => {
  /**
   * 42 tests passed while the published dashboard threw
   * `Uncaught SyntaxError: Unexpected token 'else'` on load, taking every button
   * on the page down with it. Nothing checked that the JavaScript the generator
   * emits actually parses — so nothing caught a regex edit that deleted an
   * if-branch and left its else stranded.
   */
  const parseScripts = (html) => {
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    return blocks.map((code, i) => {
      try {
        new Function(code);
        return { index: i, ok: true };
      } catch (err) {
        return { index: i, ok: false, error: err.message };
      }
    });
  };

  test('the dashboard emits JavaScript that parses', async () => {
    const { generateDashboardHtml } = await import('../src/dashboard.mjs');
    const html = generateDashboardHtml({
      identity: { did: 'did:key:z6MkTestDid' },
      heartbeat: { status: 'active', turns: 3 },
      logs: [{ timestamp: new Date().toISOString(), action: 'signed_checkin', details: { response: 'x' } }],
      roomMessages: { lobby: [{ seq: 1, from: 'did:key:z6MkOther', text: 'hello' }] }
    });

    const results = parseScripts(html);
    assert.equal(results.length > 0, true, 'the page should carry at least one inline script');
    for (const r of results) {
      assert.equal(r.ok, true, `inline script #${r.index} must parse: ${r.error || ''}`);
    }
  });

  test('every element the dashboard script touches exists in the markup', async () => {
    const { generateDashboardHtml } = await import('../src/dashboard.mjs');
    const html = generateDashboardHtml({
      identity: { did: 'did:key:z6MkTestDid' },
      heartbeat: { status: 'active', turns: 3 },
      logs: [{ timestamp: new Date().toISOString(), action: 'signed_checkin', details: { response: 'x' } }]
    });

    // The reported failure was `Cannot set properties of null (setting
    // 'innerText')`: the i18n pass still addressed lock-title and lock-desc
    // after the gate that owned them was removed. One null reference threw
    // during startup and took every later handler down with it.
    const referenced = [...html.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
    const missing = [...new Set(referenced)].filter((id) => !html.includes(`id="${id}"`));
    assert.deepEqual(missing, [], `script addresses elements that do not exist: ${missing.join(', ')}`);
  });

  test('the dashboard no longer ships a password gate', async () => {
    const { generateDashboardHtml } = await import('../src/dashboard.mjs');
    const html = generateDashboardHtml({ identity: { did: 'did:key:z6MkTestDid' }, heartbeat: {}, logs: [] });

    // The gate hid content with CSS while its password sat in two public files.
    for (const leftover of ['AUTH_HASH', 'attemptUnlock', 'scout_auth', 'scout-pass', 'lockDashboard']) {
      assert.equal(html.includes(leftover), false, `${leftover} should be gone`);
    }
    // Every onclick handler the markup references must actually be defined.
    const handlers = [...html.matchAll(/onclick="(\w+)\(/g)].map((m) => m[1]);
    for (const fn of new Set(handlers)) {
      assert.equal(
        new RegExp(`function\\s+${fn}\\s*\\(`).test(html), true,
        `onclick="${fn}()" has no definition on the page`
      );
    }
  });
});
