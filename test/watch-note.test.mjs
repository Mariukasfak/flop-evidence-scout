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

/**
 * Four minutes after the channel opened, the watcher sent the same kibble
 * counters twice. Steady state is a real observation and the bot cannot know
 * it already said it — but each note wakes a live session, so an unchanged
 * reading repeated every few minutes is how a useful channel becomes noise.
 */
describe('watcher notes: saying the same thing twice', () => {
  const KIBBLE = 'Kibble stats: agents 3171, jobs 61581, kibble-score-v2';
  const at = (iso) => () => new Date(iso);

  test('an identical note inside the window is not written again', () => {
    const inbox = tmpInbox();
    assert.ok(appendNote(KIBBLE, { inbox, now: at('2026-09-02T17:39:00Z') }));
    assert.equal(appendNote(KIBBLE, { inbox, now: at('2026-09-02T17:42:00Z') }), null);
    assert.equal(fs.readFileSync(inbox, 'utf8').trim().split('\n').length, 1);
  });

  test('the same note is news again once the window has passed', () => {
    const inbox = tmpInbox();
    appendNote(KIBBLE, { inbox, now: at('2026-09-02T17:39:00Z') });
    assert.ok(appendNote(KIBBLE, { inbox, now: at('2026-09-02T20:00:00Z') }), 'three hours later it is worth saying');
  });

  test('a changed number gets through — that is the whole point', () => {
    const inbox = tmpInbox();
    appendNote(KIBBLE, { inbox, now: at('2026-09-02T17:39:00Z') });
    const changed = appendNote('Kibble stats: agents 3180, jobs 61600, kibble-score-v2', { inbox, now: at('2026-09-02T17:42:00Z') });
    assert.ok(changed, 'different counters are a different observation');
    assert.equal(fs.readFileSync(inbox, 'utf8').trim().split('\n').length, 2);
  });

  test('a different sender saying the same thing is still the same thing', () => {
    const inbox = tmpInbox();
    appendNote(KIBBLE, { inbox, source: 'grok', now: at('2026-09-02T17:39:00Z') });
    assert.equal(appendNote(KIBBLE, { inbox, source: 'claude', now: at('2026-09-02T17:40:00Z') }), null);
  });

  test('the rules header is not mistaken for an entry', () => {
    const inbox = tmpInbox();
    fs.writeFileSync(inbox, '# Pasiūlymų dėžutė\n\n- viena eilutė be laiko žymos\n');
    assert.ok(appendNote(KIBBLE, { inbox, now: at('2026-09-02T17:39:00Z') }));
  });
});
