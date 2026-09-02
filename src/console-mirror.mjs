/**
 * A copy of what the daemon prints, on disk.
 *
 * The launcher window was the only place this output ever existed:
 * `paleisti-nuolat.bat` runs node with no redirect, so closing the window took
 * the log with it. `scout-audit.jsonl` records decisions, not the console —
 * which meant "look at the logs" really meant "watch the screen live", and
 * nobody, human or supervisor, can do that around the clock. This was found
 * on 2026-09-02 while working out what an outside watcher could actually read:
 * the answer was nothing, because the file did not exist.
 *
 * Kept small on purpose. `inference-receipts.jsonl` reached 69 MB before
 * anyone noticed; a log nobody trims is a log that fills the disk. This one
 * keeps its tail and drops the rest.
 *
 * Never fatal. A logging error must not take down the process whose behaviour
 * it is only observing, so every filesystem call here swallows its failure.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Roughly a day of ordinary output at the current cycle rate. */
export const DEFAULT_MAX_BYTES = 5_000_000;

/** How much of the tail survives a trim: enough to keep the recent picture. */
const KEEP_FRACTION = 0.6;

/**
 * Drop everything but the last `keep` bytes, cutting on a line boundary so the
 * file never starts mid-sentence.
 */
export function trimToTail(logPath, keep) {
  try {
    const buf = fs.readFileSync(logPath);
    if (buf.length <= keep) return false;
    const tail = buf.subarray(buf.length - keep);
    const nl = tail.indexOf(0x0a);
    const cut = nl === -1 ? tail : tail.subarray(nl + 1);
    fs.writeFileSync(logPath, Buffer.concat([
      Buffer.from(`[console-mirror] ankstesnės eilutės nukirptos ${new Date().toISOString()}\n`),
      cut
    ]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Send every console line to `logPath` as well as to the screen.
 *
 * Returns a function that puts the original console back, so a test can undo
 * it and the process is never left writing to a file it no longer owns.
 */
export function mirrorConsole(logPath, {
  maxBytes = DEFAULT_MAX_BYTES,
  target = console,
  now = () => new Date()
} = {}) {
  const original = { log: target.log, warn: target.warn, error: target.error };

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch { /* the mirror is not worth failing the run over */ }

  let sinceCheck = 0;

  const write = (level, args) => {
    let line;
    try {
      line = args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
    } catch {
      return;
    }
    const stamp = now().toISOString();
    const prefix = level === 'log' ? '' : `[${level}] `;
    const record = `${stamp} ${prefix}${line}\n`;
    try {
      fs.appendFileSync(logPath, record, 'utf8');
      sinceCheck += record.length;
      // Checking the real size on every line would stat the file thousands of
      // times an hour; counting what we wrote is enough to know when to look.
      if (sinceCheck > maxBytes / 10) {
        sinceCheck = 0;
        const { size } = fs.statSync(logPath);
        if (size > maxBytes) trimToTail(logPath, Math.floor(maxBytes * KEEP_FRACTION));
      }
    } catch { /* see the header: never fatal */ }
  };

  for (const level of ['log', 'warn', 'error']) {
    target[level] = (...args) => {
      write(level, args);
      original[level].apply(target, args);
    };
  }

  return function restore() {
    target.log = original.log;
    target.warn = original.warn;
    target.error = original.error;
  };
}

/** Enough of a non-string to be readable in a log, without pulling in util. */
function inspect(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
