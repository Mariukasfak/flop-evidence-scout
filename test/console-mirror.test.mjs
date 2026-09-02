import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mirrorConsole, trimToTail } from '../src/console-mirror.mjs';
import { collect } from '../tools/watch-brief.mjs';

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-')), 'daemon-console.log');
}

/** A console stand-in, so a test never wraps the real one. */
function fakeConsole() {
  const seen = [];
  return { seen, log: (...a) => seen.push(['log', ...a]), warn: (...a) => seen.push(['warn', ...a]), error: (...a) => seen.push(['error', ...a]) };
}

describe('console mirror', () => {
  test('writes what was printed, keeps printing it, and restores the console', () => {
    const file = tmpLog();
    const target = fakeConsole();

    const restore = mirrorConsole(file, { target });
    target.log('[Agent #1 - Scout] DID: did:key:zAbc');
    target.warn('serveris nepasiekiamas');
    restore();
    target.log('po atstatymo');

    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.includes('[Agent #1 - Scout] DID: did:key:zAbc'));
    assert.ok(written.includes('[warn] serveris nepasiekiamas'));
    assert.equal(written.includes('po atstatymo'), false, 'restore() must stop the mirror');
    assert.equal(target.seen.length, 3, 'the screen still got every line, including after restore');
  });

  test('every line carries a timestamp, so an outage can be placed in time', () => {
    const file = tmpLog();
    const target = fakeConsole();
    const restore = mirrorConsole(file, { target, now: () => new Date('2026-09-02T18:00:00.000Z') });
    target.log('ciklas baigtas');
    restore();
    assert.match(fs.readFileSync(file, 'utf8'), /^2026-09-02T18:00:00\.000Z ciklas baigtas$/m);
  });

  test('an Error is written readably rather than as {}', () => {
    const file = tmpLog();
    const target = fakeConsole();
    const restore = mirrorConsole(file, { target });
    target.error('nepavyko:', new Error('HTTP 503'));
    restore();
    assert.match(fs.readFileSync(file, 'utf8'), /nepavyko: Error: HTTP 503/);
  });

  test('the file stops growing: it is trimmed to its tail, on a line boundary', () => {
    const file = tmpLog();
    const target = fakeConsole();
    const restore = mirrorConsole(file, { target, maxBytes: 4000 });
    for (let i = 0; i < 400; i += 1) target.log(`eilutė ${i} ${'x'.repeat(60)}`);
    restore();

    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.length < 8000, `trimmed, got ${written.length} bytes`);
    assert.ok(written.includes('eilutė 399'), 'the newest line survives');
    assert.equal(written.includes('eilutė 0 '), false, 'the oldest is gone');
    assert.equal(written.split('\n')[0].startsWith('[console-mirror]') || /^\d{4}-/.test(written.split('\n')[0]), true,
      'the file never begins mid-line');
  });

  test('a broken log path never takes the daemon down', () => {
    const target = fakeConsole();
    const restore = mirrorConsole(path.join(os.tmpdir(), 'mirror-nope', '\0bad', 'x.log'), { target });
    assert.doesNotThrow(() => target.log('vis tiek turi veikti'));
    restore();
    assert.equal(target.seen.length, 1, 'and the line still reached the screen');
  });

  test('trimToTail leaves a short file alone', () => {
    const file = tmpLog();
    fs.writeFileSync(file, 'trumpa\n');
    assert.equal(trimToTail(file, 1000), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'trumpa\n');
  });
});

/**
 * The brief is what an outside watcher reads instead of guessing. On the day it
 * was written, the watcher had reported a heartbeat "two days old" that was two
 * minutes old — so the numbers here have to come from the audit log itself.
 */
describe('watch brief: the hour it summarises', () => {
  const now = Date.now();
  const at = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();

  test('counts only the last hour, and groups errors by shape', () => {
    const audit = [
      { timestamp: at(90), event: 'cycle_timing', cycleMs: 60_000 },              // too old
      { timestamp: at(30), event: 'cycle_timing', cycleMs: 100_000 },
      { timestamp: at(10), event: 'cycle_timing', cycleMs: 200_000 },
      { timestamp: at(20), agent: 'tclk', error: 'Technocore read error: HTTP 503 Service Unavailable' },
      { timestamp: at(15), agent: 'scout', error: 'Technocore read error: HTTP 503 Service Unavailable' },
      { timestamp: at(5), agent: 'mailbox', error: 'Failed to read mailbox mb-p-scout-2d0b660964458e: boom' },
      { timestamp: at(4), agent: 'mailbox', error: 'Failed to read mailbox mb-p-scout-99ff11ee00dd22: boom' },
      { timestamp: at(12), event: 'lease_degraded' },
      { timestamp: at(8), event: 'outage', downMin: 2 },
      { timestamp: at(3), event: 'restart_for_update' }
    ];

    const s = collect(audit);

    assert.equal(s.cyclesLastHour, 2, 'the 90-minute-old cycle is outside the window');
    assert.equal(s.avgCycleMs, 150_000);
    assert.equal(s.leaseWarnings, 1);
    assert.equal(s.outages, 1);
    assert.equal(s.restarts, 1);

    const errors = Object.fromEntries(s.errors);
    assert.equal(errors['Technocore read error: HTTP 503 Service Unavailable'], 2);
    assert.equal(errors['Failed to read mailbox mb-p-scout-#: boom'], 2,
      'two different mailbox ids are one problem, not two');
  });

  test('an empty log is a report of nothing, not a crash', () => {
    const s = collect([]);
    assert.equal(s.cyclesLastHour, 0);
    assert.equal(s.avgCycleMs, null);
    assert.deepEqual(s.errors, []);
  });
});
