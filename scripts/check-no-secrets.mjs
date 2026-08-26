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
import path from 'node:path';

const PEM_WITH_BODY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{40,}/;
const SECRET_PATHS = /^\.secrets\//;

/**
 * Credentials that are not key material. The scan below deliberately looks for
 * a *labelled* secret next to a value — "password: hunter2" — rather than trying
 * to recognise passwords by shape, which cannot be done and produces a check
 * nobody trusts. Documenting a credential in a README is exactly how the one
 * real leak here happened.
 */
const CREDENTIAL_PATTERNS = [
  {
    what: 'a password or passphrase written next to its label',
    re: /(?:password|passphrase|slaptažod\w*|slaptazod\w*|slaptafraz\w*)\s*(?:is|:|=)\s*[`"'][^`"'\r\n]{6,}[`"']/i
  },
  {
    what: 'an API key or token assigned inline',
    re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*[`"'][A-Za-z0-9_\-]{16,}[`"']/i
  }
];

/**
 * The credential scan runs on prose and config, not on source. Source legitimately
 * contains the word "passphrase" beside expressions and test fixtures, and the
 * first version of this check failed the build on its own documentation — which
 * is how a check gets switched off. Key material is caught everywhere by the PEM
 * rules above regardless of file type.
 */
const PROSE_EXTENSIONS = new Set(['.md', '.txt', '.html', '.yml', '.yaml', '.json']);

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

  // A password did get committed once — in two public files at the same time,
  // documenting a dashboard "lock" that protected nothing. The key material scan
  // above would never have caught it, because a password is not a PEM.
  if (PROSE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      const match = content.match(pattern.re);
      if (match) findings.push(`${file}: ${pattern.what} — "${match[0].slice(0, 60)}"`);
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`::error::${finding}`);
  console.error('\nA pushed secret is public forever. Rotate the key, or change the password everywhere it is used.');
  process.exit(1);
}

console.log(`Scanned ${tracked.length} tracked files. No private key material found.`);
