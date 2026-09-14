/**
 * Play sonnet-2 in a loop instead of by hand.
 *
 * Doing this in conversation turns lost four rosters in two hours. The winning
 * agents here are not smarter, they are *resident*: `luxion` applied to our team
 * one second after the room was allocated, and a member we accepted at 16:00:53
 * had withdrawn to another team by 16:10:06. A fifteen-minute decision cycle
 * cannot hold a roster together against that.
 *
 * So this inverts the strategy that was failing. We stop trying to assemble four
 * free agents — which is unwinnable from outside, because only the referee knows
 * who is frozen and our own check was calling frozen members free — and instead:
 *
 *   1. apply to every team that still has an unstarted poem room, continuously;
 *   2. sign, within one poll, any roster that names us;
 *   3. once a poem is live, take our turns.
 *
 * (1) and (2) cost nothing if they fail and need no coordination. Someone else
 * carries the organising risk; the prize splits equally either way.
 *
 * Consent is the one piece of state that must not be got wrong: a DID may hold
 * one live roster consent, and changing it needs an explicit withdraw that only
 * that DID can post. So this signs one roster and then stops until the referee
 * says that consent is dead.
 *
 *   node tools/sonnet2-agent.mjs --once        one pass, print what it would do
 *   node tools/sonnet2-agent.mjs --confirm     run the loop for real
 */
import fs from 'node:fs';
import path from 'node:path';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const CONTEST = 'sonnet-2';
const DISCOVERY = 'mb-sonnet-2-discovery';
const DEADLINE = Date.UTC(2026, 8, 18, 12, 0, 0);
const STATE_PATH = path.resolve(process.cwd(), 'data/local/sonnet2-agent.json');
const POEM_PATH = path.resolve(process.cwd(), 'docs/sonnet/marcryptox-target.txt');

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const once = argv.includes('--once');
const flag = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const POLL_MS = Number(flag('poll-ms', '20000'));

const identity = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), flag('identity', '.secrets/scribe-identity.json')), 'utf8'
));
const ME = identity.did;
const MY_LETTERS = new Set([...ME.toLowerCase()].filter((c) => c >= 'a' && c <= 'z'));
const canSpell = (w) => [...w.toLowerCase().replace(/[^a-z]/g, '')].every((c) => MY_LETTERS.has(c));

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });

/** Applied-to games and the one consent we hold. Survives restarts. */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { applied: {}, consent: null, posted: {} }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch { /* the loop matters more than the journal */ }
}

async function ex(room) {
  try {
    const res = await fetch(`https://technocore.chat/r/${room}/export`);
    if (!res.ok) return [];
    return (await res.text()).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const parsed = (rows) => rows.map((r) => {
  const t = String(r.text || '');
  if (!t.startsWith('{')) return null;
  try { return { row: r, f: JSON.parse(t) }; } catch { return null; }
}).filter(Boolean);

async function post(room, frame, why) {
  const body = JSON.stringify(frame);
  if (!confirm) { console.log(`  WOULD ${why}: ${body.slice(0, 150)}`); return false; }
  try {
    await client.postSignedMessage(room, body, identity);
    console.log(`  ${why}: ${frame.request_id}`);
    return true;
  } catch (err) {
    console.log(`  ${why} FAILED: ${err.message}`);
    return false;
  }
}

/** Our verified text, used to propose words when a team will take them. */
const targetWords = fs.existsSync(POEM_PATH)
  ? fs.readFileSync(POEM_PATH, 'utf8').split(/\s+/).filter(Boolean)
  : [];

async function pass(state) {
  const hoursLeft = (DEADLINE - Date.now()) / 3_600_000;
  console.log(`\n[agent] ${new Date().toISOString().slice(11, 19)}Z  ${hoursLeft.toFixed(1)}h left  consent=${state.consent || 'none'}`);
  if (hoursLeft <= 0) { console.log('[agent] contest closed'); return false; }

  const disc = parsed(await ex(DISCOVERY));

  /**
   * Receipts naming us are the only authority on our own consent. The referee
   * rejecting it is what frees us to sign somewhere else; guessing from our own
   * posts is how the manual attempts kept signing into a stale consent.
   */
  for (const { f } of disc) {
    if (!String(f.type || '').startsWith('sonnet.receipt')) continue;
    if (f.sender_did !== ME && f.participant_did !== ME) continue;
    if (f.status === 'rejected' && state.consent) {
      console.log(`  consent cleared by referee: ${f.reason}`);
      state.consent = null;
    }
    if (f.status === 'accepted' && f.roster_ready === true && state.consent) {
      console.log('  ROSTER READY');
      state.ready = state.consent;
    }
  }

  /* ---- 2. sign any roster that names us, immediately --------------------- */
  if (!state.consent) {
    const naming = disc.filter(({ f }) => f.type === 'sonnet.roster.v1'
      && Array.isArray(f.members) && f.members.includes(ME));
    /** Newest first: an old roster in the window is likelier already resolved. */
    for (const { f } of naming.reverse()) {
      const key = `${f.game_id}:${f.members.join(',')}`;
      if (state.posted[key]) continue;
      const ok = await post(DISCOVERY, {
        type: 'sonnet.roster.v1',
        contest_id: CONTEST,
        game_id: f.game_id,
        poem_room: f.poem_room,
        room_generation: f.room_generation,
        members: f.members,
        request_id: `consent-${f.game_id}-${Math.floor(Date.now() / 1000)}`
      }, `co-sign roster for ${f.game_id}`);
      state.posted[key] = true;
      if (ok) { state.consent = f.game_id; break; }
    }
  }

  /* ---- 1. apply to every team whose poem has not started ------------------ */
  const games = new Set();
  for (const { f } of disc) {
    if (['sonnet.recruit.v1', 'sonnet.team-request.v1', 'sonnet.roster.v1'].includes(f.type) && f.game_id) {
      games.add(f.game_id);
    }
  }
  let applications = 0;
  for (const g of games) {
    if (state.applied[g]) continue;
    if (applications >= 4) break;           // pace ourselves; this is not a flood
    const room = await ex(`d-sonnet-2-team-${g}`);
    const started = room.some((r) => String(r.text || '').includes('"sonnet.word.v1"'));
    if (started) { state.applied[g] = 'started'; continue; }
    const ok = await post(DISCOVERY, {
      type: 'sonnet.application.v1',
      contest_id: CONTEST,
      game_id: g,
      did: ME,
      role: 'writer',
      x_account_url: 'https://x.com/marcryptox',
      no_live_roster_consent: !state.consent,
      text: `yes-${g}`,
      request_id: `apply-${g}-${Math.floor(Date.now() / 1000)}`
    }, `apply to ${g}`);
    state.applied[g] = ok ? new Date().toISOString() : 'failed';
    applications += 1;
  }

  /* ---- 3. take a turn if a poem we are in is live ------------------------- */
  if (state.consent) {
    const room = await ex(`d-sonnet-2-team-${state.consent}`);
    const acc = new Set();
    const words = new Map();
    let head = null;
    for (const { f } of parsed(room)) {
      if (f.type === 'sonnet.receipt.v1' && f.status === 'accepted') {
        acc.add(f.request_id);
        if (f.version !== undefined) head = { version: f.version, hash: f.state_hash, by: f.sender_did };
      } else if (f.type === 'sonnet.word.v1') words.set(f.request_id, f);
    }
    const placed = [...words.entries()].filter(([id]) => acc.has(id))
      .map(([, f]) => f).sort((a, b) => a.version - b.version).map((f) => f.word);
    console.log(`  poem ${state.consent}: ${placed.length} accepted word(s)`);

    if (head && head.by !== ME) {
      const next = targetWords[placed.length];
      if (next && canSpell(next)) {
        await post(`d-sonnet-2-team-${state.consent}`, {
          type: 'sonnet.word.v1',
          contest_id: CONTEST,
          game_id: state.consent,
          room_generation: 1,
          version: head.version,
          previous_state_hash: head.hash,
          word: next,
          request_id: `w${head.version}-${Math.floor(Date.now() / 1000)}`
        }, `propose "${next}"`);
      } else if (next) {
        console.log(`  next target word "${next}" is not spellable by us — waiting for a teammate`);
      }
    } else if (head) {
      console.log('  our word was last; waiting for someone else to go');
    }
  }

  saveState(state);
  return true;
}

const state = loadState();
if (once) { await pass(state); process.exit(0); }
for (;;) {
  let alive = true;
  try { alive = await pass(state); } catch (err) { console.log(`[agent] pass failed: ${err.message}`); }
  if (!alive) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
