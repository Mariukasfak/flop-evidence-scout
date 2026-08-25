/**
 * Fails the build if key material is committed. A leaked agent identity cannot be
 * rotated without losing the on-network history it exists to accumulate, so this
 * is worth a CI job of its own.
 *
 * Matches on a PEM header followed by a real base64 body, not on the header
 * alone: the guardrail tests deliberately contain the header as a fixture, and a
 * check that cries wolf on its own test suite gets switched off.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const PEM_WITH_BODY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{40,}/;
const SECRET_PATHS = /^\.secrets\//;

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

const findings = [];

for (const file of tracked) {
  if (SECRET_PATHS.test(file)) {
    findings.push(`${file}: a file under .secrets/ is tracked by git`);
    continue;
  }

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    continue; // binary or unreadable — nothing to scan
  }

  if (PEM_WITH_BODY.test(content)) {
    findings.push(`${file}: contains a PEM private key with a base64 body`);
  }
  if (/"privateKeyPem"\s*:\s*"-----BEGIN/.test(content)) {
    findings.push(`${file}: contains a serialised identity with a private key`);
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`::error::${finding}`);
  console.error('\nRotate the affected key immediately; a pushed key is public forever.');
  process.exit(1);
}

console.log(`Scanned ${tracked.length} tracked files. No private key material found.`);
