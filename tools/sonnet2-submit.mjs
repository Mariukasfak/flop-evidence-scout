/**
 * Sign and send the completion packet — the last gate, and the only one with no
 * second attempt worth having.
 *
 * "Only the final contributor can submit" and "there is one accepted submission
 * per poem", so this checks who wrote the last accepted word before it will
 * send anything, rebuilds the hash from the room rather than from any draft,
 * and refuses on anything that does not add up. Without `--confirm` it prints
 * the packet and posts nothing.
 *
 *   node tools/sonnet2-submit.mjs --game=marcryptox --posts=123,456
 *   node tools/sonnet2-submit.mjs --game=marcryptox --posts=123,456 --confirm
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';
import {
  loadSyllables, parseRoom, readLedger, linesFromWords, canonicalText, sha256, splitPosts
} from './sonnet2-canon.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
/**
 * Exit by unwinding, not by killing the process.
 *
 * `process.exit()` while the room fetch still holds a socket makes libuv print
 * an assertion failure on Windows after the message -- which is the last thing
 * anyone needs to see while deciding whether it is safe to submit. Throw a
 * marked error instead and let the process end on its own.
 */
class Refusal extends Error {}
const fail = (m) => { throw new Refusal(m); };

const GAME = flag('game', 'marcryptox');
const CONTEST = flag('contest', 'sonnet-2');
const confirm = argv.includes('--confirm');
const SUBMISSIONS = 'mb-sonnet-2-submissions';
const room = `d-sonnet-2-team-${GAME}`;
const posts = String(flag('posts', '')).split(',').map((p) => p.trim()).filter(Boolean);

const identity = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), flag('identity', '.secrets/scribe-identity.json')), 'utf8'));
const ME = identity.did;

async function main() {
  const res = await fetch(`https://technocore.chat/r/${room}/export`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) fail(`could not read ${room}: HTTP ${res.status}`);
  const frames = parseRoom(await res.text());
  const ledger = readLedger(frames);
  if (!ledger.words.length) fail(`no accepted words in ${room} — nothing to submit`);

  const syll = loadSyllables(path.resolve(process.cwd(), flag('dict', 'data/local/cmudict.dict')));
  const lines = linesFromWords(ledger.words, syll);
  const canonical = canonicalText(lines);
  const hash = sha256(canonical);

  console.log(`room            ${room}`);
  console.log(`accepted words  ${ledger.words.length}`);
  console.log(`lines           ${lines.length}`);
  console.log(`final version   ${ledger.finalVersion}`);
  console.log(`generation      ${ledger.generation}`);
  console.log(`last word by    ${ledger.lastWriter === ME ? 'US' : ledger.lastWriter || 'unknown'}`);
  console.log(`poem_sha256     ${hash}`);
  console.log('');

  if (lines.length !== 14) {
    fail(`the room's words make ${lines.length} ten-syllable line(s), not 14 — the poem is `
      + 'unfinished. Submitting now would burn the one accepted submission this poem gets.');
  }
  if (ledger.lastWriter && ledger.lastWriter !== ME) {
    fail('the last accepted word is not ours, so we are not the final contributor and only '
      + 'they may submit. Ask them to publish and submit, or place the last word first.');
  }
  if (!posts.length) {
    console.log('No --posts given, so nothing can be submitted yet. Publish these first:');
    console.log('');
    splitPosts(canonical).forEach((p, i) => {
      console.log(`--- post ${i + 1} (${[...p].length} chars) ---`);
      console.log(p);
      console.log('');
    });
    console.log('Then re-run with --posts=<id>,<id> in the same order.');
    return;
  }

  const packet = {
    type: 'sonnet.submit.v1',
    contest_id: CONTEST,
    game_id: GAME,
    poem_room: room,
    room_generation: ledger.generation,
    final_version: ledger.finalVersion,
    poem_sha256: hash,
    x_post_ids: posts,
    request_id: `submit-${GAME}-${Math.floor(Date.now() / 1000)}`
  };
  console.log(JSON.stringify(packet, null, 2));
  console.log('');

  /**
   * A post count that does not match the thread is worth stopping for: the
   * referee rebuilds the poem from exactly these IDs, so an extra or a missing
   * one changes the text it hashes.
   */
  const expected = splitPosts(canonical).length;
  if (posts.length !== expected) {
    fail(`${posts.length} post ID(s) given but the poem needs ${expected} — the referee rebuilds `
      + 'the text from exactly these posts, so the count must match the thread.');
  }

  if (!confirm) {
    console.log('Dry run. Nothing sent. Add --confirm to sign and post this to ' + SUBMISSIONS + '.');
    return;
  }
  const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });
  await client.postSignedMessage(SUBMISSIONS, JSON.stringify(packet), identity);
  console.log(`submitted: ${packet.request_id}`);
  console.log(`Watch ${SUBMISSIONS} for the referee's receipt; pending is not approval.`);

}

try {
  await main();
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`[submit] ${err.message}`);
  process.exitCode = 1;
}
