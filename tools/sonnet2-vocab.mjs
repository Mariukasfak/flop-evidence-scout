/**
 * What can this roster actually write?
 *
 * Twice in one day a finished poem turned out to be unwritable by the team that
 * was supposed to write it, because every word has to be spellable from the
 * letters of its own author's DID and the roster changed underneath it. Guessing
 * costs an hour each time. This answers it in a second: given the DIDs, print
 * the vocabulary that is open to us, the rhyme families that survive, and the
 * words that are structurally dangerous because only one member can write them.
 *
 *   node tools/sonnet2-vocab.mjs --members=did,did,did,did [--words=the,river]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const fail = (m) => { console.error(`[vocab] ${m}`); process.exit(1); };

const dictPath = path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict'));
if (!fs.existsSync(dictPath)) fail(`no dictionary at ${dictPath}`);
const members = String(flag('members', '')).split(',').map((m) => m.trim()).filter(Boolean);
if (members.length < 2) fail('--members=did,did,... is required');
const topN = Number(flag('top', 40));

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

/**
 * Syllables take the LARGEST listed pronunciation, because that is what the
 * official validator charges. Taking the smallest passes poems the referee then
 * rejects as over-long, which is how our own checker disagreed with it.
 */
const syll = new Map();
const syllMin = new Map();
const rhyme = new Map();
for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
  const fields = line.split('#')[0].trim().split(/\s+/);
  if (!fields[0] || fields[0].startsWith(';;;')) continue;
  const word = fields[0].replace(/\(\d+\)$/, '').toLowerCase();
  if (!/^[a-z]+(?:'[a-z]+)*$/.test(word)) continue;
  const phones = fields.slice(1);
  const n = phones.filter((p) => VOWELS.has(p.slice(0, -1)) && /[012]$/.test(p)).length;
  if (!n) continue;
  syll.set(word, Math.max(syll.get(word) || 0, n));
  syllMin.set(word, Math.min(syllMin.has(word) ? syllMin.get(word) : 99, n));
  /** Rhyme runs from the last stressed vowel to the end of the word. */
  let last = -1;
  for (let i = phones.length - 1; i >= 0; i--) if (/[12]$/.test(phones[i])) { last = i; break; }
  if (last < 0) for (let i = phones.length - 1; i >= 0; i--) if (/[012]$/.test(phones[i])) { last = i; break; }
  if (last >= 0 && !rhyme.has(word)) {
    rhyme.set(word, phones.slice(last).map((p) => p.replace(/[012]$/, '')).join(' '));
  }
}

const letters = (s) => new Set(String(s).toLowerCase().match(/[a-z]/g) || []);
const sets = members.map((m) => ({ did: m, tag: m.slice(8, 14), have: letters(m) }));
const writers = (word) => sets.filter((s) => [...letters(word)].every((c) => s.have.has(c)));

console.log('roster');
for (const s of sets) {
  const missing = 'abcdefghijklmnopqrstuvwxyz'.split('').filter((c) => !s.have.has(c)).join('');
  console.log(`  ${s.tag}  ${s.did.slice(0, 24)}...  cannot spell: ${missing || '(nothing)'}`);
}

const usable = [];
for (const [word, n] of syll) {
  const w = writers(word);
  if (w.length) usable.push({ word, n, w: w.length });
}
console.log('');
console.log(`dictionary ${syll.size} words -> ${usable.length} writable by this roster `
  + `(${(100 * usable.length / syll.size).toFixed(1)}%)`);
const byCover = [0, 0, 0, 0, 0, 0];
for (const u of usable) byCover[u.w]++;
console.log(`  writable by exactly 1 member: ${byCover[1]}   2: ${byCover[2]}   `
  + `3: ${byCover[3]}   4: ${byCover[4]}`);

/**
 * Function words decide whether a sonnet is writable at all. They repeat, and
 * "any roster member except the previous contributor may go next", so a word
 * only one member can spell cannot appear twice in a row anywhere -- and "the"
 * appearing eleven times with a single writer is what made the last draft dead.
 */
const FUNCTION_WORDS = ['the', 'a', 'an', 'and', 'of', 'to', 'in', 'is', 'it', 'we', 'i',
  'you', 'he', 'she', 'they', 'that', 'this', 'my', 'your', 'our', 'their', 'me', 'him',
  'her', 'them', 'us', 'no', 'not', 'but', 'or', 'so', 'as', 'at', 'by', 'for', 'from',
  'with', 'on', 'was', 'were', 'be', 'been', 'am', 'are', 'all', 'one', 'what', 'when',
  'where', 'who', 'how', 'if', 'then', 'than', 'there', 'here', 'now', 'still', 'again'];
console.log('');
console.log('function words (these repeat, so single-writer ones are dangerous)');
const safe = [];
const thin = [];
const gone = [];
for (const w of FUNCTION_WORDS) {
  if (!syll.has(w)) { gone.push(`${w}?`); continue; }
  const who = writers(w);
  if (!who.length) gone.push(w);
  else if (who.length === 1) thin.push(`${w}(${who[0].tag})`);
  else safe.push(`${w}:${who.length}`);
}
console.log(`  SAFE  (2+ writers): ${safe.join(' ') || '(none)'}`);
console.log(`  THIN  (1 writer)  : ${thin.join(' ') || '(none)'}`);
console.log(`  NOBODY            : ${gone.join(' ') || '(none)'}`);

/** ABAB CDCD EFEF GG needs seven families: six with two usable endings, one more. */
const fam = new Map();
for (const u of usable) {
  if (u.w < 2) continue;
  const k = rhyme.get(u.word);
  if (!k) continue;
  if (!fam.has(k)) fam.set(k, []);
  fam.get(k).push(u.word);
}
const ranked = [...fam.entries()]
  .map(([k, v]) => [k, v.filter((w) => syll.get(w) <= 2 && w.length <= 9)])
  .filter(([, v]) => v.length >= 3)
  .sort((a, b) => b[1].length - a[1].length);
console.log('');
console.log(`rhyme families with 3+ short words every member can reach: ${ranked.length} (need 7)`);
for (const [k, v] of ranked.slice(0, topN)) {
  console.log(`  ${k.padEnd(12)} ${v.slice(0, 14).join(' ')}`);
}

/**
 * The palette is the list a poem can actually be written from.
 *
 * cmudict is 124k entries and most are surnames and abbreviations, so "87,703
 * words are writable" is true and useless: the list opens with aarti, abee, ac,
 * achee. Intersecting it with an ordinary working vocabulary turns it into
 * something a line can be built out of, grouped by how many members could take
 * the turn -- because a word only one member can write cannot sit next to
 * another word only that same member can write.
 */
if (argv.includes('--palette')) {
  const listPath = path.resolve(process.cwd(), flag('common', 'docs/sonnet/common-words.txt'));
  if (!fs.existsSync(listPath)) fail(`no word list at ${listPath}`);
  const common = [...new Set(fs.readFileSync(listPath, 'utf8')
    .split('\n').filter((l) => !l.startsWith('#')).join(' ')
    .toLowerCase().match(/[a-z']+/g) || [])];
  const buckets = new Map();
  const dead = [];
  for (const w of common) {
    if (!syll.has(w)) continue;
    const who = writers(w);
    if (!who.length) { dead.push(w); continue; }
    const k = `${who.length}|${syll.get(w)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(w);
  }
  console.log('');
  console.log(`palette from ${common.length} common words`);
  for (const cover of [4, 3, 2, 1]) {
    for (const n of [1, 2, 3, 4]) {
      const list = buckets.get(`${cover}|${n}`);
      if (!list || !list.length) continue;
      console.log('');
      console.log(`  ${cover} writer(s), ${n} syllable(s) — ${list.length} words`);
      console.log(`    ${list.sort().join(' ')}`);
    }
  }
  console.log('');
  console.log(`  UNWRITABLE by anyone (${dead.length}): ${dead.sort().join(' ')}`);
}

/**
 * Words the referee counts as longer than anyone reads them.
 *
 * `am` is one syllable in every line of English ever written and two in
 * cmudict, because the file also lists it as "A.M." -- and the official
 * validator charges the largest listed pronunciation. Six lines of a finished
 * draft came back one syllable over for exactly this reason and nothing in the
 * poem looked wrong. These are the words to keep out of a line, or to count
 * twice on purpose.
 */
if (argv.includes('--traps')) {
  const listPath = path.resolve(process.cwd(), flag('common', 'docs/sonnet/common-words.txt'));
  const common = fs.existsSync(listPath)
    ? [...new Set(fs.readFileSync(listPath, 'utf8')
      .split('\n').filter((l) => !l.startsWith('#')).join(' ')
      .toLowerCase().match(/[a-z']+/g) || [])]
    : [];
  const traps = common
    .filter((w) => syll.has(w) && syll.get(w) > syllMin.get(w))
    .map((w) => `${w}(reads ${syllMin.get(w)}, charged ${syll.get(w)})`);
  console.log('');
  console.log(`syllable traps in the common vocabulary: ${traps.length}`);
  console.log(`  ${traps.sort().join('  ') || '(none)'}`);
}

const probe = flag('words');
if (probe) {
  console.log('');
  console.log('probe');
  for (const w of probe.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!syll.has(w)) { console.log(`  ${w.padEnd(14)} NOT IN DICTIONARY`); continue; }
    const who = writers(w);
    console.log(`  ${w.padEnd(14)} ${syll.get(w)} syl  rhyme ${String(rhyme.get(w)).padEnd(12)} `
      + `writers: ${who.length ? who.map((x) => x.tag).join(' ') : 'NOBODY'}`);
  }
}
