import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * No control characters in the source.
 *
 * A word-boundary escape once reached src/scribe-engine.mjs as two literal
 * backspaces. The regex still parsed, still looked right in most editors, and
 * matched nothing, so the faucet radar reported HIT on spam rooms for five
 * weeks. Tab, newline and carriage return are the only ones source needs.
 */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

test('src/ holds no control characters', () => {
  const offenders = [];
  for (const file of sourceFiles('src')) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (CONTROL.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
