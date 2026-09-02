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

/** How long an identical note stays "already said". */
export const REPEAT_WINDOW_MS = 2 * 60 * 60_000;

const ENTRY = /^- (\S+) \| [^|]* \| (.*)$/;

/**
 * Has this exact note already been made recently?
 *
 * Within four minutes of the channel opening, the watcher sent the same kibble
 * counters twice - `agents 3171, jobs 61581` both times. That is not a fault
 * in the bot: steady state is genuinely what it found, and a watcher cannot
 * know what it told us before. But every note becomes a notification in a live
 * session, so an unchanged reading repeated every few minutes turns the useful
 * channel into a channel nobody reads.
 *
 * The daemon already solves this for its own room messages ("Deduplikacija:
 * identiškas pranešimas jau buvo išsiųstas"); the rule is the same here, and
 * enforced at the writing end rather than asked for in a prompt, because a
 * rule the tool keeps is one the caller cannot forget.
 */
export function isRepeat(lines, body, { now = () => new Date(), windowMs = REPEAT_WINDOW_MS } = {}) {
  const cutoff = now().getTime() - windowMs;
  const wanted = body.trim();
  for (const line of lines) {
    const m = String(line).match(ENTRY);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (m[2].trim() === wanted) return true;
  }
  return false;
}

/** The tail of the inbox, or nothing when it does not exist yet. */
function recentLines(inbox, count = 200) {
  try {
    return fs.readFileSync(inbox, 'utf8').split('\n').slice(-count);
  } catch {
    return [];
  }
}

/**
 * Append one note. Returns the line written, or `null` when it repeats one
 * already made inside the window — the caller says so rather than failing,
 * because repeating yourself is not an error, it just is not news.
 */
export function appendNote(text, { inbox = INBOX, source = 'watcher', now = () => new Date(), windowMs = REPEAT_WINDOW_MS } = {}) {
  const body = oneLine(text);
  if (!body) throw new Error('tuscias irasas - parasyk, ka pastebejai');
  if (isRepeat(recentLines(inbox), body, { now, windowMs })) return null;
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
  const written = appendNote(text, { source: process.env.WATCH_SOURCE || 'watcher' });
  console.log(written ?? 'praleista: toks pat irasas jau buvo per pastarasias 2 val. Rasyk tik tai, kas pasikeite.');
}
