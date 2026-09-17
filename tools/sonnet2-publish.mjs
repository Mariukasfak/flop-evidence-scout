/**
 * Build the exact posts that publication and submission need.
 *
 * Seventy-six of a hundred and fifty rejections in this contest came back
 * `publication: unverified`, and the shape of the mistake is always the same:
 * the referee rebuilds the poem from the posts listed in `x_post_ids` and hashes
 * it, so a title, a preface or a game link inside those posts changes the hash
 * and no number of retries will fix it. One team sent forty-one times.
 *
 * So the poem posts carry the poem and nothing else, split only between whole
 * lines, and the attribution is a separate post that is NOT part of the hash.
 *
 *   node tools/sonnet2-publish.mjs --poem=docs/sonnet/marcryptox-target.txt
 *   node tools/sonnet2-publish.mjs --room=team-export.jsonl   <- the real thing
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const poemPath = path.resolve(process.cwd(), flag('poem', 'docs/sonnet/marcryptox-target.txt'));
const GAME = flag('game', 'marcryptox');
const CONTEST = flag('contest', 'sonnet-2');
const DID = flag('did', 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW');
const LIMIT = Number(flag('limit', 280));

/**
 * Canonical text, exactly as the spec defines it: one ASCII space between
 * accepted words, LF between lines, one blank line between the 4/4/4/2 stanzas,
 * and no terminal newline. The hash is over these bytes.
 */
const ROOM = flag('room');
let lines;
if (ROOM) {
  /**
   * The room is the poem. Our draft is only what we hoped the poem would be.
   *
   * Every word the referee accepted sits in the team room in order, and that
   * sequence -- not any file on this machine -- is what gets hashed and
   * compared against the posts. If a teammate wrote a word of their own the two
   * differ, and publishing the file instead of the room is exactly the mistake
   * behind `publication: unverified`, which accounts for 76 of the 150
   * rejections this contest has handed out.
   *
   * The room stores words, not line breaks, so the lines are rebuilt the way
   * the validator counts them: accumulate words until the line reaches ten
   * syllables by the LONGEST cmudict pronunciation, which is the count the
   * official validator charges.
   */
  const raw = fs.readFileSync(ROOM, 'utf8').trim();
  const rows = JSON.parse(raw.startsWith('[') ? raw : `[${raw.split('\n').filter(Boolean).join(',')}]`);
  const frames = [];
  for (const row of rows) {
    let f; try { f = JSON.parse(row.text); } catch { continue; }
    frames.push({ row, f });
  }
  const accepted = new Set();
  for (const { f } of frames) {
    const items = f.type === 'sonnet.receipts.v1' ? (f.receipts || []) : [f];
    for (const it of items) if (it.status === 'accepted' && it.request_id) accepted.add(it.request_id);
  }
  /**
   * One word per version, not one per frame.
   *
   * An agent that does not see its receipt re-posts the same word, so the room
   * holds several frames for one accepted turn. Counting frames rebuilt
   * bigtoe-2's finished sonnet as 127 words and fifteen lines -- "I say your
   * name before I I I let / it end We We save no life by by by" -- against the
   * 117 words they published. `version` is the turn number the referee chains
   * on, so it is the sequence, and the first frame to claim each one is the
   * word that was accepted.
   */
  const byVersion = new Map();
  for (const { f } of frames) {
    if (f.type !== 'sonnet.word.v1' || !accepted.has(f.request_id)) continue;
    const v = Number(f.version);
    if (!Number.isFinite(v) || byVersion.has(v)) continue;
    byVersion.set(v, String(f.word));
  }
  const words = [...byVersion.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
  if (!words.length) { console.error('[publish] no accepted words in that room export'); process.exit(1); }

  const dictPath = path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict'));
  const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY',
    'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
  const syll = new Map();
  for (const line of fs.readFileSync(dictPath, 'utf8').split('\n')) {
    const fd = line.split('#')[0].trim().split(/\s+/);
    if (!fd[0] || fd[0].startsWith(';;;')) continue;
    const w = fd[0].replace(/\(\d+\)$/, '').toLowerCase();
    const n = fd.slice(1).filter((ph) => VOWELS.has(ph.slice(0, -1)) && /[012]$/.test(ph)).length;
    if (n) syll.set(w, Math.max(syll.get(w) || 0, n));
  }
  const count = (w) => syll.get(w.toLowerCase().replace(/[^a-z']/g, '')) || 0;

  lines = [];
  let cur = [];
  let n = 0;
  for (const w of words) {
    cur.push(w);
    n += count(w);
    if (n >= 10) { lines.push(cur.join(' ')); cur = []; n = 0; }
  }
  if (cur.length) lines.push(cur.join(' '));
  console.log(`[publish] rebuilt from ${words.length} accepted word(s) in the room`);
  if (lines.length !== 14) {
    console.error(`[publish] those words make ${lines.length} ten-syllable line(s), not 14 —`);
    console.error('[publish] the poem is unfinished or has drifted. Do not publish this.');
    for (const [i, l] of lines.entries()) console.error(`  ${String(i + 1).padStart(2)}  ${l}`);
    process.exit(1);
  }
} else {
  lines = fs.readFileSync(poemPath, 'utf8').replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
}
if (lines.length !== 14) {
  console.error(`[publish] expected 14 lines, got ${lines.length}`);
  process.exit(1);
}
const canonical = [lines.slice(0, 4), lines.slice(4, 8), lines.slice(8, 12), lines.slice(12, 14)]
  .map((s) => s.join('\n')).join('\n\n');
const sha = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');

/** Split between whole lines only, never inside one, and never across a stanza break. */
const posts = [];
let cur = '';
for (const block of canonical.split('\n\n')) {
  for (const line of block.split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if ([...next].length > LIMIT) { posts.push(cur); cur = line; } else { cur = next; }
  }
  const withGap = `${cur}\n`;
  if (cur && [...withGap].length <= LIMIT) cur = withGap;
}
if (cur.trim()) posts.push(cur.replace(/\n+$/, ''));

console.log(`poem_sha256  ${sha}`);
console.log(`canonical    ${Buffer.byteLength(canonical, 'utf8')} bytes, ${lines.length} lines, `
  + `${canonical.split(/\s+/).filter(Boolean).length} words`);
console.log('');
console.log(`=== POEM POSTS (${posts.length}) — post these as a thread, in this order,`);
console.log('=== nothing else in them, and list ONLY these post IDs in x_post_ids');
posts.forEach((p, i) => {
  console.log('');
  console.log(`--- post ${i + 1}/${posts.length}  (${[...p].length} chars) ---`);
  console.log(p);
});
console.log('');
console.log('=== ATTRIBUTION — a separate reply. Its ID does NOT go in x_post_ids. ===');
console.log('');
console.log(`contest_id: ${CONTEST}\ngame_id: ${GAME}\nfinal contributor: ${DID}`);
console.log('');
console.log('=== SUBMISSION PACKET — fill in the post IDs and the version, then sign it ===');
console.log('');
console.log(JSON.stringify({
  type: 'sonnet.submit.v1',
  contest_id: CONTEST,
  game_id: GAME,
  poem_room: `d-sonnet-2-team-${GAME}`,
  room_generation: '<from the room setup receipt>',
  final_version: '<version on the final accepted word receipt>',
  poem_sha256: sha,
  x_post_ids: posts.map((_, i) => `<id of poem post ${i + 1}>`),
  request_id: `submit-${GAME}-<unix seconds>`
}, null, 2));
