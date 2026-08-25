import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Antigravity tiltas yra vienintele Python vieta sistemoje. Windows Python numatytai
// naudoja konsoles koduote (cia cp1257), todel bet kuri lietuviska raide sukeldavo
// UnicodeDecodeError, agentapi isvestis tapdavo None ir Gemini nustodavo veikti visiskai.
// Sis testas yra pigi apsauga, kad nustatymas nedingtu per busimus pertvarkymus.
describe('Antigravity bridge encoding', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('../tools/antigravity_council.py', import.meta.url)),
    'utf-8'
  );

  test('every subprocess call decodes as utf-8', () => {
    const textCalls = source.match(/text=True/g) ?? [];
    const utf8Calls = source.match(/encoding="utf-8"/g) ?? [];
    assert.ok(textCalls.length > 0, 'expected the bridge to spawn subprocesses');
    assert.ok(
      utf8Calls.length >= textCalls.length,
      `every text=True subprocess needs an explicit encoding="utf-8" (found ${textCalls.length} text calls, ${utf8Calls.length} utf-8 declarations)`
    );
  });

  test('the standard streams are reconfigured to utf-8', () => {
    for (const stream of ['stdout', 'stderr', 'stdin']) {
      assert.ok(
        source.includes(`sys.${stream}.reconfigure(encoding="utf-8")`),
        `sys.${stream} must be reconfigured to utf-8`
      );
    }
  });
});
