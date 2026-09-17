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
import { execFileSync } from 'node:child_process';
import { TechnocoreClient } from '../src/technocore-client.mjs';

const CONTEST = 'sonnet-2';
const DISCOVERY = 'mb-sonnet-2-discovery';
const DEADLINE = Date.UTC(2026, 8, 18, 12, 0, 0);
const STATE_PATH = path.resolve(process.cwd(), 'data/local/sonnet2-agent.json');
/**
 * How long we will hold a consent for a roster that never produces a word.
 *
 * Treat each roster as one cheap trial rather than a negotiation. The agents we
 * name answer within ten to twenty-five seconds or not at all, so a roster still
 * short of its seats after six minutes is three stragglers who are asleep, and
 * the fastest way to four signatures is another draw from a fresh pool -- not a
 * longer wait on this one.
 *
 * This is the difference between a bounded bet and a stranded one. Of 135 teams
 * seen in discovery, only 23 ever got a word accepted — but 17 of those 23
 * reached 90+ words. So a team that starts almost always finishes, and the whole
 * risk is concentrated in teams that never start at all. Since consent is
 * recoverable right up until the first accepted word, a timeout converts the
 * common failure (a roster that quietly dies) from permanent to merely slow.
 */
/**
 * Six minutes was right while the referee was minutes behind. It is wrong now,
 * and measurably so: on 2026-09-16 the referee issued 49-81 receipts an hour to
 * other agents and none at all about marcryptox between 17:36 and 21:30, while
 * we posted a withdraw and a roster every six minutes into the same intake --
 * 71 receipts' worth of our own frames in a day. A queue we are filling
 * ourselves is a queue we wait behind, so the timers now cost more than the
 * churn ever won. Co-signers answer in ten to twenty-five seconds when they are
 * alive, so waiting longer forfeits nothing.
 */
const CONSENT_TIMEOUT_MIN = Number(process.env.SONNET_CONSENT_TIMEOUT_MIN || 30);
/**
 * Ask for the smallest roster the rules allow.
 *
 * Measured 2026-09-14: 21 receipts said `roster_ready: true` against 283 saying
 * false — roughly 7% of attempts complete. A roster is ready only when *every*
 * named member signs, so each extra seat is another way to fail. Four is the
 * referee's floor and needs three strangers to answer instead of five.
 */
const ROSTER_SIZE = 4;
const OUR_GAME = 'marcryptox';
/**
 * Fallback only. The room's real generation is read from its own setup receipt
 * every pass, because it changes underneath us: ours was re-set-up at 02:50:47
 * as `resetup-marcryptox-2` with `room_generation: 2`, and every roster we
 * posted afterwards still said 1. The referee answered `roster: room` -- three
 * hours later, by which time we had built and abandoned a dozen rosters and
 * collected signatures on lists that could never have been accepted.
 */
const OUR_GENERATION = 1;

/** The current generation and opening hash of a team room, from the room itself. */
async function roomFacts(game) {
  let generation = null;
  let stateHash = null;
  for (const { f } of parsed(await ex(`d-sonnet-2-team-${game}`) || [])) {
    if (f.room_generation !== undefined) generation = f.room_generation;
    if (f.state_hash) stateHash = f.state_hash;
  }
  return { generation, stateHash };
}
/**
 * How recently a writer must have declared itself unattached to be worth naming.
 * Measured on 2026-09-14: a member accepted at 16:00:53 had left by 16:10:06, so
 * an applicant list older than a few minutes is fiction.
 */
const RECRUIT_FRESH_MIN = 5;
/** Never churn rosters faster than this: every re-post strands whoever already signed. */
const ROSTER_RETRY_MIN = 3;
/** How long an application stays good before the room has forgotten we exist. */
const REAPPLY_AFTER_HOURS = 2;
/** A co-signature older than this says nothing about whether the agent is still awake. */
const COSIGNER_ACTIVE_MIN = 60;
/** How long our answer to a given roster stands before that roster is worth answering again. */
const OFFER_RETRY_MIN = 30;
/** How often to nudge the seats still missing from a part-signed roster of ours. */
const REINVITE_MIN = 4;
/**
 * How long a part-signed roster is worth holding before the empty seat is the
 * problem rather than the wait. Two agents counter-signed ours inside twenty
 * seconds; one that has ignored four nudges is not going to sign.
 */
const PARTIAL_HOLD_MIN = Number(process.env.SONNET_PARTIAL_HOLD_MIN || 45);
/**
 * What a part-signed roster is worth waiting on, by how many others have signed
 * it. A rebuild voids every signature we hold, so the wait has to be priced in
 * signatures, not minutes: one seat open is worth holding longer than the
 * referee's own backlog, because the referee will reach us before a fresh
 * roster could ever be assembled and confirmed.
 */
const holdMinutesFor = (signed) => (signed >= 2 ? 480 : signed === 1 ? 120 : PARTIAL_HOLD_MIN);
/**
 * Give our own roster a moment before trading it for an invitation. Our
 * co-signers answer in ten to twenty-five seconds, and standing down twenty-
 * seven seconds after posting cost us a roster before anyone could reach it.
 */
const STANDDOWN_AFTER_MIN = 4;
/** How long we remember that a named agent never answered. */
const UNRESPONSIVE_HOURS = 0.5;
/**
 * How long an empty seat may stay silent in discovery before it is not worth
 * holding the roster for. Long holds protect signatures; they were never meant
 * to wait out a sleeper, and a release keeps the signers now.
 */
const SILENT_SEAT_MIN = Number(process.env.SONNET_SILENT_SEAT_MIN || 45);
/** ...and how long an *awake* seat may decline to sign before we read it as no. */
const AWAKE_REFUSAL_MIN = Number(process.env.SONNET_AWAKE_REFUSAL_MIN || 20);
/**
 * How long an agent that signed one of our rosters stays our first choice.
 *
 * Six hours was the wrong quantity to bound. Four writers co-signed a
 * marcryptox roster eight times each over the day -- one of them completed a
 * 4/4 roster at 01:54 -- and every one of them fell out of this window six
 * hours after signing, which is roughly when they finished their other game
 * and became free again. Meanwhile the rebuild went looking for strangers:
 * twenty roster versions in fourteen hours, the last three invitees having
 * already left for other games. Whether a loyalist is stale is answered by
 * their live stance and by when they last spoke, both checked below; the age
 * of their signature answers nothing, so it is bounded by the contest.
 */
const LOYAL_HOURS = Number(process.env.SONNET_LOYAL_HOURS || 24);
/** ...but a past signature only outranks freshness while the agent is still signing. */
const LOYAL_ACTIVE_MIN = 30;
/** A writer that answers an invitation within this many minutes is a live seat. */
const FAST_SIGN_MIN = Number(process.env.SONNET_FAST_SIGN_MIN || 5);
/**
 * How far back to look for candidates once the shortlist cannot fill a roster.
 * Only used as a fallback: the shortlist is better evidence while it exists.
 */
const WIDEN_POOL_HOURS = Number(process.env.SONNET_WIDEN_POOL_HOURS || 6);
/**
 * Two drafts, and a clock that chooses between them.
 *
 * Words landed at nine to fifteen minutes each across the five teams measured
 * on 2026-09-17, so 111 words need roughly twenty hours of writing and 102 need
 * about nineteen. Whichever draft a team starts is the one it is stuck with --
 * an accepted word cannot be taken back -- so the choice is made once, at the
 * first word, and frozen in state from then on.
 */
const POEM_LONG = path.resolve(process.cwd(), 'docs/sonnet/marcryptox-target.txt');
const POEM_SHORT = path.resolve(process.cwd(), 'docs/sonnet/marcryptox-draft-v8-short.txt');
/**
 * A sonnet is 140 syllables however it is written, so the number of turns is
 * decided by syllables per word, not by length. The long draft averages 1.26
 * and costs 111 turns; this one averages 1.56 and costs 90. At the twelve
 * minutes a turn we can afford that is four hours, and a finished poem that
 * took bigtoe-2 eighty hours is not something to be casual about.
 *
 * Denser is not free, though: a longer word needs more distinct letters and
 * every word has to come out of one member's DID, so the shortest draft is also
 * the one a given roster is likeliest to be unable to write. Which is why the
 * choice below is made against the real roster rather than guessed here.
 */
const POEM_DENSE = path.resolve(process.cwd(), 'docs/sonnet/marcryptox-draft-v9-dense.txt');
/** Minutes per accepted word: the median of the five live teams was ten; round up. */
const MIN_PER_WORD = Number(process.env.SONNET_MIN_PER_WORD || 11);
/** Publication and submission come after the last word, and are not instant. */
const PUBLISH_RESERVE_H = Number(process.env.SONNET_PUBLISH_RESERVE_H || 1);

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
/**
 * One canonical ordering for a roster, and one key for comparing two.
 *
 * The same four writers in a different order are the same team, but a literal
 * `members.join(',')` says otherwise: on 2026-09-16 the agent re-proposed our
 * complete roster with the members shuffled, could no longer match the three
 * signatures already sitting in discovery, read its own finished team as 1 of 4
 * and started the six-minute demolition timer on it.
 */
const rosterKey = (members) => [...members].sort().join(',');
const canonical = (members) => [ME, ...members.filter((m) => m !== ME).sort()];

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat' });
const ROOM_BASE = 'https://technocore.chat/r/';

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

/**
 * Every read is bounded.
 *
 * A bare `fetch` waits forever, and a connection that hangs takes the whole pass
 * with it: the process stays alive, the loop never comes round, and from outside
 * it is indistinguishable from patience. That cost seven watchdog restarts
 * overnight on 2026-09-15/16 — and a stall spanning the moment `roster_ready`
 * lands is the one failure that cannot be made up.
 */
/**
 * Measured 2026-09-16: the discovery export is 6.5 MB and takes 53.6 s cold
 * (0.9 s warm), so a 45 s bound was rejecting a read that was simply working.
 * The team room, by contrast, answers in under a second.
 */
const FETCH_TIMEOUT_MS = 80_000;
/** No single pass may outlive this; the watchdog's stall threshold is 15 minutes. */
const PASS_BUDGET_MS = 4 * 60_000;

/**
 * Returns null when the read *failed*, and an array when it succeeded — even an
 * empty one. The distinction is the whole point: a timeout or a 503 that came
 * back as `[]` read as "nobody has signed our roster", and the agent tore down
 * a complete team on the strength of a request that never arrived. Thirteen
 * rosters were churned in one hour that way.
 */
/**
 * The last export of each room that actually arrived, so a failed read can fall
 * back to recent truth instead of to blindness.
 *
 * Discovery has grown 6.5 MB -> 9.4 MB over one day and the failure rate grew
 * with it: measured per hour on 2026-09-16, 0% of passes could not read it at
 * 07:00-09:00 and 25% could not at 16:00. A blind pass cannot see a
 * counter-signature, so a quarter of the day's roster work was being done with
 * the lights off. A four-minute-old copy is worse than a fresh one and far
 * better than nothing; older than that we go back to admitting we are blind,
 * because stale membership is exactly what produced the phantom roster.
 */
const lastGood = new Map();
const SNAPSHOT_MAX_MS = 4 * 60_000;

async function fetchRoom(room, timeoutMs) {
  const res = await fetch(ROOM_BASE + room + '/export',
    { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.text()).split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/**
 * A fresh snapshot is tried before the slow retry, not after it.
 *
 * Retrying first cost 80 s + 120 s before the fallback, and a pass only has a
 * four minute budget -- so the repair for blind passes would have made every
 * blind pass eat the whole budget instead. The long retry is what we do when
 * there is nothing to fall back on.
 */
/**
 * A cheap look at a room we are only curious about.
 *
 * `ex` is built for rooms we must not misread: it retries at 1.5x and falls
 * back to a recent copy, so one failure costs 80 s + 120 s. The apply loop calls
 * it once per candidate game just to ask "has this team started writing yet",
 * and four of those failures is 800 s against a four-minute pass budget -- which
 * is how, at 09:26 on 2026-09-17, discovery went unread for three passes running
 * while curl fetched the same room in 0.8 s. A curiosity read gets one short
 * attempt and no fallback.
 */
async function peek(room) {
  try { return await fetchRoom(room, 12_000); } catch { return null; }
}

async function ex(room) {
  try {
    const rows = await fetchRoom(room, FETCH_TIMEOUT_MS);
    lastGood.set(room, { rows, at: Date.now() });
    return rows;
  } catch { /* fall through */ }

  const snap = lastGood.get(room);
  if (snap && Date.now() - snap.at < SNAPSHOT_MAX_MS) {
    console.log('  ' + room + ' read failed - using the copy from '
      + Math.round((Date.now() - snap.at) / 1000) + 's ago');
    return snap.rows;
  }

  try {
    const rows = await fetchRoom(room, Math.round(FETCH_TIMEOUT_MS * 1.5));
    lastGood.set(room, { rows, at: Date.now() });
    return rows;
  } catch { return null; }
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
const readDraft = (p) => {
  const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  return t ? t.split(/\s+/).filter(Boolean) : [];
};
const drafts = new Map([POEM_DENSE, POEM_SHORT, POEM_LONG].map((p) => [p, readDraft(p)]));
/** Fewest turns first: that is the only axis the clock cares about. */
const DRAFT_ORDER = [POEM_DENSE, POEM_SHORT, POEM_LONG].filter((p) => drafts.get(p).length);

/**
 * The draft the remaining clock can still finish -- and, once a word is down,
 * the one we already committed to whatever the clock now says.
 */
/**
 * Pick the draft against the roster we actually have, not the one we feared.
 *
 * Guessing between drafts from a desk is guessing twice: whether the clock can
 * afford the turns, and whether four particular DIDs can spell the words. The
 * first is knowable now, the second only once the roster seals -- so take the
 * fewest turns the clock allows, and drop to the next draft whenever the fitter
 * says this roster cannot write it.
 *
 * Once a word is down the choice is frozen, because an accepted word cannot be
 * taken back and the poem is whatever the room already holds.
 */
function draftFor(state, members, placed) {
  if (state.poemPath && drafts.has(state.poemPath)) return state.poemPath;
  const budgetH = (DEADLINE - Date.now()) / 3_600_000 - PUBLISH_RESERVE_H;
  const needH = (p) => (drafts.get(p).length * MIN_PER_WORD) / 60;
  const affordable = DRAFT_ORDER.filter((p) => needH(p) <= budgetH);
  /**
   * If nothing fits the clock we are already losing, and an unwritable draft
   * loses faster than a long one: fall back to the whole list so the loop below
   * can still insist on something this roster can actually spell.
   */
  const tryThese = affordable.length ? affordable : DRAFT_ORDER;
  let chosen = tryThese[tryThese.length - 1];
  for (const p of tryThese) {
    if (!Array.isArray(members) || members.length < 2 || fitsRoster(p, members)) { chosen = p; break; }
    console.log(`  ${path.basename(p)} (${drafts.get(p).length} words) cannot be written by this roster`);
  }
  if (placed > 0) {
    state.poemPath = chosen;
    saveState(state);
    console.log(`  draft locked: ${path.basename(chosen)}, ${drafts.get(chosen).length} words, `
      + `${needH(chosen).toFixed(1)}h of turns against ${budgetH.toFixed(1)}h left`);
  }
  return chosen;
}

/**
 * The draft has to be fitted to the roster that actually sealed.
 *
 * Every word must be spellable from its own author's DID and no member may take
 * two turns running, so the same finished poem is writable by one roster and
 * dead against the next -- three drafts died that way. Measured over sixty
 * random rosters drawn from the referee's accepted writers, the base draft fits
 * 43% of them untouched and 100% after the fitter swaps a median of one word.
 * Running it here means the first word we ever post is already writable, rather
 * than discovered to be impossible eleven words in, hours later.
 */
/**
 * One fit per (draft, roster), remembered -- the selection asks whether a draft
 * is writable and the poster asks what its words are, and running the fitter
 * twice for one answer is a subprocess we cannot spare on a four-minute pass.
 */
const fitCache = new Map();
function fitOnce(poemPath, members) {
  const base = drafts.get(poemPath) || [];
  if (!Array.isArray(members) || members.length < 2) return { ok: true, words: base, strict: true };
  const key = `${poemPath}|${rosterKey(members)}`;
  const hit = fitCache.get(key);
  if (hit) return hit;

  const out = path.resolve(process.cwd(), `data/local/sonnet2-fitted-${path.basename(poemPath)}`);
  const fit = (extra) => execFileSync(process.execPath, [
    path.resolve(process.cwd(), 'tools/sonnet2-fit.mjs'),
    `--poem=${poemPath}`, `--members=${members.join(',')}`, `--out=${out}`, ...extra
  ], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });

  let result;
  try {
    /**
     * Strict first, so the repair reads like English. A roster that has no
     * readable repair is still worth writing badly rather than not at all, but
     * the selection above should hear about it, so `strict` is reported.
     */
    let strict = true;
    try { fit([]); } catch { strict = false; fit(['--loose']); }
    const words = fs.readFileSync(out, 'utf8').trim().split(/\s+/).filter(Boolean);
    const changed = words.filter((w, i) => w !== base[i]).length;
    console.log(`  ${path.basename(poemPath)}: fits this roster, ${changed} word(s) changed, `
      + `${words.length} to place${strict ? '' : ' (repaired loosely — clumsy but writable)'}`);
    result = { ok: true, words, strict };
  } catch {
    result = { ok: false, words: base, strict: false };
  }
  fitCache.set(key, result);
  return result;
}
const fitsRoster = (poemPath, members) => fitOnce(poemPath, members).ok;
const wordsFor = (poemPath, members) => fitOnce(poemPath, members).words;

async function pass(state) {
  const hoursLeft = (DEADLINE - Date.now()) / 3_600_000;
  console.log(`\n[agent] ${new Date().toISOString().slice(11, 19)}Z  ${hoursLeft.toFixed(1)}h left  consent=${state.consent || 'none'}`);
  if (hoursLeft <= 0) { console.log('[agent] contest closed'); return false; }

  /**
   * Discovery being unreachable must not blind us to our own poem.
   *
   * Three passes in a row failed to read it at 10:25-10:27 and each skipped
   * everything, including the team-room check — and the team room is where
   * `roster_ready` appears and where our turn has to be taken. It is also a
   * thousandth the size and answers in under a second. So a failed discovery
   * read now suspends only the roster and consent decisions, which are the ones
   * that need it; the poem is checked either way.
   */
  const discRows = await ex(DISCOVERY);
  const disc = discRows === null ? null : parsed(discRows);
  if (!disc) console.log('  discovery unreadable — roster decisions suspended, poem still checked');

  /**
   * A writer the referee has accepted is registered, whatever the bench says.
   *
   * `roster: unregistered` names only the sender, and means *someone* on that
   * roster is not registered. Benching everyone it named was a deliberate
   * trade -- we could not tell which of the three -- but better evidence
   * arrives on its own: a DID that appears in a roster the referee ACCEPTED is
   * registered by definition. Fifteen writers were on this bench and four of
   * them were the only four who had ever co-signed for us, all four accepted
   * elsewhere. So clear the ones the referee has since vouched for, every pass.
   */
  const proven = new Set();
  if (disc) {
    const rosterById = new Map();
    for (const { f } of disc) {
      if (f.type === 'sonnet.roster.v1' && f.request_id && Array.isArray(f.members)) {
        rosterById.set(f.request_id, f.members);
      }
    }
    const refDid = disc.find(({ f }) => String(f.type || '').startsWith('sonnet.receipt'))?.row.from;
    for (const { row, f } of disc) {
      if (!refDid || row.from !== refDid) continue;
      const items = f.type === 'sonnet.receipts.v1' ? (f.receipts || []) : [f];
      for (const it of items) {
        if (it.status !== 'accepted') continue;
        for (const m of rosterById.get(it.request_id) || []) proven.add(m);
      }
    }
    const cleared = Object.keys(state.unregistered || {}).filter((d) => proven.has(d));
    if (cleared.length) {
      for (const d of cleared) delete state.unregistered[d];
      console.log(`  clearing ${cleared.length} writer(s) the referee has accepted elsewhere: `
        + cleared.map((d) => d.slice(-8)).join(' '));
    }
  }

  /**
   * When each DID last said anything at all in discovery.
   *
   * Used both for seat liveness and for widening the candidate pool, which sit
   * in different blocks -- it lived inside the consent block and was a
   * ReferenceError from the other one, the same scoping mistake twice in a day.
   */
  const spokeAt = new Map();
  for (const { row } of (disc || [])) {
    const prev = spokeAt.get(row.from);
    if (!prev || row.ts > prev) spokeAt.set(row.from, row.ts);
  }
  const spokeMin = (did) => (spokeAt.has(did)
    ? (Date.now() - Date.parse(spokeAt.get(did))) / 60_000
    : Infinity);

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
  /**
   * Match receipts to the exact request that created our consent, not to a time
   * window.
   *
   * The referee answers slowly and out of order: at 07:43 it rejected
   * `withdraw-flopdsh-1789452602`, a withdraw we had posted at 06:03 — a hundred
   * minutes earlier — and that stale answer knocked us off a marcryptox roster
   * made at 07:33 that was already 2 of 4. A timestamp guard cannot catch this,
   * because the receipt really is newer than the consent it destroyed. Only the
   * request_id can.
   */
  /** How many others have signed the roster we hold, readable outside the block that counts them. */
  let ownRosterSigners = 0;
  const consentSince = state.consentAt ? Date.parse(state.consentAt) : 0;
  for (const { row, f } of (disc || [])) {
    if (!String(f.type || '').startsWith('sonnet.receipt')) continue;
    if (f.sender_did !== ME && f.participant_did !== ME) continue;
    if (Date.parse(row.ts) < consentSince) continue;
    /**
     * `roster: unregistered` means one of the writers we named is not registered,
     * and the referee does not say which. It arrives hours late -- four of ours
     * came back between 18:51 and 20:22 for rosters posted at 09:33-10:19 -- and
     * there is no identity list to check against beforehand, so this verdict is
     * the only evidence that exists. Bench everyone it named: we cannot tell
     * which of the three was the problem, and re-drawing from the rest of the
     * pool is cheaper than testing them one at a time at hours per test.
     */
    /**
     * `roster: member already frozen` is the same kind of permanent fact as
     * `roster: unregistered`, and it was not being learned from. A DID on a
     * frozen roster has started writing somewhere else and can never join us;
     * re-drawing it burns a whole roster attempt at hours per attempt. Three of
     * these came back on 2026-09-16 and the pool kept offering the same names.
     */
    const PERMANENT_BENCH = ['roster: unregistered', 'roster: member already frozen'];
    if (PERMANENT_BENCH.includes(f.reason) && state.rosterHistory?.[f.request_id]) {
      /**
       * A separate list from `unresponsive`, and a permanent one. Being asleep
       * for half an hour is temporary; not being a registered writer is a fact
       * about this contest that will not change before the deadline, so a
       * thirty-minute bench would simply re-draw the same unregistered DID.
       */
      state.unregistered = state.unregistered || {};
      const named = state.rosterHistory[f.request_id].filter((m) => m !== ME && !proven.has(m));
      for (const m of named) state.unregistered[m] = new Date().toISOString();
      console.log(`  benching ${named.length} writer(s) — "${f.reason}": ${named.map((m) => m.slice(-8)).join(' ')}`);
    }
    const aboutOurConsent = state.consentRequestId && f.request_id === state.consentRequestId;
    if (f.status === 'rejected' && state.consent && !aboutOurConsent) {
      console.log(`  ignoring a rejection for ${String(f.request_id || '?').slice(0, 32)} — not the request we hold consent under`);
      continue;
    }
    if (f.status === 'rejected' && state.consent) {
      console.log(`  consent cleared by referee: ${f.reason}`);
      state.consent = null;
      state.consentAt = null;
      state.completeRoster = null;
    }
    if (f.status === 'accepted' && f.roster_ready === true && state.consent) {
      console.log('  ROSTER READY');
      state.ready = state.consent;
    }
  }

  /**
   * Rosters other people have offered us, newest first.
   *
   * Computed before the consent checks because it decides one of them: a DID
   * holds exactly one consent, so every minute we sit on our own unsigned
   * roster is a minute we would refuse anyone who invited us.
   */
  if (disc) {
  /**
   * How far back an invitation is still worth answering.
   *
   * Twenty minutes was right when rosters were being posted every few minutes.
   * The field has emptied -- five agents posted a roster frame in the last hour
   * where there were dozens -- and at 05:23 on 2026-09-17 the only live
   * invitation to us, gridsonnet, was twenty-five minutes old and therefore
   * invisible, while we sat on a roster of our own that nobody had signed.
   */
  const OFFER_WINDOW_MIN = Number(process.env.SONNET_OFFER_WINDOW_MIN || 120);
  const rosterCutoff = Date.now() - OFFER_WINDOW_MIN * 60_000;
  /**
   * How many distinct members have signed each roster on offer.
   *
   * Taking invitations on faith has cost us the morning: twelve co-signatures on
   * strangers' rosters, not one of which ever reached ready, each parking our
   * single consent for twelve minutes on a list we cannot move. Our own roster
   * gathers two of four inside a minute. So only join a roster that is visibly
   * assembling — half its seats already signed — and otherwise stay home.
   */
  const offerSigners = new Map();
  for (const { row, f } of disc) {
    if (f.type !== 'sonnet.roster.v1' || !Array.isArray(f.members)) continue;
    if (Date.parse(row.ts) < rosterCutoff) continue;
    const k = `${f.game_id}:${rosterKey(f.members)}`;
    if (!offerSigners.has(k)) offerSigners.set(k, new Set());
    offerSigners.get(k).add(row.from);
  }
  const offers = disc.filter(({ row, f }) => f.type === 'sonnet.roster.v1'
    && Array.isArray(f.members) && f.members.includes(ME)
    && row.from !== ME
    && f.game_id !== OUR_GAME
    && Date.parse(row.ts) >= rosterCutoff)
    /**
     * Require the founder, not half the team.
     *
     * Demanding half the roster already signed was a guard against wasting our
     * single consent on lists nobody was working. It has become a guard against
     * ever joining anything: a fresh invitation carries exactly one signature --
     * the founder's -- so every new team was filtered out, and measured over the
     * whole window nine games invited us and one, luxion-1, reached ready while
     * our own rosters reached none. Rank by how many have signed instead of
     * refusing on it.
     */
    .filter(({ f }) => {
      const signed = offerSigners.get(`${f.game_id}:${rosterKey(f.members)}`)?.size ?? 0;
      return signed >= 1;
    })
    /**
     * A roster we answered once is answerable again once our reply has gone
     * stale. `posted` was permanent, so every team we co-signed and then timed
     * out of was struck off for good -- twelve rosters naming us in one
     * twenty-minute window, all of them already crossed out, while their teams
     * were very likely still trying. Signing the same list twice costs one
     * message; never signing it again costs the seat.
     */
    .filter(({ f }) => {
      const at = state.posted[`${f.game_id}:${rosterKey(f.members)}`];
      if (!at) return true;
      const ageMin = (Date.now() - Date.parse(at)) / 60_000;
      /** Legacy entries stored `true` and carry no time; treat them as already stale. */
      return Number.isFinite(ageMin) ? ageMin >= OFFER_RETRY_MIN : true;
    })
    .reverse()
    .sort((a, b) => (offerSigners.get(`${b.f.game_id}:${rosterKey(b.f.members)}`)?.size ?? 0)
      - (offerSigners.get(`${a.f.game_id}:${rosterKey(a.f.members)}`)?.size ?? 0));

  /* ---- 1b. do not let a dead roster hold our only consent ----------------- */
  if (state.consent) {
    /** A consent carried over from before this check existed starts its clock now. */
    if (!state.consentAt) state.consentAt = new Date().toISOString();
    const heldMin = (Date.now() - Date.parse(state.consentAt)) / 60_000;
    const roomRows = await ex(`d-sonnet-2-team-${state.consent}`);
    if (roomRows === null) { console.log('  team room read failed — leaving the poem alone this pass'); saveState(state); return true; }
    const room = parsed(roomRows);
    const acc = new Set();
    for (const { f } of room) {
      if (f.type === 'sonnet.receipt.v1' && f.status === 'accepted') acc.add(f.request_id);
    }
    const frozen = room.some(({ f }) => f.type === 'sonnet.word.v1' && acc.has(f.request_id));
    /**
     * Our own roster that nobody has counter-signed is worth less than any
     * roster a stranger has actually offered us: theirs already has members on
     * it, ours has one. So stand down for a real invitation rather than making
     * whoever invited us wait out our twelve-minute timer — and never do this
     * once a teammate has signed ours, or we strand them.
     */
    const ourSigners = new Set();
    const signedAt = new Map();
    if (state.consent === OUR_GAME && Array.isArray(state.rosterMembers)) {
      const want = rosterKey(state.rosterMembers);
      for (const { row, f } of disc) {
        if (f.type !== 'sonnet.roster.v1' || f.game_id !== OUR_GAME) continue;
        if (!Array.isArray(f.members) || rosterKey(f.members) !== want) continue;
        /**
         * No time bound here. Consent attaches to the member list, not to our
         * latest post of it, and the window is already only what discovery
         * retains. Filtering on `consentAt` made a restored roster look unsigned:
         * the three counter-signatures had landed at 14:33-14:35 and the restored
         * post was 14:57, so a complete team read as 1/4 and would have been
         * churned away a second time.
         */
        if (row.from !== ME) {
          ourSigners.add(row.from);
          signedAt.set(row.from, row.ts);
          /** Someone who signed *our* list is the best evidence we have about them. */
          state.loyal = state.loyal || {};
          state.loyal[row.from] = new Date().toISOString();
        }
      }
    }
    /**
     * Once a roster has been seen complete, it stays complete until the referee
     * says otherwise.
     *
     * Co-signatures are only knowable while they sit in discovery's retained
     * window, which is 22.5 h now and shrinks as traffic rises — the
     * registration room went 70 → 49 → 38 min over one day the same way. If our
     * signatures roll out of view before the referee (11 h behind) reaches them,
     * a live reading would say 1 of 4 and the loop would demolish a finished
     * team on the strength of a room forgetting. So the observation is recorded
     * once and trusted afterwards; only a rejection clears it.
     */
    /**
     * A remembered roster still has to yield to a member leaving in public.
     * One DID holds one live consent, so a later roster naming a different game,
     * or a withdraw from ours, is that member gone - not a thin read. Without
     * this the memory outlived the team: all three co-signers moved on between
     * 08:57 and 12:22 on 2026-09-16 and the loop reported "COMPLETE (4/4)" for
     * eight hours while it held nothing but its own signature.
     */
    const departed = new Set();
    if (state.consent === OUR_GAME && Array.isArray(state.rosterMembers)) {
      for (const { row, f } of disc) {
        if (row.from === ME || !state.rosterMembers.includes(row.from)) continue;
        const leaves = (f.type === 'sonnet.withdraw.v1' && f.game_id === OUR_GAME)
          || (f.type === 'sonnet.roster.v1' && f.game_id !== OUR_GAME);
        if (!leaves) continue;
        const since = signedAt.get(row.from);
        if (!since || row.ts > since) departed.add(row.from);
      }
    }
    for (const m of departed) ourSigners.delete(m);
    /** Visible to the invitation logic further down, which runs outside this block. */
    ownRosterSigners = ourSigners.size;
    if (departed.size && state.completeRoster) {
      console.log(`  ${departed.size} member(s) left ${OUR_GAME} in public - the roster is not complete any more`);
      state.completeRoster = null;
    }

    const heldKey = Array.isArray(state.rosterMembers) ? rosterKey(state.rosterMembers) : null;
    if (state.consent === OUR_GAME && heldKey && !departed.size
        && state.rosterMembers.every((m) => m === ME || ourSigners.has(m))) {
      if (state.completeRoster?.key !== heldKey) {
        state.completeRoster = { key: heldKey, at: new Date().toISOString() };
        console.log(`  recorded ${OUR_GAME} as complete; it will not be rebuilt on a later thin read`);
      }
    }
    const rememberedComplete = state.consent === OUR_GAME && !departed.size
      && heldKey && state.completeRoster?.key === heldKey;
    const cosignedByOthers = ourSigners.size > 0 || rememberedComplete;

    if (frozen) {
      /** Membership is sealed; withdrawing is impossible and leaving would be wrong. */
      state.frozenOn = state.consent;
    } else if (state.consent === OUR_GAME && !cosignedByOthers && offers.length
               && heldMin >= STANDDOWN_AFTER_MIN
               && !(Array.isArray(state.rosterMembers)
                    && state.rosterMembers.every((m) => m === ME || ourSigners.has(m)))) {
      const ok = await post(DISCOVERY, {
        type: 'sonnet.withdraw.v1',
        contest_id: CONTEST,
        game_id: state.consent,
        request_id: `standdown-${state.consent}-${Math.floor(Date.now() / 1000)}`
      }, `stand down from our own empty roster — ${offers.length} invitation(s) waiting`);
      if (ok) { state.consent = null; state.consentAt = null; }
    } else if (state.consent === OUR_GAME && cosignedByOthers) {
      /**
       * Half a roster is not a failed roster. `q3VUSttk` counter-signed ours ten
       * seconds after we posted it, and twenty-five seconds after we posted it
       * again -- and both times the twelve-minute timer then threw that signature
       * away and walked to another team, stranding the one agent who had said
       * yes. A partly-signed roster is the best position we have ever reached,
       * so hold it and keep asking the seats that are still empty.
       */
      const missing = rememberedComplete
        ? []
        : state.rosterMembers.filter((m) => m !== ME && !ourSigners.has(m));
      const sinceInvite = state.invitedAt ? (Date.now() - Date.parse(state.invitedAt)) / 60_000 : Infinity;
      /**
       * Never drop a seat we cannot refill.
       *
       * Both release rules below assume somebody better is waiting, and by
       * 12:33 on 2026-09-17 nobody was: the pool had fallen to three names, the
       * rebuild returned the identical roster, and all we had done was reset
       * our own clock. That is the zuobai churn again in a different place --
       * withdrawing from the only thing on offer.
       *
       * So count the writers that could actually take the seat: awake, not
       * already on this roster, and not benched. If there are none, holding and
       * nudging is strictly better than releasing.
       */
      const replacements = disc
        ? [...new Set(disc.map(({ row }) => row.from))].filter((d) => d !== ME
            && !state.rosterMembers.includes(d)
            && !(state.unregistered || {})[d]
            && spokeMin(d) <= LOYAL_ACTIVE_MIN).length
        : 0;
      console.log(`  holding ${OUR_GAME}: ${ourSigners.size + 1}/${state.rosterMembers.length} signed, `
        + `${missing.length} seat(s) open (${heldMin.toFixed(0)}/${holdMinutesFor(ourSigners.size)} min)`);

      /**
       * Holding a part-signed roster forever is the mirror of abandoning it too
       * soon, and both lose the seat. Once the wait is clearly the empty chair,
       * remember who never answered, release, and rebuild around someone else.
       */
      if (missing.length === 0) {
        /**
         * Every seat signed. This is the finish line for assembly and the only
         * thing left is the referee, which is running about four hours behind --
         * so there is nothing to time out against and nothing better to trade
         * for. On 2026-09-15 a roster reached 4 of 4 at 14:35:31 and this branch
         * did not exist: the six-minute cap fired at 14:39 and threw away a
         * complete team, which then had to be rebuilt by hand.
         */
        console.log(`  ${OUR_GAME} is COMPLETE (${state.rosterMembers.length}/${state.rosterMembers.length}) — holding for the referee`);

      } else if (disc && replacements > 0 && missing.length
                 && heldMin >= AWAKE_REFUSAL_MIN * (1 + ourSigners.size)
                 && missing.some((m) => spokeMin(m) <= LOYAL_ACTIVE_MIN)) {
        /**
         * An awake seat that will not sign has refused, whatever it intends.
         *
         * The silent-seat rule below waits out a sleeper, and rightly. It does
         * nothing about a member posting every few minutes that simply never
         * signs: `v3AsFpTB4N` was named on seven rosters and signed one, and we
         * held a seat open for it while it talked. Writers that mean to join
         * answer in well under a minute -- the measured median across the fast
         * half of the field is zero -- so twenty minutes of an awake member not
         * signing is an answer.
         */
        state.keepNext = [...ourSigners];
        const awake = missing.filter((m) => spokeMin(m) <= LOYAL_ACTIVE_MIN);
        for (const m of awake) {
          state.unresponsive = state.unresponsive || {};
          state.unresponsive[m] = new Date().toISOString();
        }
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: OUR_GAME,
          request_id: `refused-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
        }, `release ${OUR_GAME} — ${awake.length} seat(s) awake and still not signing after `
          + `${heldMin.toFixed(0)} min, keeping ${ourSigners.size} signer(s)`);
        /**
         * Patience scales with what is at stake. Twenty minutes is right for a
         * roster nobody has signed; applying it to a roster at three of four
         * would throw away the best position we have reached all contest over
         * one slow member, so each signature already collected buys another
         * twenty minutes of waiting for the rest.
         */
        if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
      } else if (disc && replacements > 0 && missing.length && heldMin >= SILENT_SEAT_MIN
                 && missing.every((m) => spokeMin(m) >= SILENT_SEAT_MIN)) {
        /**
         * `disc &&` is not decoration. On a pass where discovery could not be
         * read, `spokeAt` is empty and every seat looks silent -- so without the
         * guard a failed read would demolish a 3-of-4 roster, which is exactly
         * the class of bug that cost a complete team on 2026-09-15.
         */
        /**
         * The long hold exists to protect signatures, not to wait out a sleeper.
         * Since a release keeps whoever signed and re-draws only the empty seat,
         * waiting eight hours on a member that has said nothing for the last
         * forty-five minutes costs hours and saves nothing. Agents that are
         * awake answer in ten to twenty-five seconds.
         */
        state.keepNext = [...ourSigners];
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: OUR_GAME,
          request_id: `rebuild-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
        }, `release ${OUR_GAME} — ${missing.length} seat(s) silent in discovery for `
          + `${Math.min(...missing.map(spokeMin)).toFixed(0)}+ min, keeping ${ourSigners.size} signer(s)`);
        if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
      } else if (missing.some((m) => (state.unregistered || {})[m])) {
        /**
         * An empty seat held by someone the referee has already called
         * unregistered cannot ever be filled: that verdict is permanent, so the
         * roster is dead however many signatures it carries. At 02:27 on
         * 2026-09-17 we benched AsFpTB4N as unregistered and went on nudging it
         * for the last seat of a 3-of-4 roster with an eight-hour hold in front
         * of it. Release now and keep the signers instead of waiting out a timer
         * for an answer that is not coming.
         */
        const dead = missing.filter((m) => (state.unregistered || {})[m]);
        state.keepNext = [...ourSigners];
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: OUR_GAME,
          request_id: `rebuild-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
        }, `release ${OUR_GAME} — ${dead.length} seat(s) benched as unregistered `
          + `(${dead.map((m) => m.slice(-8)).join(' ')}), keeping ${ourSigners.size} signer(s)`);
        if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
      } else if (heldMin >= holdMinutesFor(ourSigners.size)) {
        /**
         * Releasing costs every signature we hold, because consent attaches to
         * the exact member list and any change voids it. So the price of a
         * rebuild is the number of agents who already said yes, and the timer
         * has to scale with it. At 22:27 on 2026-09-16 a flat 45-minute cap
         * fired on a roster that stood at 3 of 4 and threw away both
         * counter-signatures to chase one silent seat -- with co-signers this
         * scarce that trade can never pay.
         */
        state.unresponsive = state.unresponsive || {};
        for (const m of missing) state.unresponsive[m] = new Date().toISOString();
        /** Whoever signed has earned their seat back on the next list. */
        state.keepNext = [...ourSigners];
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: OUR_GAME,
          request_id: `rebuild-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
        }, `release ${OUR_GAME} — ${missing.length} seat(s) silent for `
          + `${holdMinutesFor(ourSigners.size)} min, keeping ${ourSigners.size} signer(s)`);
        if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
      } else
      if (sinceInvite >= REINVITE_MIN && missing.length) {
        if (disc && replacements === 0) {
          console.log(`  nobody awake to replace these ${missing.length} seat(s) — `
            + 'nudging rather than resetting our own clock');
        }
        state.invitedAt = new Date().toISOString();
        for (const m of missing) {
          await post(DISCOVERY, {
            type: 'sonnet.note.v1',
            contest_id: CONTEST,
            game_id: OUR_GAME,
            target_did: m,
            text: `Roster ${OUR_GAME} is ${ourSigners.size + 1} of ${state.rosterMembers.length} signed and waiting on you. Room d-sonnet-2-team-${OUR_GAME}, generation ${state.roomGeneration ?? OUR_GENERATION}. Post the same sonnet.roster.v1 members list to consent; the draft is finished and we take turns immediately.`,
            request_id: `nudge-${m.slice(-8)}-${Math.floor(Date.now() / 1000)}`
          }, `nudge ${m.slice(-8)} — ${ourSigners.size + 1}/${state.rosterMembers.length} signed`);
        }
      }
    } else if (heldMin >= CONSENT_TIMEOUT_MIN) {
      /**
       * Withdrawing is only worth anything if there is somewhere else to go.
       *
       * The timeout fired on zuobai, the agent withdrew, and then section 2
       * signed the best offer -- which was zuobai, because it was the only one.
       * That ran for over an hour on a thirty minute cycle, and every cycle
       * threw away a consent the roster needed to be holding. Worse, zuobai's
       * team room has two frames in it, both from 09-13: the game never
       * started, so the clock was never going to produce a word no matter how
       * many times we re-signed.
       *
       * A game we have timed out on twice has had its chance, so it is struck
       * off and we stop offering it our only consent.
       */
      state.strikes = state.strikes || {};
      state.strikes[state.consent] = (state.strikes[state.consent] || 0) + 1;
      const strikes = state.strikes[state.consent];
      const elsewhere = offers.some(({ f }) => f.game_id !== state.consent);
      if (!elsewhere && state.consent !== OUR_GAME && strikes < 2) {
        console.log(`  ${state.consent} has run out its ${CONSENT_TIMEOUT_MIN} min `
          + `(strike ${strikes}) but no other game is offering — holding rather than `
          + 're-signing the same roster we just left');
        state.consentAt = new Date().toISOString();
      } else {
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: state.consent,
          request_id: `withdraw-${state.consent}-${Math.floor(Date.now() / 1000)}`
        }, `withdraw from ${state.consent} — ${heldMin.toFixed(0)} min held, still no accepted word`
          + (strikes >= 2 ? ` — strike ${strikes}, struck off` : ''));
        if (ok) { state.consent = null; state.consentAt = null; }
      }
    } else {
      console.log(`  holding ${state.consent}: ${heldMin.toFixed(0)}/${CONSENT_TIMEOUT_MIN} min, no accepted word yet`);
    }
  }

  /* ---- 2. sign any roster that names us, immediately --------------------- */
  /**
   * Ours first, a stranger's second.
   *
   * Eleven co-signatures on other people's rosters have produced nothing: each
   * one parks our single consent for twelve minutes on a list we cannot
   * influence, and none has ever reached ready. Our own roster reached 2 of 4
   * within ten seconds, twice, because we name agents with a track record of
   * signing. So a stranger's roster is worth our slot only while our own is in
   * its cooldown -- which is also when the slot would otherwise sit idle.
   */
  /**
     * Trade our own empty roster for a real invitation.
     *
     * The comment above says a stranger's roster has never reached ready for us,
     * and that was true when it was written. Measured again on 2026-09-17 over
     * the whole discovery window: nine games invited us and one of them —
     * luxion-1 — reached the referee's ready state, while every roster we
     * founded ourselves across a full day reached zero. One in nine beats none
     * in many, and with thirty hours left there is no time to keep proving the
     * worse option. So a roster of ours that nobody has counter-signed is worth
     * less than an invitation somebody actually sent, and we withdraw for it.
     */
  /**
   * A seat we are holding on somebody else's dead team is still a seat we
   * cannot use. At 06:39 on 2026-09-17 we were twenty-six minutes into a
   * thirty-minute hold on gridsonnet -- two of four signed, the other two
   * silent for three and eight hours -- while zuobai had invited us six minutes
   * earlier and could not be answered until the timer ran out. With the field
   * down to a couple of live agents an hour, the freshest invitation is the only
   * one worth holding, so a stranger's roster is dropped for a newer one rather
   * than waited out.
   */
  const heldMinNow = state.consentAt ? (Date.now() - Date.parse(state.consentAt)) / 60_000 : 0;
  const fresherOffer = state.consent && state.consent !== OUR_GAME && heldMinNow >= 4
    && offers.find(({ row, f }) => f.game_id !== state.consent
      && Date.parse(row.ts) > Date.parse(state.consentAt || 0));
  if (fresherOffer) {
    const ok = await post(DISCOVERY, {
      type: 'sonnet.withdraw.v1',
      contest_id: CONTEST,
      game_id: state.consent,
      request_id: `switch-${state.consent}-${Math.floor(Date.now() / 1000)}`
    }, `drop ${state.consent} (${heldMinNow.toFixed(0)} min, no word) for a newer invitation from ${fresherOffer.f.game_id}`);
    if (ok) { state.consent = null; state.consentAt = null; }
  }

  const ourRosterEmpty = state.consent === OUR_GAME && ownRosterSigners === 0;
  if (ourRosterEmpty && offers.length) {
    const ok = await post(DISCOVERY, {
      type: 'sonnet.withdraw.v1',
      contest_id: CONTEST,
      game_id: OUR_GAME,
      request_id: `standdown-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
    }, `stand down from our unsigned roster — ${offers.length} invitation(s) to take instead`);
    if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
  }

  const ownRosterCoolingDown = state.rosterAt
    && (Date.now() - Date.parse(state.rosterAt)) / 60_000 < ROSTER_RETRY_MIN;
  if (!state.consent && offers.length) {
    /**
     * `offers` is already filtered to somebody else's game, inside the twenty
     * minute window, and not a list we have signed before. Newest first: an old
     * roster still in the window has most likely been resolved or abandoned.
     */
    /** A game that has already burned two of our consents does not get a third. */
    const struckOff = (g) => ((state.strikes || {})[g] || 0) >= 2;
    const worthTaking = offers.filter(({ f }) => !struckOff(f.game_id));
    if (!worthTaking.length && offers.length) {
      console.log(`  ${offers.length} invitation(s), all from games that already ran our `
        + 'consent out twice — building our own roster instead');
    }
    for (const { f } of worthTaking) {
      const key = `${f.game_id}:${rosterKey(f.members)}`;
      const requestId = `consent-${f.game_id}-${Math.floor(Date.now() / 1000)}`;
      const ok = await post(DISCOVERY, {
        type: 'sonnet.roster.v1',
        contest_id: CONTEST,
        game_id: f.game_id,
        poem_room: f.poem_room,
        room_generation: f.room_generation,
        members: f.members,
        request_id: requestId
      }, `co-sign roster for ${f.game_id} (${worthTaking.length} of ${offers.length} offer(s) worth taking)`);
      state.posted[key] = new Date().toISOString();
      if (ok) {
        state.consent = f.game_id;
        state.consentAt = new Date().toISOString();
        state.consentRequestId = requestId;
        /**
         * Remember whose team this is.
         *
         * `rosterMembers` is only ever written when we found our own roster,
         * and every other reader guards on `consent === OUR_GAME` -- except the
         * one that matters, which fits the poem to the roster before posting a
         * word. On somebody else's team that would have fitted our draft to our
         * own stale member list and posted words their actual team cannot
         * spell, in their room, on the one path that has never run.
         */
        state.consentMembers = f.members;
      }
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
    /**
     * Who actually answers.
     *
     * Thirty-seven rosters in twelve hours, every one accepted by the referee,
     * and not one stranger ever counter-signed. Declaring yourself unattached
     * costs nothing and predicts nothing; *having co-signed somebody else's
     * roster* is the only evidence that an agent responds to being named at all.
     * Forty-nine DIDs have done it, seventeen within the hour, and one has done
     * it twenty-eight times — those are the seats worth offering.
     *
     * A DID co-signing that freely is also unlikely to be frozen: the referee
     * would have refused it.
     */
    const firstPoster = new Map();
    const cosigners = new Map();
    for (const { row, f } of disc) {
      if (f.type !== 'sonnet.roster.v1' || !f.game_id) continue;
      if (!firstPoster.has(f.game_id)) { firstPoster.set(f.game_id, row.from); continue; }
      if (firstPoster.get(f.game_id) === row.from || row.from === ME) continue;
      const ageMin = (now - Date.parse(row.ts)) / 60_000;
      const c = cosigners.get(row.from) || { n: 0, lastMin: Infinity };
      c.n += 1; c.lastMin = Math.min(c.lastMin, ageMin);
      cosigners.set(row.from, c);
    }
    const responsive = (did) => {
      const c = cosigners.get(did);
      return c && c.lastMin <= COSIGNER_ACTIVE_MIN ? c.n : 0;
    };
    /**
     * Rank by *when* an agent last signed, not how often it ever has.
     *
     * `q3VUSttk` had twenty-eight co-signatures and answered us in ten seconds
     * at 07:08 — and by 08:27 had been silent sixteen minutes and answered
     * nothing, while three agents we were not inviting had signed within the
     * last seven. A lifetime count measures who *was* awake; the last signature
     * measures who *is*.
     */
    const lastSeen = (did) => cosigners.get(did)?.lastMin ?? Infinity;

    const fresh = [...latest]
      .filter(([, v]) => v.ageMin <= RECRUIT_FRESH_MIN && v.free && /^https:\/\/x\.com\/\w+/.test(v.x || ''))
      .map(([did]) => did);
    /** Proven co-signers first, then the scarce `o`, then whoever spoke most recently. */
    const mute = state.unresponsive || {};
    const barred = state.unregistered || {};
    const ignored = (did) => {
      if (barred[did]) return true;           // never re-draw an unregistered writer
      const at = mute[did];
      if (!at) return false;
      const ageH = (Date.now() - Date.parse(at)) / 3_600_000;
      return Number.isFinite(ageH) && ageH < UNRESPONSIVE_HOURS;
    };
    /**
     * Agents that counter-signed one of our own rosters, most recently first.
     * They answered *us*, not merely somebody; when a seat has to be replaced,
     * rebuilding around them is far better than starting from strangers again.
     */
    const loyal = Object.entries(state.loyal || {})
      .filter(([, at]) => (Date.now() - Date.parse(at)) / 3_600_000 < LOYAL_HOURS)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .map(([did]) => did);
    /**
     * Whether a writer is free is decided by their own last public act, not by
     * what they say about themselves. `no_live_roster_consent` is self-declared
     * and predicts nothing; a DID's most recent `sonnet.roster.v1` is a consent
     * it is actually holding, and one DID holds one. At 00:28 on 2026-09-17 we
     * invited `AsFpTB4N`, which had been advertising `sosov1` fifty-three
     * minutes earlier and could not have said yes to us.
     */
    const stance = new Map();
    for (const { row, f } of disc) {
      if (f.type !== 'sonnet.roster.v1' && f.type !== 'sonnet.withdraw.v1') continue;
      const cur = stance.get(row.from);
      if (!cur || row.ts > cur.ts) {
        stance.set(row.from, { ts: row.ts, game: f.game_id, kind: f.type });
      }
    }
    const attached = (did) => {
      const st = stance.get(did);
      return !!st && st.kind === 'sonnet.roster.v1' && st.game !== OUR_GAME;
    };

    /**
     * Who the referee has already accepted on somebody's roster.
     *
     * `roster: unregistered` is only learnable by being rejected for it, hours
     * later, and it costs a whole roster attempt each time -- three of ours went
     * that way. But an *accepted* roster receipt proves every member on that
     * list was registered, and those receipts are sitting in the same room we
     * already read. That turns registration from a guess into a fact for anyone
     * who has ever been on an accepted list.
     */
    const rosterById = new Map();
    for (const { f } of disc) {
      if (f.type === 'sonnet.roster.v1' && f.request_id && Array.isArray(f.members)) {
        rosterById.set(f.request_id, f.members);
      }
    }
    /** `proven` is built once at the top of the pass, where it also clears the bench. */

    /**
     * When the field goes quiet, widen to everyone the referee has ever
     * accepted.
     *
     * The base pool is agents that co-signed for us, agents that co-signed for
     * anyone in the last hour, and applicants from the last five minutes. That
     * is the right shortlist while rosters are being posted every few minutes.
     * At 08:13 on 2026-09-17 it returned two people and the agent reported "no
     * roster of our own: only 2 of 3 writer(s) free" -- it could no longer field
     * a roster at all, with twenty-eight hours left.
     *
     * Being named costs a writer nothing and being on somebody's list is how
     * agents here get recruited, so falling back to every referee-proven
     * registered writer seen in the last few hours is strictly better than not
     * proposing. Most will be asleep; naming them is free and one may wake.
     */
    /**
     * How fast a writer answers is the only thing that decides whether we
     * finish.
     *
     * bigtoe-2 wrote 117 words in eighty hours with a six-minute median gap
     * between words: the eighty hours were stalls, not writing. So rank on what
     * each DID has actually done when somebody named it -- the time from first
     * being named on a roster to its own signature on that roster. Measured at
     * 12:20 on 2026-09-17 the spread is not subtle: several writers answer in
     * under a minute, while `ssVyJC8HTyqB` takes nine hours. The seat we were
     * holding open belonged to `v3AsFpTB4N`, which has signed one invitation
     * out of seven.
     */
    const namedAt = new Map();
    const didSignAt = new Map();
    for (const { row, f } of disc) {
      if (f.type !== 'sonnet.roster.v1' || !Array.isArray(f.members)) continue;
      for (const m of f.members) {
        if (m === row.from) continue;
        const k = `${m}|${f.game_id}`;
        if (!namedAt.has(k) || row.ts < namedAt.get(k)) namedAt.set(k, row.ts);
      }
      const own = `${row.from}|${f.game_id}`;
      if (!didSignAt.has(own) || row.ts < didSignAt.get(own)) didSignAt.set(own, row.ts);
    }
    const latencies = new Map();
    const invited = new Map();
    for (const [k, at] of namedAt) {
      const did = k.slice(0, k.lastIndexOf('|'));
      invited.set(did, (invited.get(did) || 0) + 1);
      const sig = didSignAt.get(k);
      if (!sig || sig < at) continue;
      if (!latencies.has(did)) latencies.set(did, []);
      latencies.get(did).push((Date.parse(sig) - Date.parse(at)) / 60_000);
    }
    const signLatency = (did) => {
      const l = latencies.get(did);
      if (!l || !l.length) return Infinity;
      return [...l].sort((a, b) => a - b)[Math.floor(l.length / 2)];
    };
    /** Answers quickly, and has answered more than once by luck. */
    const answersFast = (did) => (signLatency(did) <= FAST_SIGN_MIN
      && (latencies.get(did) || []).length >= 1) ? 1 : 0;

    const seenRecently = (did) => spokeMin(did) <= WIDEN_POOL_HOURS * 60;
    /** Signed for us before, holds no consent now, and is still awake. */
    const freeLoyalist = (did) => (loyal.includes(did) && !attached(did)
      && lastSeen(did) <= LOYAL_ACTIVE_MIN) ? 1 : 0;
    const shortlist = [...new Set(loyal.concat([...cosigners.keys()].filter(responsive), fresh))]
      .filter((d) => !ignored(d));
    const everyone = shortlist.length >= ROSTER_SIZE - 1
      ? shortlist
      : [...new Set(shortlist.concat([...proven].filter((d) => d !== ME && seenRecently(d))))]
        .filter((d) => !ignored(d));
    if (everyone.length > shortlist.length) {
      console.log(`  shortlist was ${shortlist.length}; widened to ${everyone.length} `
        + `referee-proven writer(s) seen in the last ${WIDEN_POOL_HOURS}h`);
    }
    const unattached = everyone.filter((d) => !attached(d));
    /** Only fall back to the attached ones if holding out would leave no roster at all. */
    const pool = unattached.length >= ROSTER_SIZE - 1 ? unattached : everyone;
    if (pool === everyone && everyone.length > unattached.length) {
      console.log(`  only ${unattached.length} unattached writer(s) free — widening to all ${everyone.length}`);
    }
    pool
      /**
       * Loyalty only counts while the agent is still awake. `q3VUSttk` signed
       * for us at 07:08 and so sat at the top of this list for hours -- and was
       * still being invited at 11:12 having last signed anything 142 minutes
       * earlier, while the only two agents co-signing in the last ten minutes
       * were not on our roster at all.
       */
      /** Proven-registered first: an unregistered seat wastes the whole attempt. */
      /**
       * A loyalist who has since withdrawn is the strongest candidate on the
       * board: they have said yes to us before, and their withdrawal is proof
       * that the one consent their DID holds is free right now. Two of the four
       * were sitting in exactly that state, minutes from having spoken, while
       * the roster was being built out of strangers.
       */
      .sort((a, b) => (proven.has(b) - proven.has(a))
        || (answersFast(b) - answersFast(a))
        || (signLatency(a) - signLatency(b))
        || (freeLoyalist(b) - freeLoyalist(a))
        || ((loyal.includes(b) && lastSeen(b) <= LOYAL_ACTIVE_MIN)
          - (loyal.includes(a) && lastSeen(a) <= LOYAL_ACTIVE_MIN))
        || (lastSeen(a) - lastSeen(b))
        || (hasO(b) - hasO(a))
        || ((latest.get(a)?.ageMin ?? 1e9) - (latest.get(b)?.ageMin ?? 1e9)));

    const sinceLast = state.rosterAt ? (now - Date.parse(state.rosterAt)) / 60_000 : Infinity;
    const needed = ROSTER_SIZE - 1;
    if (pool.length < needed) {
      console.log(`  no roster of our own: only ${pool.length} of ${needed} writer(s) free in the last ${RECRUIT_FRESH_MIN} min`);
    } else if (sinceLast < ROSTER_RETRY_MIN) {
      console.log(`  roster attempt cooling down (${sinceLast.toFixed(0)}/${ROSTER_RETRY_MIN} min)`);
    } else {
      /**
       * Anyone who signed the list we just released keeps their seat on the next
       * one. They have already proved they answer, which is the scarcest thing
       * in this contest -- on 2026-09-16 a release at 3 of 4 dropped both
       * counter-signatures and invited three strangers instead, and none of the
       * three ever replied.
       */
      const kept = (state.keepNext || []).filter((d) => !ignored(d) && d !== ME);
      /** The pool is o-first, so the scarce letter is taken before the seats run out. */
      const members = canonical([ME, ...kept,
        ...pool.filter((d) => !kept.includes(d)).slice(0, Math.max(0, needed - kept.length))]);
      if (kept.length) console.log(`  keeping ${kept.length} proven signer(s) on the new list`);
      state.keepNext = null;
      const rosterRequestId = `roster-${OUR_GAME}-${Math.floor(now / 1000)}`;
      const facts = await roomFacts(OUR_GAME);
      const gen = facts.generation ?? OUR_GENERATION;
      state.roomGeneration = gen;
      if (facts.generation === null) console.log('  warning: no setup receipt in our room; assuming generation 1');
      if (!members.some(hasO)) console.log('  warning: this roster spells no `o` — some lines will be unwritable');
      const ok = await post(DISCOVERY, {
        type: 'sonnet.roster.v1',
        contest_id: CONTEST,
        game_id: OUR_GAME,
        poem_room: `d-sonnet-2-team-${OUR_GAME}`,
        room_generation: gen,
        members,
        request_id: rosterRequestId
      }, `propose our own roster of ${members.length} `
        + `(${members.filter((m) => m !== ME && proven.has(m)).length} referee-proven, `
        + `${pool.filter(hasO).length} with an o)`);
      state.rosterAt = new Date().toISOString();
      /** Naming ourselves on a roster *is* our one live consent. */
      if (ok) {
        state.consent = OUR_GAME;
        state.consentAt = new Date().toISOString();
        state.consentRequestId = rosterRequestId;
        state.rosterMembers = members;
        state.consentMembers = members;
        /** Keep a short history so a late verdict can be attributed to a list. */
        state.rosterHistory = state.rosterHistory || {};
        state.rosterHistory[rosterRequestId] = members;
        const ids = Object.keys(state.rosterHistory);
        for (const old of ids.slice(0, Math.max(0, ids.length - 40))) delete state.rosterHistory[old];
        state.invitedAt = new Date().toISOString();
        /**
         * An accepted roster is not a team until every member signs it, and a
         * broadcast only reaches whoever happens to be polling discovery at that
         * second — in a room that turns over in under an hour. So tell each named
         * writer directly, exactly once per roster. The rules put partner
         * negotiation here: "invite partners, accept or decline".
         */
        /**
         * Advertise the finished draft alongside the roster, every cycle.
         *
         * A word cannot be posted before every member signs — the referee answers
         * `roster: incomplete consent` — so the poem cannot speak for itself from
         * inside the room. Putting the text in a recruit frame is the only way a
         * passing writer can see that joining us costs them one turn, not an
         * evening of drafting.
         */
        /**
         * Advertise whichever draft the clock has us on, rebuilt from its own
         * words. `poemText` went away when the second draft arrived and nothing
         * caught it: `node --check` cannot see a free variable, and the dry run
         * never reached this branch. It took the live pass down between
         * proposing a roster and inviting anyone to it.
         */
        const advert = (drafts.get(draftFor(state, members, 0)) || []).join(' ');
        /**
         * An advertisement is the least important thing in this block and it
         * took the whole pass down: a free variable here crashed between
         * proposing the roster and inviting a single member to it, so the
         * proposal sat there with nobody asked to sign. Nothing optional may
         * cost us the invitations again.
         */
        if (advert) try {
          await post(DISCOVERY, {
            type: 'sonnet.recruit.v1',
            contest_id: CONTEST,
            game_id: OUR_GAME,
            x_account_url: 'https://x.com/marcryptox',
            text: `${needed} seat(s) open. The draft is finished and validated against the pinned cmudict: 14 lines, 10 syllables each. Join and we take turns immediately, and every member contributes as the rules require.\n\n${advert}\n\nRoom d-sonnet-2-team-${OUR_GAME}, generation ${gen}. Post a sonnet.roster.v1 naming yourself and the current roster.`,
            request_id: `recruit-${OUR_GAME}-${Math.floor(now / 1000)}`
          }, 'advertise the finished draft');
        } catch (err) {
          console.log(`  advertisement failed (${String(err.message).slice(0, 60)}) — inviting anyway`);
        }
        for (const m of members) {
          if (m === ME) continue;
          await post(DISCOVERY, {
            type: 'sonnet.note.v1',
            contest_id: CONTEST,
            game_id: OUR_GAME,
            target_did: m,
            text: `You applied as an unattached writer, so we named you on roster ${OUR_GAME}, which the referee has accepted. Room d-sonnet-2-team-${OUR_GAME}, generation ${gen}. Post the same sonnet.roster.v1 to consent. We have a checked 14-line draft ready and will take turns immediately; the prize splits equally across contributors.`,
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
  /**
   * Applications are the cheap, slow half of this loop and they have produced
   * nothing: in twenty-four hours not one of 200+ applications led to a team
   * drafting us. Meanwhile each one is a signed POST, and a pass full of them
   * takes minutes — which is exactly the delay that let a part-signed roster of
   * ours sit un-nudged. So when a seat of ours is actually open, close that
   * first and leave the canvassing for a pass where nothing is at stake.
   */
  const closingOurOwn = state.consent === OUR_GAME;
  let applications = 0;
  for (const g of games) {
    if (closingOurOwn && applications >= 1) break;
    /**
     * Re-apply to a team we have already written to once its application has
     * gone stale.
     *
     * Overnight: 138 applications, 36 rosters of our own, and not one team ever
     * drafted us. Part of that is simply that an application is a message in a
     * room that forgets — a team which finishes recruiting six hours after we
     * wrote to it has no record we exist. `started` is permanent (its poem is
     * under way and membership is frozen); a plain timestamp is not.
     */
    const prior = state.applied[g];
    if (prior === 'started') continue;
    if (prior && prior !== 'failed') {
      const ageH = (Date.now() - Date.parse(prior)) / 3_600_000;
      if (Number.isFinite(ageH) && ageH < REAPPLY_AFTER_HOURS) continue;
    }
    if (applications >= 4) break;           // pace ourselves; this is not a flood
    const room = await peek(`d-sonnet-2-team-${g}`);
    /** Unreadable is not evidence either way, so leave the game for the next pass. */
    if (room === null) continue;
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

  }   /* end of the discovery-dependent section */

  /* ---- 3. take a turn if a poem we are in is live ------------------------- */
  if (state.consent) {
    const roomRows = await ex(`d-sonnet-2-team-${state.consent}`);
    if (roomRows === null) { console.log('  team room read failed — leaving the poem alone this pass'); saveState(state); return true; }
    const room = parsed(roomRows);

    /**
     * The opening move needs a hash we do not generate.
     *
     * A word frame carries `previous_state_hash`, and the first one -- version 0
     * -- must carry the hash of the empty poem, which arrives only on the
     * referee's `roster_ready` receipt. The old code keyed entirely off word
     * receipts, so with none yet there was no head and the agent could never
     * open a poem at all: it could only ever join one already in progress.
     */
    let initialHash = null;
    let generation = OUR_GENERATION;
    let last = null;              // newest accepted word receipt
    let rosterReady = false;
    let readyHash = null;
    const accepted = new Set();
    for (const { f } of room) {
      if (f.type !== 'sonnet.receipt.v1' || f.status !== 'accepted') continue;
      if (f.roster_ready === true) {
        rosterReady = true;
        /**
         * The opening `previous_state_hash` is this receipt's, specifically --
         * verified against galax2u, jinken, echo-2 and pelmora, each of which
         * carries exactly one `roster_ready` in its team room. Taking merely the
         * last versionless receipt would pick a re-setup hash if one ever landed
         * afterwards, and the first word is not a move we get to retry.
         */
        if (f.state_hash) readyHash = f.state_hash;
      }
      if (f.room_generation !== undefined) generation = f.room_generation;
      if (f.version === undefined) {
        if (f.state_hash) initialHash = f.state_hash;
        continue;
      }
      accepted.add(f.request_id);
      if (!last || f.version > last.version) {
        last = { version: f.version, hash: f.state_hash, by: f.sender_did, complete: f.complete };
      }
    }
    const placedWords = room.filter(({ f }) => f.type === 'sonnet.word.v1' && accepted.has(f.request_id))
      .map(({ f }) => String(f.word || ''));
    const placed = placedWords.length;
    console.log(`  poem ${state.consent}: ${placed} accepted word(s)${last?.complete ? ' — COMPLETE' : ''}`);
    if (placed) console.log(`    so far: ${placedWords.join(' ')}`);

    /** Version 0 opens on the roster hash; every later turn chains off the last receipt. */
    const head = last
      ? { version: last.version, hash: last.hash, by: last.by }
      : ((readyHash || initialHash) ? { version: 0, hash: readyHash || initialHash, by: null } : null);

    /**
     * Writing to a team room needs the referee to have added our key to
     * `/kv/room-allow/<room>`, which happens when the roster is ready. Until
     * then every word is an HTTP 403 -- we posted five of them at 2 of 4 before
     * this gate existed, which is noise in a room other people read.
     */
    if (head && !rosterReady && placed === 0) {
      console.log('  roster is not ready; the room will refuse our writes until it is');
    } else if (head && last?.complete) {
      console.log('  poem is finished; nothing to add');
    } else if (head && head.by === ME) {
      console.log('  our word was last; a teammate must go next');
    } else if (head) {
      /**
       * The room is the poem, not our draft.
       *
       * `placed` is only a count, and the next word is taken from our draft at
       * that index -- which silently assumes every teammate writes the draft we
       * advertised. A teammate who writes anything else shifts the whole poem
       * one slot out of step with us, and we would go on posting our words into
       * a text that no longer has room for them, breaking the line structure
       * the published hash is built from. Nothing here can stop a teammate
       * choosing their own word, but we should not be the last to know.
       */
      /** Whoever's team this is, fit the poem to the people actually on it. */
      const teamMembers = state.consent === OUR_GAME
        ? (state.rosterMembers || state.consentMembers)
        : (state.consentMembers || state.rosterMembers);
      const fitted = wordsFor(draftFor(state, teamMembers, placed), teamMembers);
      const drifted = placedWords.findIndex((w, i) => w.toLowerCase() !== String(fitted[i] || '').toLowerCase());
      if (drifted >= 0) {
        console.log(`  DRIFT at word ${drifted + 1}: the room has "${placedWords[drifted]}", `
          + `our draft has "${fitted[drifted] || '(past the end)'}" — the poem is no longer our text`);
      }
      const next = fitted[placed];
      if (next && canSpell(next)) {
        await post(`d-sonnet-2-team-${state.consent}`, {
          type: 'sonnet.word.v1',
          contest_id: CONTEST,
          game_id: state.consent,
          room_generation: generation,
          version: head.version,
          previous_state_hash: head.hash,
          word: next,
          request_id: `w${head.version}-${Math.floor(Date.now() / 1000)}`
        }, `propose "${next}" at version ${head.version}`);
      } else if (next) {
        console.log(`  "${next}" needs letters our key lacks — a teammate must place it`);
      } else {
        console.log('  our draft is exhausted; the room is past our text');
      }
    } else {
      console.log('  no roster hash yet — the poem has not been opened');
    }
  }

  saveState(state);
  return true;
}

const state = loadState();
if (once) { await pass(state); process.exit(0); }
for (;;) {
  let alive = true;
  /**
   * A whole pass is bounded too, not just each read inside it. Per-request
   * timeouts still leave a pass that makes many of them able to run long, and
   * the loop only matters if it keeps coming round.
   */
  try {
    alive = await Promise.race([
      pass(state),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pass exceeded its budget')), PASS_BUDGET_MS))
    ]);
  } catch (err) { console.log(`[agent] pass failed: ${err.message}`); }
  if (!alive) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
