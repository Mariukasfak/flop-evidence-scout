/**
 * Writes one encrypted file containing both agent identities, and immediately
 * proves it can be opened again. A backup nobody has restored is a rumour.
 *
 * The passphrase is read from stdin (hidden) or from SCOUT_VAULT_PASSPHRASE.
 * It is never written anywhere, never logged, and never passed on a command
 * line — argv is visible to other processes on the machine.
 *
 * Run: node tools/backup-identity.mjs [--out <path>]
 *   or double-click daryti-atsargine-kopija.bat
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { loadOrCreateIdentity } from '../src/identity.mjs';
import { encryptVault, decryptVault, MIN_PASSPHRASE_LENGTH } from '../src/vault.mjs';

function parseArgs(argv) {
  const out = { outPath: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) out.outPath = argv[++i];
    else if (argv[i].startsWith('--out=')) out.outPath = argv[i].slice(6);
  }
  return out;
}

/** Read a line without echoing it, so it does not end up in the terminal buffer. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '') {
        process.stdin.removeListener('data', onData);
      } else {
        // Redraw the prompt with no characters after it.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(prompt);
      }
    };
    process.stdout.write(prompt);
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function getPassphrase() {
  if (process.env.SCOUT_VAULT_PASSPHRASE) {
    console.log('Using SCOUT_VAULT_PASSPHRASE from the environment.');
    return process.env.SCOUT_VAULT_PASSPHRASE;
  }
  if (!process.stdin.isTTY) {
    throw new Error('No terminal to prompt on. Set SCOUT_VAULT_PASSPHRASE, or run this from a console window.');
  }

  const first = await askHidden(`Slaptafrazė (bent ${MIN_PASSPHRASE_LENGTH} simboliai): `);
  const second = await askHidden('Pakartokite slaptafrazę: ');
  if (first !== second) throw new Error('Slaptafrazės nesutampa. Nieko neįrašyta.');
  return first;
}

async function main() {
  const { outPath } = parseArgs(process.argv);

  const scout = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
  const scribe = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');

  console.log('\nBus įrašyta į atsarginę kopiją:');
  console.log(`  Scout : ${scout.did}`);
  console.log(`  Scribe: ${scribe.did}\n`);

  const passphrase = await getPassphrase();
  const payload = { scout, scribe };
  const vault = encryptVault(payload, passphrase);

  // Default outside the repository: a backup inside the working tree is one
  // careless `git add -f` away from being public.
  const target = path.resolve(
    outPath || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'flop-scout-identity-vault.json')
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(vault, null, 2), { mode: 0o600 });

  // Prove it before claiming success — read the file back from disk, not the
  // object still in memory, so a bad write is caught here and not in a year.
  const readBack = JSON.parse(fs.readFileSync(target, 'utf8'));
  const restored = decryptVault(readBack, passphrase);

  const ok = restored.scout.did === scout.did
    && restored.scribe.did === scribe.did
    && restored.scout.privateKeyPem === scout.privateKeyPem
    && restored.scribe.privateKeyPem === scribe.privateKeyPem;

  if (!ok) throw new Error('Atkūrimo patikra nepavyko — kopija NEPATIKIMA.');

  console.log(`Kopija įrašyta: ${target}`);
  console.log('Atkūrimo patikra: OK — failas atidarytas ir abu raktai sutampa.\n');
  console.log('Ką daryti toliau:');
  console.log('  1. Nukopijuokite šį failą į bent vieną vietą ne šiame kompiuteryje.');
  console.log('  2. Slaptafrazę laikykite atskirai nuo failo. Failas + slaptafrazė = abi tapatybės.');
  console.log('  3. Slaptafrazės atkurti neįmanoma. Jei ją pamiršite, kopija yra beverte.\n');
}

main().catch((err) => {
  console.error('\nKlaida:', err.message);
  process.exit(1);
});
