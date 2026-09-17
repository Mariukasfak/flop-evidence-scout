/**
 * The one place the poem becomes bytes.
 *
 * Publication and submission must agree exactly: the referee rebuilds the text
 * from the posts listed in `x_post_ids` and compares its hash to the
 * `poem_sha256` in the packet. Two implementations of "turn the room into a
 * poem" is two chances to disagree, and disagreeing is the single most common
 * way to lose this contest -- 76 of its 150 rejections are
 * `publication: unverified`. So both tools read this file.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

/** MAX pronunciation, because that is the count the official validator charges. */
export function loadSyllables(dictPath) {
  const syll = new Map();
  for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
    const fd = line.split('#')[0].trim().split(/\s+/);
    if (!fd[0] || fd[0].startsWith(';;;')) continue;
    const w = fd[0].replace(/\(\d+\)$/, '').toLowerCase();
    const n = fd.slice(1).filter((ph) => VOWELS.has(ph.slice(0, -1)) && /[012]$/.test(ph)).length;
    if (n) syll.set(w, Math.max(syll.get(w) || 0, n));
  }
  return syll;
}

/** A room export is JSON lines, or a JSON array if something has wrapped it. */
export function parseRoom(text) {
  const raw = text.trim();
  const rows = JSON.parse(raw.startsWith('[') ? raw : `[${raw.split('\n').filter(Boolean).join(',')}]`);
  const frames = [];
  for (const row of rows) {
    let f; try { f = JSON.parse(row.text); } catch { continue; }
    frames.push({ row, f });
  }
  return frames;
}

/**
 * What the referee has actually accepted in this room: the words in turn order,
 * who wrote the last one, the version to quote, and the room's generation.
 */
export function readLedger(frames) {
  const accepted = new Set();
  let generation = null;
  let finalVersion = null;
  let lastWriter = null;
  let complete = false;
  for (const { f } of frames) {
    const items = f.type === 'sonnet.receipts.v1' ? (f.receipts || []) : [f];
    for (const it of items) {
      if (!String(it.type || '').startsWith('sonnet.receipt')) continue;
      if (it.status !== 'accepted') continue;
      if (it.request_id) accepted.add(it.request_id);
      if (it.room_generation !== undefined && it.room_generation !== null) generation = it.room_generation;
      if (typeof it.version === 'number' && (finalVersion === null || it.version > finalVersion)) {
        finalVersion = it.version;
        if (it.sender_did) lastWriter = it.sender_did;
        complete = it.complete === true;
      }
    }
  }
  /**
   * One word per version, not one per frame: an agent that misses its receipt
   * re-posts the same word, and counting frames rebuilt a finished sonnet as
   * 127 words -- "I say your name before I I I let".
   */
  const byVersion = new Map();
  for (const { f } of frames) {
    if (f.type !== 'sonnet.word.v1' || !accepted.has(f.request_id)) continue;
    const v = Number(f.version);
    if (!Number.isFinite(v) || byVersion.has(v)) continue;
    byVersion.set(v, { word: String(f.word), by: f.sender_did || null });
  }
  const ordered = [...byVersion.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  if (!lastWriter && ordered.length) lastWriter = ordered[ordered.length - 1].by;
  return { words: ordered.map((w) => w.word), lastWriter, finalVersion, generation, complete };
}

/**
 * The room stores words, not line breaks, so the lines are rebuilt the way the
 * validator counts them: accumulate until the line reaches ten syllables.
 */
export function linesFromWords(words, syll) {
  const count = (w) => syll.get(w.toLowerCase().replace(/[^a-z']/g, '')) || 0;
  const lines = [];
  let cur = [];
  let n = 0;
  for (const w of words) {
    cur.push(w);
    n += count(w);
    if (n >= 10) { lines.push(cur.join(' ')); cur = []; n = 0; }
  }
  if (cur.length) lines.push(cur.join(' '));
  return lines;
}

/**
 * Canonical text exactly as the spec defines it: one ASCII space between words,
 * LF between lines, one blank line between the 4/4/4/2 stanzas, no terminal
 * newline. The hash is over these bytes and nothing else.
 */
export function canonicalText(lines) {
  return [lines.slice(0, 4), lines.slice(4, 8), lines.slice(8, 12), lines.slice(12, 14)]
    .map((s) => s.join('\n')).join('\n\n');
}

export const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Split between whole lines only, never inside one, never across a stanza break. */
export function splitPosts(canonical, limit = 280) {
  const posts = [];
  let cur = '';
  for (const block of canonical.split('\n\n')) {
    for (const line of block.split('\n')) {
      const next = cur ? `${cur}\n${line}` : line;
      if ([...next].length > limit) { posts.push(cur); cur = line; } else { cur = next; }
    }
    const withGap = `${cur}\n`;
    if (cur && [...withGap].length <= limit) cur = withGap;
  }
  if (cur.trim()) posts.push(cur.replace(/\n+$/, ''));
  return posts;
}
