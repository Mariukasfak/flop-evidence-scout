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
/**
 * Keeping a content word a content word makes the repair read like English, and
 * it cost one roster in forty on the 102-word draft: the substitute pool got
 * narrow enough that no legal turn sequence survived. So the caller retries
 * with the class rule off, because a poem with a clumsy line still scores and
 * an unwritable one does not.
 */
const LOOSE = argv.includes('--loose');

const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
  'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

/** MAX pronunciation, because that is what the official validator charges. */
const syll = new Map();
const rhyme = new Map();
const startsVowel = new Map();
for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
  const fields = line.split('#')[0].trim().split(/\s+/);
  if (!fields[0] || fields[0].startsWith(';;;')) continue;
  const word = fields[0].replace(/\(\d+\)$/, '').toLowerCase();
  if (!/^[a-z]+(?:'[a-z]+)*$/.test(word)) continue;
  const phones = fields.slice(1);
  const n = phones.filter((p) => VOWELS.has(p.slice(0, -1)) && /[012]$/.test(p)).length;
  if (!n) continue;
  syll.set(word, Math.max(syll.get(word) || 0, n));
  if (!startsVowel.has(word)) startsVowel.set(word, VOWELS.has(phones[0].replace(/[012]$/, '')));
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

/**
 * Swapping a content word costs an image; swapping a function word costs the
 * sentence. Replacing "of" with the widest-writable one-syllable word produced
 * "engine a my mind", which is still a valid sonnet to the referee and no
 * longer English. These are named so the swap can be judged, and a human asked
 * to rewrite the line instead.
 */
const FUNCTION_WORDS = new Set(['a', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been',
  'being', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'may',
  'me', 'might', 'must', 'my', 'no', 'nor', 'not', 'of', 'on', 'or', 'our', 'shall',
  'she', 'should', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'those', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
  /**
   * Prepositions belong here too. Without them the repair replaced "evening"
   * with "after" and produced "An after river": the grammar warning stayed
   * silent because only the pronouns and articles were listed.
   */
  'about', 'above', 'across', 'after', 'again', 'against', 'along', 'among',
  'around', 'before', 'behind', 'below', 'beneath', 'beside', 'between',
  'beyond', 'during', 'inside', 'near', 'off', 'onto', 'out', 'outside',
  'over', 'past', 'since', 'through', 'toward', 'under', 'until', 'upon',
  'while', 'within', 'without']);

/**
 * Don't answer every question with the same word.
 *
 * Preferring the draft's own vocabulary sounded right and was not: "sister" is
 * two syllables and writable by everyone, so it won every two-syllable slot at
 * once and the repair came back "I sister sleep. I keep a sister day". A word
 * already spent is pushed down the list instead, so a roster that needs twelve
 * substitutions gets twelve different ones.
 */
const spent = new Map();

const candidatesFor = (word, needRhyme) => {
  const isFunction = FUNCTION_WORDS.has(word);
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
    /**
     * A content word may only become another content word. Left free, the
     * search takes the widest-writable word of the right length, and those are
     * overwhelmingly the short grammatical ones: repairing the 102-word draft
     * turned "An evening river" into "An am river", which scans, passes the
     * validator, and is not English.
     */
    if (!LOOSE && isFunction !== FUNCTION_WORDS.has(cand)) continue;
    out.push({ cand, w, rank, used: spent.get(cand) || 0 });
  }
  /** Widest choice of writers first -- those are the words that keep turns legal. */
  return out.sort((a, b) => (a.used - b.used) || (b.w.length - a.w.length) || (a.rank - b.rank));
};

/**
 * Keep "a" and "an" agreeing with whatever now follows them.
 *
 * A swap one slot to the right changes the sound the article sits in front of:
 * repairing the short draft turned "An evening river" into "An sister river".
 * Both forms are one syllable, so this costs the meter nothing and is the one
 * grammatical error the fitter can always fix by itself.
 */
const fixArticles = (flatSlots) => {
  let fixed = 0;
  for (let i = 0; i < flatSlots.length - 1; i++) {
    const a = flatSlots[i];
    if (a.w !== 'a' && a.w !== 'an') continue;
    /** An article at the end of its line governs a word we are not tracking here. */
    if (a.tail && /[.,;:!?]/.test(a.tail)) continue;
    const want = startsVowel.get(flatSlots[i + 1].w) ? 'an' : 'a';
    if (a.w === want || !writersOf(want).length) continue;
    a.w = want;
    fixed++;
  }
  return fixed;
};

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
    spent.set(pick.cand, (spent.get(pick.cand) || 0) + 1);
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
    /**
     * Readability ordering is wrong here. The spelling swap wants the word that
     * reads best; this wants the word the most members can write, and taking
     * the first *readable* wider word instead cost two rosters in sixty that
     * the old ordering could still fit. Width first, readability to break ties.
     */
    const better = [...candidatesFor(s.w, isLast)]
      .sort((a, b) => (b.w.length - a.w.length) || (a.used - b.used) || (a.rank - b.rank))
      .find((c) => c.w.length > writersOf(s.w).length);
    if (!better) continue;
    turnSwaps.push(`"${s.w}" -> "${better.cand}" (writers ${writersOf(s.w).length} -> ${better.w.length})`);
    if (!s.was) s.was = s.w;
    if (FUNCTION_WORDS.has(s.w)) grammarRisk.push(`turn repair: "${s.w}" -> "${better.cand}"`);
    s.w = better.cand;
    spent.set(better.cand, (spent.get(better.cand) || 0) + 1);
    swaps++;
    repaired = true;
    break;
  }
  if (!repaired) break;
  result = sweep();
}
/**
 * Correct the articles last, and only where it is free.
 *
 * "a" and "an" are spelled from different letters, so swapping one for the
 * other changes which members may take that turn -- done before the sweep it
 * quietly cost two rosters in sixty that were otherwise writable. Grammar is
 * worth less than a poem that can be written at all, so the correction is
 * applied, re-proved, and rolled back if the turn order did not survive it.
 */
let articlesFixed = 0;
if (result.failedAt < 0) {
  const before = flat.map((sl) => sl.w);
  articlesFixed = fixArticles(flat);
  if (articlesFixed) {
    const after = sweep();
    if (after.failedAt < 0) result = after;
    else { flat.forEach((sl, i) => { sl.w = before[i]; }); articlesFixed = -1; }
  }
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
if (articlesFixed > 0) console.log(`  articles corrected: ${articlesFixed}`);
if (articlesFixed < 0) console.log('  ARTICLE MISMATCH — correcting a/an would break the turn order; left as is');
/**
 * Say when the repair has stopped being a repair.
 *
 * This tool knows letters and syllables, not grammar: it will happily produce
 * "A started river" because "started" is two syllables and everyone can spell
 * it. One or two swaps leave a poem; a dozen leave a valid form full of wrong
 * word classes. The referee scores the form either way, so the poem is still
 * written out -- but a human with time left should rewrite these lines.
 */
if (swaps >= 6) {
  console.log(`  DEGRADED — ${swaps} blind substitutions. Valid, but the English has suffered;`);
  console.log('  rewrite by hand if the clock allows, or wait for a friendlier roster.');
}
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
