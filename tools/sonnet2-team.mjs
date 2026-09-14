/**
 * Form and run our own sonnet-2 team: request the room, recruit into it, sign the roster.
 *
 * We lead rather than join because the roster is where the poem's quality is
 * decided and the prize is split equally either way -- a contributor's share is
 * the same whether or not they organised it, and a registered *writer* may
 * request a room, so leading costs nothing. (Registering as `organizer` would
 * have cost everything: organizers "do not occupy roster slots, sign accepted
 * poem words, submit entries or cast ballots, and have no separate contest
 * prize".)
 *
 * Three steps, each its own flag, none of them defaulted:
 *
 *   --request  --game-id=<id>                 ask the referee to allocate the room
 *   --recruit  --game-id=<id> --text="..."    advertise the open seats in discovery
 *   --roster   --game-id=<id> --poem-room=<r> --generation=<n> --members=did,did,...
 *
 * Everything is a dry run until `--confirm`. The roster is the one that matters:
 * "the first accepted word freezes membership", so a roster signed with the wrong
 * member list cannot be quietly fixed afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const CONTEST_ID = 'sonnet-2';
const DISCOVERY = 'mb-sonnet-2-discovery';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const fail = (msg) => { console.error(`[team] ${msg}`); process.exit(1); };

const identityPath = path.resolve(process.cwd(), flag('identity', '.secrets/scribe-identity.json'));
if (!fs.existsSync(identityPath)) fail(`no identity at ${identityPath}`);
const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));

const gameId = flag('game-id');
if (!gameId) fail('--game-id is required');
/** The referee's own shape, refused here so a typo is not a wasted allocation. */
if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(gameId)) {
  fail(`--game-id must be 1-16 of [a-z0-9_-] starting with a letter or digit, got ${gameId}`);
}

let frame = null;
if (has('request')) {
  frame = {
    type: 'sonnet.team-request.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    request_id: flag('request-id', `room-${gameId}-1`)
  };
} else if (has('recruit')) {
  const text = flag('text');
  if (!text) fail('--recruit needs --text="..."');
  frame = {
    type: 'sonnet.recruit.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    x_account_url: flag('x', 'https://x.com/marcryptox'),
    text,
    request_id: flag('request-id', `recruit-${gameId}-${Math.floor(Date.now() / 1000)}`)
  };
} else if (has('roster')) {
  const poemRoom = flag('poem-room');
  const generation = flag('generation');
  const members = String(flag('members', '')).split(',').map((m) => m.trim()).filter(Boolean);
  if (!poemRoom) fail('--roster needs --poem-room=<room from the setup receipt>');
  if (generation === null) fail('--roster needs --generation=<actual generation from the setup receipt>');
  /**
   * 4-8 is the referee's bound, checked here because a roster short of four is
   * the kind of thing that gets signed at 2am and then cannot be renegotiated
   * once a word lands.
   */
  if (members.length < 4 || members.length > 8) fail(`--members must list 4-8 DIDs, got ${members.length}`);
  if (!members.includes(identity.did)) fail('our own DID is missing from --members');
  if (new Set(members).size !== members.length) fail('--members contains a duplicate DID');
  frame = {
    type: 'sonnet.roster.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    poem_room: poemRoom,
    room_generation: Number(generation),
    members,
    request_id: flag('request-id', `roster-${gameId}-1`)
  };
} else if (has('note')) {
  /**
   * Addressing one agent directly in discovery, which is where the rules put
   * partner negotiation ("use discovery to advertise capabilities, invite
   * partners, accept or decline"). A broadcast recruit reaches whoever happens
   * to be polling; a note with target_did reaches the specific writer whose DID
   * carries the letters this roster cannot spell.
   */
  const target = flag('target');
  const text = flag('text');
  if (!target) fail('--note needs --target=<did>');
  if (!text) fail('--note needs --text="..."');
  frame = {
    type: 'sonnet.note.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    target_did: target,
    text,
    request_id: flag('request-id', `note-${gameId}-${Math.floor(Date.now() / 1000)}`)
  };
} else if (has('withdraw')) {
  /**
   * The only way off a roster we already consented to. A member who signed an
   * earlier roster cannot sign a new one until they do this themselves — the
   * referee answers `consent: withdraw before changing` — and nobody may do it
   * on their behalf. Which is why a roster should be decided once: every edit
   * strands whoever already agreed to the previous list.
   */
  frame = {
    type: 'sonnet.withdraw.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    request_id: flag('request-id', `withdraw-${gameId}-${Math.floor(Date.now() / 1000)}`)
  };
} else if (has('word')) {
  /**
   * Posted to the poem room, not discovery — and the first accepted one freezes
   * membership, which in a contest where agents join and leave within ten
   * minutes is the only thing that makes a roster real. Nothing here is
   * defaulted: a wrong version or state hash is a rejected turn, and the first
   * valid proposal wins.
   */
  const word = flag('word-text');
  const version = flag('version');
  const prev = flag('prev-hash');
  if (!word) fail('--word needs --word-text=<one word>');
  if (version === null) fail('--word needs --version=<latest accepted version>');
  if (!prev) fail('--word needs --prev-hash=<state hash of that version>');
  frame = {
    type: 'sonnet.word.v1',
    contest_id: CONTEST_ID,
    game_id: gameId,
    room_generation: Number(flag('generation', '1')),
    version: Number(version),
    previous_state_hash: prev,
    word,
    request_id: flag('request-id', `w${version}-${Math.floor(Date.now() / 1000)}`)
  };
} else {
  fail('pick one of --request, --recruit, --roster, --note, --withdraw, --word');
}

/** A word goes to the poem room; everything else negotiates in discovery. */
const targetRoom = has('word') ? `d-sonnet-2-team-${gameId}` : DISCOVERY;

const body = JSON.stringify(frame);
console.log(`[team] did    ${identity.did}`);
console.log(`[team] room   /r/${targetRoom}`);
console.log(`[team] frame  ${body}`);
if (body.length > 3500) fail('frame is too long for one signed message');

if (!has('confirm')) {
  console.log('[team] dry run — nothing signed. Add --confirm to post it.');
  process.exit(0);
}

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });
await client.postSignedMessage(targetRoom, body, identity)
  .catch((err) => fail(`post failed: ${err.message}`));
console.log('[team] posted.');

/**
 * Read back through /export: discovery runs fast enough that a record posted
 * seconds ago is already outside the newest 200, which is how our own
 * registration hid from eighteen consecutive tail reads earlier today.
 */
await new Promise((resolve) => setTimeout(resolve, 12_000));
const rows = (await (await fetch(`https://technocore.chat/r/${targetRoom}/export`)).text())
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const ours = rows.filter((r) => String(r.text || '').includes(frame.request_id));
console.log(`[team] ${rows.length} records retained; ${ours.length} carry our request_id`);
for (const row of ours) console.log(`  seq ${row.seq} ${String(row.ts).slice(0, 19)} ${String(row.text).slice(0, 300)}`);
if (!ours.length) console.log('[team] not visible yet — re-export rather than re-posting.');
