/**
 * Check a proposed sonnet before anyone signs a word of it.
 *
 * Three things have to hold at once and only one of them is about poetry:
 *
 *  1. Ten syllables per completed line, counted from the frozen `cmudict.dict`
 *     the contest pins — not from a guess. "Lines close automatically at 10
 *     syllables; a word that would overflow the line is rejected."
 *  2. Every word must be in that dictionary at all.
 *  3. Every word must be spellable from the letters of **its own author's DID**.
 *     Our roster has one or two members carrying the letter `o`, and
 *     `did:key:z6Mk...` supplies none, so a line full of "of/to/from" is a line
 *     only some of us can write. This prints, per word, who is able to.
 *
 * The turn rule matters too: "any roster member except the previous contributor
 * may go next", so a run of words only one member can spell is unwritable no
 * matter how good it sounds. That is reported as a blocking conflict.
 *
 *   node tools/sonnet2-check.mjs --poem=poem.txt --members=did,did,did
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const fail = (m) => { console.error(`[check] ${m}`); process.exit(1); };

const dictPath = path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict'));
if (!fs.existsSync(dictPath)) fail(`no dictionary at ${dictPath} — fetch cmudict.dict from the contest repo`);
const poemPath = flag('poem');
if (!poemPath) fail('--poem=<file> is required');
const members = String(flag('members', '')).split(',').map((m) => m.trim()).filter(Boolean);
if (!members.length) fail('--members=did,did,... is required');

/** Syllables are vowel-carrying phones; cmudict marks stress with a trailing digit. */
const syllables = new Map();
for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith(';;;')) continue;
  const [wordRaw, ...phones] = line.trim().split(/\s+/);
  const word = wordRaw.replace(/\(\d+\)$/, '').toLowerCase();
  const count = phones.filter((p) => /\d/.test(p)).length;
  if (!syllables.has(word) || syllables.get(word) > count) syllables.set(word, count);
}

const A = 'abcdefghijklmnopqrstuvwxyz';
const lettersOf = (did) => new Set([...did.toLowerCase()].filter((c) => A.includes(c)));
const memberLetters = members.map((m) => ({ did: m, tag: m.slice(8, 14), letters: lettersOf(m) }));

const lines = fs.readFileSync(poemPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
let bad = 0;

console.log(`dictionary ${syllables.size} words   roster ${members.length}`);
for (const m of memberLetters) {
  console.log(`  ${m.tag}  missing: ${[...A].filter((c) => !m.letters.has(c)).join('') || '(none)'}`);
}
console.log('');

if (lines.length !== 14) {
  console.log(`!! ${lines.length} lines, the form needs 14`);
  bad += 1;
}

let previousOnly = null;
lines.forEach((line, i) => {
  const words = line.split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z']/g, '')).filter(Boolean);
  let total = 0;
  const notes = [];
  for (const w of words) {
    if (!syllables.has(w)) { notes.push(`${w}:NOT-IN-DICT`); bad += 1; continue; }
    total += syllables.get(w);
    const able = memberLetters.filter((m) => [...w.replace(/'/g, '')].every((c) => m.letters.has(c)));
    if (!able.length) { notes.push(`${w}:NOBODY`); bad += 1; continue; }
    if (able.length === 1) {
      /**
       * Two consecutive words only one member can spell cannot be written: the
       * same contributor may not take two turns in a row.
       */
      if (previousOnly && previousOnly === able[0].tag) { notes.push(`${w}:CONFLICT(${able[0].tag} twice)`); bad += 1; }
      previousOnly = able[0].tag;
      notes.push(`${w}:only ${able[0].tag}`);
    } else previousOnly = null;
  }
  const ok = total === 10;
  if (!ok) bad += 1;
  console.log(`${String(i + 1).padStart(2)}  ${ok ? ' ' : '!'}${String(total).padStart(3)}  ${line}`);
  if (notes.length) console.log(`         ${notes.join('  ')}`);
});

console.log(`\n${bad ? `${bad} problem(s)` : 'clean: 14 lines, 10 syllables each, every word writable'}`);
process.exit(bad ? 1 : 0);
