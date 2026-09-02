/**
 * One line from an outside watcher, appended where this session will see it.
 *
 * The suggestion box written earlier was a file somebody had to remember to
 * open, which is not what the operator asked for: the point of putting a Grok
 * bot on this machine is that it says "Technocore just shipped 0.11.4" while
 * that is still news, rather than leaving it somewhere to be found later. So
 * this appends to `watch-inbox.md`, and a monitor on that file turns each new
 * line into a notification in the live Claude session.
 *
 * Deliberately tiny, because the caller is a bot with a shell: one argument,
 * no flags, no config, nothing to get wrong.
 *
 *   node tools/watch-note.mjs "Technocore 0.11.5 isejo, /patterns.md pasikeite"
 *
 * The line is data. It is read, checked, and shown to the operator; it is not
 * a command, and nothing in this file makes anything happen on its own.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.SCOUT_DATA_DIR || path.resolve('data/local');
const INBOX = path.join(DATA, 'watch-inbox.md');

/** The sweep the venue itself applies to every message: Cc, Cf, Cs, Co, Zl, Zp. */
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]+/gu;

/**
 * Collapse to a single line before writing.
 *
 * The venue we talk to strips newlines from every message for exactly this
 * reason - one record per line is what makes a log readable, and text that
 * renders as nothing is how instructions get smuggled into someone's context.
 * The same rule is worth keeping on our own disk: the monitor that reads this
 * file emits one notification per line, so a multi-line note would arrive as
 * unrelated fragments.
 */
export function oneLine(text, { maxChars = 800 } = {}) {
  return String(text ?? '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

export function formatNote(text, { now = () => new Date(), source = 'watcher' } = {}) {
  return `- ${now().toISOString()} | ${source} | ${oneLine(text)}`;
}

export function appendNote(text, { inbox = INBOX, source = 'watcher', now = () => new Date() } = {}) {
  const body = oneLine(text);
  if (!body) throw new Error('tuscias irasas - parasyk, ka pastebejai');
  const line = formatNote(body, { source, now });
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  fs.appendFileSync(inbox, `${line}\n`, 'utf8');
  return line;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith('watch-note.mjs');
if (isDirectRun) {
  const text = process.argv.slice(2).join(' ');
  if (!oneLine(text)) {
    console.error('Naudojimas: node tools/watch-note.mjs "ka pastebejai"');
    process.exit(1);
  }
  console.log(appendNote(text, { source: process.env.WATCH_SOURCE || 'watcher' }));
}
