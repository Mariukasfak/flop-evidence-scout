/**
 * Rehearses the one operation that will matter and has never been practised:
 * proving control of a DID by signing a challenge.
 *
 * Whatever a FLOP claim eventually looks like, it will come down to "sign this
 * with the key behind did:key:z6Mk..." under time pressure, probably with a
 * deadline. This proves, today, that:
 *
 *   1. the identity can produce a signature,
 *   2. the signature verifies against the DID *alone* — no local file, no
 *      keystore, nothing but the public string anyone can read from the note,
 *   3. and, with --vault, that the encrypted backup is sufficient by itself.
 *
 * Point 3 is the real test. Signing with the file the agent already uses proves
 * nothing about recovery.
 *
 * Run: node tools/claim-rehearsal.mjs
 *      node tools/claim-rehearsal.mjs --vault <path>     (cold-restore drill)
 *      node tools/claim-rehearsal.mjs --challenge "..."
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  loadOrCreateIdentity,
  signMessageBase64Url,
  verifyMessage,
  decodeDidKeyToRaw,
  rawPublicKeyToSpki,
  getDidShardedPath
} from '../src/identity.mjs';
import { decryptVault } from '../src/vault.mjs';

function parseArgs(argv) {
  const out = { vaultPath: null, challenge: null, receiptPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault' && argv[i + 1]) out.vaultPath = argv[++i];
    else if (a.startsWith('--vault=')) out.vaultPath = a.slice(8);
    else if (a === '--challenge' && argv[i + 1]) out.challenge = argv[++i];
    else if (a.startsWith('--challenge=')) out.challenge = a.slice(12);
    else if (a.startsWith('--receipt=')) out.receiptPath = a.slice(10);
  }
  return out;
}

/**
 * Verify with nothing but the DID string. Deriving the public key back out of
 * did:key is the whole point: it is what a claim contract or a snapshot script
 * would do, and it proves the private key is genuinely the one behind the
 * identity published on the network.
 */
export function proveControl(did, privateKeyPem, challenge) {
  const signature = signMessageBase64Url(challenge, privateKeyPem);

  const rawPublicKey = decodeDidKeyToRaw(did);          // did:key -> 32 raw bytes
  const publicKeyPem = rawPublicKeyToSpki(rawPublicKey); // -> usable public key
  const verified = verifyMessage(challenge, signature, publicKeyPem);

  // And again through the did:key path the verifier would actually be handed.
  const verifiedViaDid = verifyMessage(challenge, signature, did);

  return { signature, verified, verifiedViaDid };
}

async function loadIdentities({ vaultPath }) {
  if (!vaultPath) {
    return {
      source: 'live identity files / environment',
      scout: loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON'),
      scribe: loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON')
    };
  }

  const passphrase = process.env.SCOUT_VAULT_PASSPHRASE;
  if (!passphrase) {
    throw new Error('Set SCOUT_VAULT_PASSPHRASE to run the cold-restore drill.');
  }
  const vault = JSON.parse(fs.readFileSync(path.resolve(vaultPath), 'utf8'));
  const restored = decryptVault(vault, passphrase);
  return { source: `encrypted vault ${vaultPath}`, scout: restored.scout, scribe: restored.scribe };
}

async function main() {
  const { vaultPath, challenge: given, receiptPath } = parseArgs(process.argv);

  // A challenge is only meaningful if the signer did not choose it. Random
  // nonce plus the date, so a receipt cannot be back-dated by replay.
  const challenge = given
    || `flop-claim-rehearsal|${new Date().toISOString().slice(0, 10)}|${crypto.randomBytes(16).toString('hex')}`;

  const { source, scout, scribe } = await loadIdentities({ vaultPath });

  console.log('\n=== FLOP claim rehearsal ===\n');
  console.log(`Identity source : ${source}`);
  console.log(`Challenge       : ${challenge}`);
  console.log(`Host            : ${process.env.GITHUB_ACTIONS ? 'GitHub Actions runner' : 'local machine'}\n`);

  const results = [];
  let allPassed = true;

  for (const [name, identity] of [['Scout', scout], ['Scribe', scribe]]) {
    const { signature, verified, verifiedViaDid } = proveControl(identity.did, identity.privateKeyPem, challenge);
    const passed = verified && verifiedViaDid;
    allPassed &&= passed;

    console.log(`[${name}] ${identity.did}`);
    console.log(`  note        : /kv/${getDidShardedPath(identity.did).shard}/${getDidShardedPath(identity.did).key}`);
    console.log(`  signature   : ${signature.slice(0, 24)}... (${signature.length} chars base64url)`);
    console.log(`  verified    : ${passed ? 'YES — against the DID alone' : 'NO'}`);
    console.log('');

    results.push({ agent: name, did: identity.did, signature, verified: passed });
  }

  // The receipt carries public material only: DID, challenge, signature. Anyone
  // can check it; nobody can reuse it, because the challenge is single-use.
  const receipt = {
    rehearsedAt: new Date().toISOString(),
    host: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    identitySource: vaultPath ? 'encrypted-vault' : 'live',
    challenge,
    results,
    allPassed
  };

  if (receiptPath) {
    fs.mkdirSync(path.dirname(path.resolve(receiptPath)), { recursive: true });
    fs.writeFileSync(path.resolve(receiptPath), JSON.stringify(receipt, null, 2), 'utf8');
    console.log(`Receipt written to ${receiptPath}`);
  }

  if (!allPassed) {
    console.error('REHEARSAL FAILED — an identity could not prove control of its own DID.');
    process.exit(1);
  }

  console.log('Rehearsal passed. Both identities can prove control of their DID on demand.');
  if (!vaultPath) {
    console.log('\nNote: this used the live key files. Run it again with --vault to prove the');
    console.log('backup is sufficient on its own — that is the drill that matters.');
  }
}

main().catch((err) => {
  console.error('\nRehearsal error:', err.message);
  process.exit(1);
});
