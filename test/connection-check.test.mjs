import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('connection checker exercises the same three live provider adapters without stale Claude flags', () => {
  const source = fs.readFileSync(path.resolve('tools/check-connection.mjs'), 'utf8');
  assert.match(source, /createLocalProviders/);
  assert.match(source, /provider\.generate/);
  assert.match(source, /phase:\s*'proposal'/);
  assert.doesNotMatch(source, /--max-turns/);
  assert.doesNotMatch(source, /--permission-mode/);
  assert.doesNotMatch(source, /tik darbininkas|worker-only/i);
});
