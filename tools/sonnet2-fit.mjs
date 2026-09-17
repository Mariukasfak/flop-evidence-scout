/**
 * Make a finished sonnet writable by the roster that actually sealed.
 *
 * Every word must be spellable from the letters of its own author's DID, and
 * "any roster member except the previous contributor may go next" -- so a poem
 * is only writable if the whole 14-line sequence admits an assignment of words
 * to members with no two neighbours the same. The roster changes every half
 * hour while the referee runs hours behind, so a draft checked against one
 * roster is routinely dead against the next: three drafts died that way on
 * 2026-09-16 and 09-17, each costing an hour of rewriting by hand.
 *
 * This repairs a draft against a given roster: it swaps only the words that
 * cannot be written, keeping the syllable count and the line-final rhyme, and
 * then proves the turn sequence is satisfiable before writing anything out.
 *
 *   node tools/sonnet2-fit.mjs --poem=draft.txt --members=did,did,did,did --out=fitted.txt
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const fail = (m) => { console.error(`[fit] ${m}`); process.exit(1); };

const dictPath = path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict'));
if (!fs.existsSync(dictPath)) fail(`no dictionary at ${dictPath}`);
const poemPath = flag('poem');
if (!poemPath) fail('--poem=<file> is required');
const members = String(flag('members', '')).split(',').map((m) => m.trim()).filter(Boolean);
if (members.length < 2) fail('--members=did,did,... is required');
const outPath = flag('out');

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

/** MAX pronunciation, because that is what the official validator charges. */
const syll = new Map();
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
  let last = -1;
  for (let i = phones.length - 1; i >= 0; i--) if (/[12]$/.test(phones[i])) { last = i; break; }
  if (last < 0) for (let i = phones.length - 1; i >= 0; i--) if (/[012]$/.test(phones[i])) { last = i; break; }
  if (last >= 0 && !rhyme.has(word)) {
    rhyme.set(word, phones.slice(last).map((p) => p.replace(/[012]$/, '')).join(' '));
  }
}

const letters = (s) => new Set(String(s).toLowerCase().match(/[a-z]/g) || []);
const sets = members.map((m, i) => ({ i, did: m, tag: m.slice(8, 14), have: letters(m) }));
const writersOf = (word) => sets.filter((s) => [...letters(word)].every((c) => s.have.has(c))).map((s) => s.i);

/**
 * Substitutes come from an ordinary working vocabulary, not from cmudict at
 * large: the dictionary is mostly surnames, and a repair that reaches for
 * "abee" to fix a line has not helped anyone read it.
 */
const listPath = path.resolve(process.cwd(), flag('common', 'docs/sonnet/common-words.txt'));
const commonOrder = new Map();
if (fs.existsSync(listPath)) {
  const words = fs.readFileSync(listPath, 'utf8').split('\n').filter((l) => !l.startsWith('#'))
    .join(' ').toLowerCase().match(/[a-z']+/g) || [];
  words.forEach((w, i) => { if (!commonOrder.has(w)) commonOrder.set(w, i); });
}

const raw = fs.readFileSync(poemPath, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const blocks = raw.split('\n\n');
const lines = blocks.flatMap((b) => b.split('\n')).filter((l) => l.trim());
if (lines.length !== 14) fail(`expected 14 lines, got ${lines.length}`);

/**
 * Split each token into leading punctuation, the word, and trailing punctuation.
 *
 * Done by index this went wrong on the first capitalised word it met: looking
 * for the lowercased first letter inside "She" finds the *second* `s`, so the
 * lead became "Sh" and the line rebuilt as "ShShe". Match the three parts
 * directly instead.
 */
const slots = lines.map((line) => line.split(' ').map((tok) => {
  const m = tok.match(/^([^A-Za-z']*)([A-Za-z']+)(.*)$/);
  if (!m) return { w: '', lead: tok, tail: '', caps: false };
  return { w: m[2].toLowerCase(), lead: m[1], tail: m[3], caps: /^[A-Z]/.test(m[2]) };
}));

const candidatesFor = (word, needRhyme) => {
  const n = syll.get(word);
  const r = rhyme.get(word);
  const out = [];
  for (const [cand, cs] of syll) {
    if (cs !== n || cand === word) continue;
    if (needRhyme && rhyme.get(cand) !== r) continue;
    const w = writersOf(cand);
    if (!w.length) continue;
    const rank = commonOrder.has(cand) ? commonOrder.get(cand) : Infinity;
    if (rank === Infinity) continue;             // vocabulary a reader recognises
    out.push({ cand, w, rank });
  }
  /** Widest choice of writers first -- those are the words that keep turns legal. */
  return out.sort((a, b) => (b.w.length - a.w.length) || (a.rank - b.rank));
};

/**
 * Swapping a content word costs an image; swapping a function word costs the
 * sentence. Replacing "of" with the widest-writable one-syllable word produced
 * "engine a my mind", which is still a valid sonnet to the referee and no
 * longer English. These are named so the swap can be judged, and a human asked
 * to rewrite the line instead.
 */
const FUNCTION_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'be', 'been', 'but', 'by',
  'for', 'from', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my',
  'no', 'nor', 'not', 'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'they', 'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your']);

let swaps = 0;
const grammarRisk = [];
const problems = [];
for (const [li, slot] of slots.entries()) {
  for (const [wi, s] of slot.entries()) {
    if (!syll.has(s.w)) { problems.push(`line ${li + 1}: "${s.w}" is not in the dictionary`); continue; }
    if (writersOf(s.w).length) continue;
    const isLast = wi === slot.length - 1;
    const pick = candidatesFor(s.w, isLast)[0];
    if (!pick) { problems.push(`line ${li + 1}: nothing can replace "${s.w}"`); continue; }
    s.was = s.w;
    s.w = pick.cand;
    swaps++;
    if (FUNCTION_WORDS.has(s.was)) grammarRisk.push(`line ${li + 1}: "${s.was}" -> "${s.w}"`);
  }
}

/**
 * Prove the turn sequence, and repair it where it fails.
 *
 * The proof is exact: a reachability sweep over (word index, writer) where a
 * step may not repeat the previous writer. A greedy walk can paint itself into
 * a corner on a run of words only one member can spell, which is what made the
 * very first draft unwritable in seven places.
 *
 * Failing is not the end, though. Where the sweep dies, the word that killed it
 * (or the one before) is swapped for one more members can write, and the sweep
 * runs again. Measured over sixty random rosters drawn from the referee's own
 * accepted writers, repairing turns as well as spellings is what moves a draft
 * from fitting most rosters to fitting nearly all of them.
 */
const flat = slots.flat();
const turnSwaps = [];

const sweep = () => {
  const allowed = flat.map((s) => writersOf(s.w));
  const prev = flat.map(() => new Map());
  let reach = new Map();
  for (const a of allowed[0]) reach.set(a, true);
  for (let i = 1; i < flat.length; i++) {
    const next = new Map();
    for (const a of allowed[i]) {
      for (const p of reach.keys()) {
        if (p === a) continue;
        next.set(a, true);
        prev[i].set(a, p);
        break;
      }
    }
    reach = next;
    if (!reach.size) return { failedAt: i, prev, reach };
  }
  return { failedAt: -1, prev, reach };
};

let result = sweep();
for (let attempt = 0; result.failedAt >= 0 && attempt < 40; attempt++) {
  const i = result.failedAt;
  /** Widen the blocking word, or its neighbour if the blocker cannot be widened. */
  let repaired = false;
  for (const j of [i, i - 1]) {
    if (j < 0) continue;
    const s = flat[j];
    const isLast = slots.some((slot) => slot[slot.length - 1] === s);
    const better = candidatesFor(s.w, isLast).find((c) => c.w.length > writersOf(s.w).length);
    if (!better) continue;
    turnSwaps.push(`"${s.w}" -> "${better.cand}" (writers ${writersOf(s.w).length} -> ${better.w.length})`);
    if (!s.was) s.was = s.w;
    if (FUNCTION_WORDS.has(s.w)) grammarRisk.push(`turn repair: "${s.w}" -> "${better.cand}"`);
    s.w = better.cand;
    swaps++;
    repaired = true;
    break;
  }
  if (!repaired) break;
  result = sweep();
}
if (result.failedAt >= 0) {
  const i = result.failedAt;
  problems.push(`turns: no legal writer for word ${i + 1} ("${flat[i].w}") after "${flat[i - 1].w}"`);
}

const assignment = [];
if (result.failedAt < 0 && result.reach.size) {
  let cur = [...result.reach.keys()][0];
  for (let i = flat.length - 1; i >= 0; i--) { assignment[i] = cur; cur = result.prev[i].get(cur); }
}

const rebuilt = [];
let k = 0;
for (const slot of slots) {
  rebuilt.push(slot.map((s) => {
    let w = s.w;
    if (s.caps) w = w[0].toUpperCase() + w.slice(1);
    return s.lead + w + s.tail;
  }).join(' '));
  k++;
}
const text = [rebuilt.slice(0, 4), rebuilt.slice(4, 8), rebuilt.slice(8, 12), rebuilt.slice(12, 14)]
  .map((b) => b.join('\n')).join('\n\n');

console.log(`roster: ${sets.map((s) => s.tag).join(' ')}`);
for (const [li, slot] of slots.entries()) {
  const changed = slot.filter((s) => s.was);
  if (changed.length) {
    console.log(`  line ${li + 1}: ${changed.map((s) => `${s.was} -> ${s.w}`).join(', ')}`);
  }
}
console.log(`substitutions: ${swaps}`);
if (grammarRisk.length) {
  console.log(`  GRAMMAR RISK — ${grammarRisk.length} function word(s) swapped; rewrite these lines by hand:`);
  for (const g of grammarRisk) console.log(`    ${g}`);
}
if (assignment.length) {
  const used = new Set(assignment);
  console.log(`turns: legal for all ${flat.length} words; `
    + `${used.size}/${sets.length} members contribute`
    + (used.size < sets.length ? ' — WARNING: every member must contribute at least one word' : ''));
}
if (problems.length) {
  console.log('');
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  console.log('');
  console.log('not written out; the draft cannot be fitted to this roster');
  process.exit(1);
}
if (outPath) {
  fs.writeFileSync(outPath, `${text}\n`);
  console.log(`wrote ${outPath}`);
} else {
  console.log('');
  console.log(text);
}
