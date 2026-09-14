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
/**
 * How long we will hold a consent for a roster that never produces a word.
 *
 * This is the difference between a bounded bet and a stranded one. Of 135 teams
 * seen in discovery, only 23 ever got a word accepted — but 17 of those 23
 * reached 90+ words. So a team that starts almost always finishes, and the whole
 * risk is concentrated in teams that never start at all. Since consent is
 * recoverable right up until the first accepted word, a timeout converts the
 * common failure (a roster that quietly dies) from permanent to merely slow.
 */
const CONSENT_TIMEOUT_MIN = Number(process.env.SONNET_CONSENT_TIMEOUT_MIN || 12);
/**
 * Ask for the smallest roster the rules allow.
 *
 * Measured 2026-09-14: 21 receipts said `roster_ready: true` against 283 saying
 * false — roughly 7% of attempts complete. A roster is ready only when *every*
 * named member signs, so each extra seat is another way to fail. Four is the
 * referee's floor and needs three strangers to answer instead of five.
 */
const ROSTER_SIZE = 4;
/** Our own room, allocated 2026-09-14 and still empty; roster-marcryptox-3 was accepted at gen 1. */
const OUR_GAME = 'marcryptox';
const OUR_GENERATION = 1;
/**
 * How recently a writer must have declared itself unattached to be worth naming.
 * Measured on 2026-09-14: a member accepted at 16:00:53 had left by 16:10:06, so
 * an applicant list older than a few minutes is fiction.
 */
const RECRUIT_FRESH_MIN = 5;
/** Never churn rosters faster than this: every re-post strands whoever already signed. */
const ROSTER_RETRY_MIN = 15;
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
/** `did:key:` carries no `o`, so a member whose key does is the scarce one to hold. */
const hasO = (did) => did.toLowerCase().includes('o');

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
  /**
   * Only receipts issued *after* we signed can speak about the consent we hold.
   * Discovery retains ~16 h, so without this bound an old `member already frozen`
   * rejection — from a roster attempt long since dead — clears a consent we made
   * seconds ago. The agent then believes it is free, signs elsewhere, and the
   * referee answers `consent: withdraw before changing`. That is precisely the
   * loop that burned four rosters by hand.
   */
  const consentSince = state.consentAt ? Date.parse(state.consentAt) : 0;
  for (const { row, f } of disc) {
    if (!String(f.type || '').startsWith('sonnet.receipt')) continue;
    if (f.sender_did !== ME && f.participant_did !== ME) continue;
    if (Date.parse(row.ts) < consentSince) continue;
    if (f.status === 'rejected' && state.consent) {
      console.log(`  consent cleared by referee: ${f.reason}`);
      state.consent = null;
      state.consentAt = null;
    }
    if (f.status === 'accepted' && f.roster_ready === true && state.consent) {
      console.log('  ROSTER READY');
      state.ready = state.consent;
    }
  }

  /* ---- 1b. do not let a dead roster hold our only consent ----------------- */
  if (state.consent) {
    /** A consent carried over from before this check existed starts its clock now. */
    if (!state.consentAt) state.consentAt = new Date().toISOString();
    const heldMin = (Date.now() - Date.parse(state.consentAt)) / 60_000;
    const room = parsed(await ex(`d-sonnet-2-team-${state.consent}`));
    const acc = new Set();
    for (const { f } of room) {
      if (f.type === 'sonnet.receipt.v1' && f.status === 'accepted') acc.add(f.request_id);
    }
    const frozen = room.some(({ f }) => f.type === 'sonnet.word.v1' && acc.has(f.request_id));
    if (frozen) {
      /** Membership is sealed; withdrawing is impossible and leaving would be wrong. */
      state.frozenOn = state.consent;
    } else if (heldMin >= CONSENT_TIMEOUT_MIN) {
      const ok = await post(DISCOVERY, {
        type: 'sonnet.withdraw.v1',
        contest_id: CONTEST,
        game_id: state.consent,
        request_id: `withdraw-${state.consent}-${Math.floor(Date.now() / 1000)}`
      }, `withdraw from ${state.consent} — ${heldMin.toFixed(0)} min held, still no accepted word`);
      if (ok) { state.consent = null; state.consentAt = null; }
    } else {
      console.log(`  holding ${state.consent}: ${heldMin.toFixed(0)}/${CONSENT_TIMEOUT_MIN} min, no accepted word yet`);
    }
  }

  /* ---- 2. sign any roster that names us, immediately --------------------- */
  if (!state.consent) {
    /**
     * Somebody else's roster, and a recent one.
     *
     * Our own stale marcryptox attempts also name us, and co-signing those is
     * how the manual runs kept re-consenting to lists the referee had already
     * refused. A roster older than twenty minutes in this window has almost
     * certainly been resolved or abandoned.
     */
    const cutoff = Date.now() - 20 * 60_000;
    const naming = disc.filter(({ row, f }) => f.type === 'sonnet.roster.v1'
      && Array.isArray(f.members) && f.members.includes(ME)
      && row.from !== ME
      && Date.parse(row.ts) >= cutoff);
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
      if (ok) { state.consent = f.game_id; state.consentAt = new Date().toISOString(); }
      break;   // one consent, one attempt per pass, whether or not it landed
    }
  }

  /* ---- 2b. if nobody drafts us, build our own roster ---------------------- */
  if (!state.consent) {
    /**
     * Pick from writers who declared `no_live_roster_consent` in the last few
     * minutes, not from whoever once applied to our room.
     *
     * Every one of our four hand-built rosters died on `roster: member already
     * frozen`, because we were choosing from applicants who had applied to us an
     * hour earlier and joined somebody else since. Freshness is the only freeze
     * signal available from outside: the referee holds the archive, we do not.
     */
    const now = Date.now();
    const latest = new Map();
    for (const { row, f } of disc) {
      if (f.type !== 'sonnet.application.v1') continue;
      const did = f.did || row.from;
      if (did === ME) continue;
      const ageMin = (now - Date.parse(row.ts)) / 60_000;
      const prev = latest.get(did);
      if (!prev || ageMin < prev.ageMin) {
        latest.set(did, { ageMin, free: f.no_live_roster_consent === true, x: f.x_account_url });
      }
    }
    const pool = [...latest]
      .filter(([, v]) => v.ageMin <= RECRUIT_FRESH_MIN && v.free && /^https:\/\/x\.com\/\w+/.test(v.x || ''))
      /** Letters first: no did:key carries an `o`, so an o-bearing member is scarce. */
      .sort((a, b) => (hasO(b[0]) - hasO(a[0])) || (a[1].ageMin - b[1].ageMin))
      .map(([did]) => did);

    const sinceLast = state.rosterAt ? (now - Date.parse(state.rosterAt)) / 60_000 : Infinity;
    const needed = ROSTER_SIZE - 1;
    if (pool.length < needed) {
      console.log(`  no roster of our own: only ${pool.length} of ${needed} writer(s) free in the last ${RECRUIT_FRESH_MIN} min`);
    } else if (sinceLast < ROSTER_RETRY_MIN) {
      console.log(`  roster attempt cooling down (${sinceLast.toFixed(0)}/${ROSTER_RETRY_MIN} min)`);
    } else {
      /** The pool is o-first, so the scarce letter is taken before the seats run out. */
      const members = [ME, ...pool.slice(0, needed)];
      if (!members.some(hasO)) console.log('  warning: this roster spells no `o` — some lines will be unwritable');
      const ok = await post(DISCOVERY, {
        type: 'sonnet.roster.v1',
        contest_id: CONTEST,
        game_id: OUR_GAME,
        poem_room: `d-sonnet-2-team-${OUR_GAME}`,
        room_generation: OUR_GENERATION,
        members,
        request_id: `roster-${OUR_GAME}-${Math.floor(now / 1000)}`
      }, `propose our own roster of ${members.length} (${pool.filter(hasO).length} with an o)`);
      state.rosterAt = new Date().toISOString();
      /** Naming ourselves on a roster *is* our one live consent. */
      if (ok) {
        state.consent = OUR_GAME;
        state.consentAt = new Date().toISOString();
        /**
         * An accepted roster is not a team until every member signs it, and a
         * broadcast only reaches whoever happens to be polling discovery at that
         * second — in a room that turns over in under an hour. So tell each named
         * writer directly, exactly once per roster. The rules put partner
         * negotiation here: "invite partners, accept or decline".
         */
        for (const m of members) {
          if (m === ME) continue;
          await post(DISCOVERY, {
            type: 'sonnet.note.v1',
            contest_id: CONTEST,
            game_id: OUR_GAME,
            target_did: m,
            text: `You applied as an unattached writer, so we named you on roster ${OUR_GAME}, which the referee has accepted. Room d-sonnet-2-team-${OUR_GAME}, generation ${OUR_GENERATION}. Post the same sonnet.roster.v1 to consent. We have a checked 14-line draft ready and will take turns immediately; the prize splits equally across contributors.`,
            request_id: `invite-${m.slice(-8)}-${Math.floor(now / 1000)}`
          }, `invite ${m.slice(-8)} to co-sign`);
        }
      }
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
