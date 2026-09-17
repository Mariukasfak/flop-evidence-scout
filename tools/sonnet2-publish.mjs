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
import {
  loadSyllables, parseRoom, readLedger, linesFromWords, canonicalText, sha256, splitPosts
} from './sonnet2-canon.mjs';

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
const ROOM = flag('room');

/**
 * The room is the poem; our draft is only what we hoped the poem would be. If a
 * teammate wrote a word of their own the two differ, and publishing the file
 * instead of the room is exactly the mistake behind `publication: unverified`.
 * The rebuilding lives in sonnet2-canon.mjs so the hash we publish and the hash
 * we submit cannot drift apart.
 */
let lines;
if (ROOM) {
  const ledger = readLedger(parseRoom(fs.readFileSync(ROOM, 'utf8')));
  if (!ledger.words.length) {
    console.error('[publish] no accepted words in that room export');
    process.exit(1);
  }
  const syll = loadSyllables(path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict')));
  lines = linesFromWords(ledger.words, syll);
  console.log(`[publish] rebuilt from ${ledger.words.length} accepted word(s) in the room`);
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

const canonical = canonicalText(lines);
const sha = sha256(canonical);
const posts = splitPosts(canonical, LIMIT);

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
console.log('=== SUBMISSION — do not hand-write this. Once the posts are up, run: ===');
console.log('');
const idList = posts.map((_, i) => '<id' + (i + 1) + '>').join(',');
console.log(`  node tools/sonnet2-submit.mjs --game=${GAME} --posts=${idList}`);
console.log('');
console.log('It rebuilds the hash from the room, checks we are the final contributor,');
console.log('and refuses unless everything matches. Add --confirm to actually send it.');
