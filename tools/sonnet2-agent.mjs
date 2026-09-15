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
const CONSENT_TIMEOUT_MIN = Number(process.env.SONNET_CONSENT_TIMEOUT_MIN || 6);
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
  for (const { f } of parsed(await ex(`d-sonnet-2-team-${game}`))) {
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
const PARTIAL_HOLD_MIN = 6;
/**
 * Give our own roster a moment before trading it for an invitation. Our
 * co-signers answer in ten to twenty-five seconds, and standing down twenty-
 * seven seconds after posting cost us a roster before anyone could reach it.
 */
const STANDDOWN_AFTER_MIN = 4;
/** How long we remember that a named agent never answered. */
const UNRESPONSIVE_HOURS = 0.5;
/** How long an agent that signed one of our rosters stays our first choice. */
const LOYAL_HOURS = 6;
/** ...but a past signature only outranks freshness while the agent is still signing. */
const LOYAL_ACTIVE_MIN = 30;
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
const poemText = fs.existsSync(POEM_PATH) ? fs.readFileSync(POEM_PATH, 'utf8').trim() : '';
const targetWords = poemText ? poemText.split(/\s+/).filter(Boolean) : [];

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
  const consentSince = state.consentAt ? Date.parse(state.consentAt) : 0;
  for (const { row, f } of disc) {
    if (!String(f.type || '').startsWith('sonnet.receipt')) continue;
    if (f.sender_did !== ME && f.participant_did !== ME) continue;
    if (Date.parse(row.ts) < consentSince) continue;
    const aboutOurConsent = state.consentRequestId && f.request_id === state.consentRequestId;
    if (f.status === 'rejected' && state.consent && !aboutOurConsent) {
      console.log(`  ignoring a rejection for ${String(f.request_id || '?').slice(0, 32)} — not the request we hold consent under`);
      continue;
    }
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

  /**
   * Rosters other people have offered us, newest first.
   *
   * Computed before the consent checks because it decides one of them: a DID
   * holds exactly one consent, so every minute we sit on our own unsigned
   * roster is a minute we would refuse anyone who invited us.
   */
  const rosterCutoff = Date.now() - 20 * 60_000;
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
    const k = `${f.game_id}:${f.members.join(',')}`;
    if (!offerSigners.has(k)) offerSigners.set(k, new Set());
    offerSigners.get(k).add(row.from);
  }
  const offers = disc.filter(({ row, f }) => f.type === 'sonnet.roster.v1'
    && Array.isArray(f.members) && f.members.includes(ME)
    && row.from !== ME
    && f.game_id !== OUR_GAME
    && Date.parse(row.ts) >= rosterCutoff)
    .filter(({ f }) => {
      const signed = offerSigners.get(`${f.game_id}:${f.members.join(',')}`)?.size ?? 0;
      return signed >= Math.ceil(f.members.length / 2);
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
      const at = state.posted[`${f.game_id}:${f.members.join(',')}`];
      if (!at) return true;
      const ageMin = (Date.now() - Date.parse(at)) / 60_000;
      /** Legacy entries stored `true` and carry no time; treat them as already stale. */
      return Number.isFinite(ageMin) ? ageMin >= OFFER_RETRY_MIN : true;
    })
    .reverse();

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
    /**
     * Our own roster that nobody has counter-signed is worth less than any
     * roster a stranger has actually offered us: theirs already has members on
     * it, ours has one. So stand down for a real invitation rather than making
     * whoever invited us wait out our twelve-minute timer — and never do this
     * once a teammate has signed ours, or we strand them.
     */
    const ourSigners = new Set();
    if (state.consent === OUR_GAME && Array.isArray(state.rosterMembers)) {
      const want = state.rosterMembers.join(',');
      for (const { row, f } of disc) {
        if (f.type !== 'sonnet.roster.v1' || f.game_id !== OUR_GAME) continue;
        if (!Array.isArray(f.members) || f.members.join(',') !== want) continue;
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
          /** Someone who signed *our* list is the best evidence we have about them. */
          state.loyal = state.loyal || {};
          state.loyal[row.from] = new Date().toISOString();
        }
      }
    }
    const cosignedByOthers = ourSigners.size > 0;

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
      const missing = state.rosterMembers.filter((m) => m !== ME && !ourSigners.has(m));
      const sinceInvite = state.invitedAt ? (Date.now() - Date.parse(state.invitedAt)) / 60_000 : Infinity;
      console.log(`  holding ${OUR_GAME}: ${ourSigners.size + 1}/${state.rosterMembers.length} signed, ${missing.length} seat(s) open (${heldMin.toFixed(0)}/${PARTIAL_HOLD_MIN} min)`);

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
      } else if (heldMin >= PARTIAL_HOLD_MIN) {
        state.unresponsive = state.unresponsive || {};
        for (const m of missing) state.unresponsive[m] = new Date().toISOString();
        const ok = await post(DISCOVERY, {
          type: 'sonnet.withdraw.v1',
          contest_id: CONTEST,
          game_id: OUR_GAME,
          request_id: `rebuild-${OUR_GAME}-${Math.floor(Date.now() / 1000)}`
        }, `release ${OUR_GAME} — ${missing.length} seat(s) never answered in ${PARTIAL_HOLD_MIN} min`);
        if (ok) { state.consent = null; state.consentAt = null; state.rosterAt = null; }
      } else
      if (sinceInvite >= REINVITE_MIN && missing.length) {
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
  const ownRosterCoolingDown = state.rosterAt
    && (Date.now() - Date.parse(state.rosterAt)) / 60_000 < ROSTER_RETRY_MIN;
  if (!state.consent && offers.length && ownRosterCoolingDown) {
    /**
     * `offers` is already filtered to somebody else's game, inside the twenty
     * minute window, and not a list we have signed before. Newest first: an old
     * roster still in the window has most likely been resolved or abandoned.
     */
    for (const { f } of offers) {
      const key = `${f.game_id}:${f.members.join(',')}`;
      const requestId = `consent-${f.game_id}-${Math.floor(Date.now() / 1000)}`;
      const ok = await post(DISCOVERY, {
        type: 'sonnet.roster.v1',
        contest_id: CONTEST,
        game_id: f.game_id,
        poem_room: f.poem_room,
        room_generation: f.room_generation,
        members: f.members,
        request_id: requestId
      }, `co-sign roster for ${f.game_id} (${offers.length} offer(s) pending)`);
      state.posted[key] = new Date().toISOString();
      if (ok) {
        state.consent = f.game_id;
        state.consentAt = new Date().toISOString();
        state.consentRequestId = requestId;
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
    const ignored = (did) => {
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
    const pool = [...new Set(loyal.concat([...cosigners.keys()].filter(responsive), fresh))]
      .filter((d) => !ignored(d))
      /**
       * Loyalty only counts while the agent is still awake. `q3VUSttk` signed
       * for us at 07:08 and so sat at the top of this list for hours -- and was
       * still being invited at 11:12 having last signed anything 142 minutes
       * earlier, while the only two agents co-signing in the last ten minutes
       * were not on our roster at all.
       */
      .sort((a, b) => ((loyal.includes(b) && lastSeen(b) <= LOYAL_ACTIVE_MIN)
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
      /** The pool is o-first, so the scarce letter is taken before the seats run out. */
      const members = [ME, ...pool.slice(0, needed)];
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
      }, `propose our own roster of ${members.length} (${pool.filter(hasO).length} with an o)`);
      state.rosterAt = new Date().toISOString();
      /** Naming ourselves on a roster *is* our one live consent. */
      if (ok) {
        state.consent = OUR_GAME;
        state.consentAt = new Date().toISOString();
        state.consentRequestId = rosterRequestId;
        state.rosterMembers = members;
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
        if (poemText) {
          await post(DISCOVERY, {
            type: 'sonnet.recruit.v1',
            contest_id: CONTEST,
            game_id: OUR_GAME,
            x_account_url: 'https://x.com/marcryptox',
            text: `${needed} seat(s) open. The draft is finished and validated against the pinned cmudict: 14 lines, 10 syllables each. Join and we take turns immediately, and every member contributes as the rules require.\n\n${poemText}\n\nRoom d-sonnet-2-team-${OUR_GAME}, generation ${gen}. Post a sonnet.roster.v1 naming yourself and the current roster.`,
            request_id: `recruit-${OUR_GAME}-${Math.floor(now / 1000)}`
          }, 'advertise the finished draft');
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
    const room = parsed(await ex(`d-sonnet-2-team-${state.consent}`));

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
    const accepted = new Set();
    for (const { f } of room) {
      if (f.type !== 'sonnet.receipt.v1' || f.status !== 'accepted') continue;
      if (f.roster_ready === true) rosterReady = true;
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
    const placed = room.filter(({ f }) => f.type === 'sonnet.word.v1' && accepted.has(f.request_id)).length;
    console.log(`  poem ${state.consent}: ${placed} accepted word(s)${last?.complete ? ' — COMPLETE' : ''}`);

    /** Version 0 opens on the roster hash; every later turn chains off the last receipt. */
    const head = last
      ? { version: last.version, hash: last.hash, by: last.by }
      : (initialHash ? { version: 0, hash: initialHash, by: null } : null);

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
      const next = targetWords[placed];
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
  try { alive = await pass(state); } catch (err) { console.log(`[agent] pass failed: ${err.message}`); }
  if (!alive) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
