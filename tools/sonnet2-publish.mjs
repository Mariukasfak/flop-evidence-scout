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
const lines = fs.readFileSync(poemPath, 'utf8').replace(/\r\n/g, '\n')
  .split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
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
