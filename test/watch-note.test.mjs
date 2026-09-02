import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { oneLine, formatNote, appendNote } from '../tools/watch-note.mjs';

function tmpInbox() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-')), 'watch-inbox.md');
}

/**
 * The live channel: an outside watcher appends a line, and a monitor on this
 * file turns each new line into a notification in the running session. That
 * only works if one note is exactly one line — hence the sweep below, which
 * mirrors what the venue does to every message for the same reason.
 */
describe('watcher notes', () => {
  test('a note is one line, whatever was pasted in', () => {
    assert.equal(oneLine('dvi\neilutės\tir  tarpai'), 'dvi eilutės ir tarpai');
    assert.equal(oneLine('a\r\nb'), 'a b');
    assert.equal(oneLine('  apkarpyta  '), 'apkarpyta');
  });

  test('zero-width and bidi characters are swept, not stored', () => {
    // Text that renders as nothing is how instructions get smuggled into
    // another agent's context; the venue strips these and so does this.
    const sneaky = `matoma​‮nematoma`;
    const swept = oneLine(sneaky);
    assert.equal(swept.includes('‮'), false, 'the bidi override is gone');
    assert.ok(swept.startsWith('matoma'));
  });

  test('a very long note is cut rather than refused', () => {
    const long = 'x'.repeat(2000);
    assert.equal(oneLine(long).length, 800);
  });

  test('the line carries when it arrived and who sent it', () => {
    const line = formatNote('Technocore 0.11.5', { now: () => new Date('2026-09-02T18:00:00Z'), source: 'grok' });
    assert.equal(line, '- 2026-09-02T18:00:00.000Z | grok | Technocore 0.11.5');
  });

  test('notes append, so an earlier one is never overwritten', () => {
    const inbox = tmpInbox();
    appendNote('pirmas', { inbox, now: () => new Date('2026-09-02T18:00:00Z') });
    appendNote('antras', { inbox, now: () => new Date('2026-09-02T18:05:00Z') });

    const lines = fs.readFileSync(inbox, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith('pirmas'));
    assert.ok(lines[1].endsWith('antras'));
  });

  test('an empty note is refused, because a notification with nothing in it wastes a look', () => {
    const inbox = tmpInbox();
    assert.throws(() => appendNote('   ', { inbox }), /tuscias/);
    assert.equal(fs.existsSync(inbox), false);
  });
});
