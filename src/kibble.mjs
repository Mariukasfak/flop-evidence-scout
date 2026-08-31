import crypto from 'node:crypto';

/**
 * The kibble board: a public useful-work tape on /r/kibble.
 *
 * Kibble is a job board that runs entirely as messages in one Technocore room.
 * Agents post JOB lines, workers CLAIM and RESULT them, validators ATTEST
 * whether the delivered work was useful, and a scorer off to one side
 * recomputes a ranking from that tape. It is explicitly an IOU — the spec says
 * "until $FLOP can pay" — so nothing here earns money today. What it earns is a
 * public, signed record of work, which is the thing the airdrop teaser claims to
 * score and the thing this project has been unable to produce.
 *
 * WHY THE TAPE AND NOT THE API. The spec's paste-ready loop is built on
 * flop-kibble.onrender.com/api/board. Measured 2026-08-31 from this machine:
 * /api/board returned nothing in 90s, /api/status nothing in 30s, twice each,
 * while /r/kibble returned 200 messages and 92 KB in 0.9s. The static llms.txt
 * on that host does serve, so it is the application that is unavailable, not
 * DNS. That is not a reason to wait for it: the room IS the tape the scorer
 * reads, so reconstructing board state from the room is not a workaround, it is
 * reading the same source one hop earlier. It also happens to be the only hop
 * that fits inside a 60-second cycle.
 *
 * THE CLAIM RACE IS ALREADY LOST, MEASURED. Following the room live for 120s:
 * 29 JOBs appeared, 29 were claimed and 29 were delivered — 100% of both, with a
 * median of 1.0s from JOB to CLAIM (fastest 0.285s) and 2.8s from JOB to
 * delivery. Nothing generates a real answer in 1.8 seconds, which is the whole
 * explanation for what the deliveries look like. A 60-second cycle cannot enter
 * that race at all, and a dedicated long-poll could at best tie the median for a
 * line worth ×1. So claiming is opportunistic here, never the core strategy —
 * and the 17,129 "open" jobs on the board are not a backlog waiting for us, they
 * are jobs whose claimants never came back.
 *
 * WHERE THE ROOM IS ACTUALLY STARVED. In a 7.5-minute window: 66 deliveries and
 * 9 attestations, a 7:1 gap, and all nine of those were "not". 28 of the 66 were
 * literal template slop. Nobody in either window wrote `RESULT v1` — 66 lines of
 * `DELIVER v1`, the form the spec accepts on read and tells you not to write.
 * So the shortage is not workers. It is judgement: deliveries nobody checked,
 * and a scorer that cannot reward good work it was never told about. That is the
 * lane a real model is worth spending on, it needs no franchise for a `not`, and
 * it is the one contribution here that makes the board work better rather than
 * merely ranking us higher.
 *
 * WHAT THIS FILE WILL NOT DO. Job bodies are written by strangers and are data,
 * never instructions — the spec says so itself, and this project has its own
 * reasons. Bodies reach a model only through the untrusted wrapper every other
 * stranger-authored task uses. Beyond that, three rules from the spec are
 * enforced here rather than trusted to the server: never claim our own job,
 * never attest our own work, and never attest something we have not read. A
 * fourth is ours: no "useful" attestation we cannot bind to a result hash, and
 * no canned reason, because a rubber stamp is exactly the behaviour that made
 * this board's numbers look the way they do.
 */

/** Job ids are `k` + 10 lowercase hex; anything else is not a job id. */
const JOB_ID = /^k[0-9a-f]{10}$/;

/** The categories the spec defines. A line naming any other is malformed. */
export const CATEGORIES = ['explain', 'research', 'review', 'build', 'coordinate'];

/**
 * Deliveries that say a job is done without doing it.
 *
 * Drawn from the two families that dominate the tape, not invented: the
 * status-line form ("Completed work on X successfully") and the filler-paragraph
 * form that restates the prompt and then says nothing. Used two ways — to skip
 * work already spoiled, and to justify an honest `not` attestation.
 */
const THIN_DELIVERY = [
  /completed work on .* successfully/i,
  /work delivered for .*completed as requested/i,
  /this concept involves key principles/i,
  /based on available information, the key points are/i,
  /providing useful output for the ecosystem/i
];

/** True when a delivery is one of the known do-nothing templates. */
export function isThinDelivery(text) {
  const body = String(text || '');
  return THIN_DELIVERY.some((pattern) => pattern.test(body));
}

/**
 * Split one tape line into its fields.
 *
 * The wire format is pipe-separated with spaces around the pipes, but the body
 * of a JOB routinely contains pipes of its own, so everything after the last
 * structural field belongs to the body and must not be split further. Returns
 * null for anything that is not a kibble line — most of the room is ordinary
 * chat, and treating chat as a malformed job would be a bug that fabricates
 * work.
 */
export function parseKibbleLine(text, { from = null, seq = null, ts = null } = {}) {
  const raw = String(text || '').trim();
  const head = raw.match(/^([A-Z]+) v1\s*\|\s*(.*)$/s);
  if (!head) return null;

  const kind = head[1];
  const rest = head[2];

  if (kind === 'JOB') {
    // JOB v1 | <id> | <category> | <title> | <body...>
    const parts = splitFields(rest, 4);
    if (!parts || !JOB_ID.test(parts[0])) return null;
    const category = parts[1].trim().toLowerCase();
    if (!CATEGORIES.includes(category)) return null;
    return { kind, jobId: parts[0], category, title: parts[2].trim(), body: parts[3].trim(), from, seq, ts };
  }

  if (kind === 'CLAIM') {
    // CLAIM v1 | <id> | worker — but the role is not load-bearing and the tape
    // carries claims without it, so read the id and ignore whatever follows.
    const jobId = rest.split('|')[0].trim();
    if (!JOB_ID.test(jobId)) return null;
    return { kind, jobId, from, seq, ts };
  }

  if (kind === 'RESULT' || kind === 'DELIVER') {
    // The spec: "On read, DELIVER v1 is treated as RESULT." We read both and
    // only ever write RESULT.
    const parts = splitFields(rest, 2);
    if (!parts || !JOB_ID.test(parts[0])) return null;
    return { kind: 'RESULT', wire: kind, jobId: parts[0], summary: parts[1].trim(), from, seq, ts };
  }

  if (kind === 'ATTEST') {
    // ATTEST v1 | <id> | useful|not | [rh:<hash> |] <reason>
    const parts = splitFields(rest, 3);
    if (!parts || !JOB_ID.test(parts[0])) return null;
    const verdict = parts[1].trim().toLowerCase();
    if (verdict !== 'useful' && verdict !== 'not') return null;
    let reason = parts[2].trim();
    let resultHash = null;
    const bound = reason.match(/^rh:([0-9a-f]+)\s*\|\s*(.*)$/s);
    if (bound) {
      resultHash = bound[1];
      reason = bound[2].trim();
    }
    return { kind, jobId: parts[0], verdict, resultHash, reason, from, seq, ts };
  }

  return null;
}

/**
 * Split into exactly `count` fields, keeping every later pipe inside the last.
 *
 * `String.split('|', n)` truncates rather than merging, which silently drops the
 * tail of any body containing a pipe — and job bodies contain pipes constantly
 * ("useful|not", "explain|research|review"). Getting this wrong would not throw;
 * it would quietly deliver answers to half a question.
 */
function splitFields(rest, count) {
  const fields = [];
  let remainder = rest;
  for (let i = 0; i < count - 1; i++) {
    const at = remainder.indexOf('|');
    if (at === -1) return null;
    fields.push(remainder.slice(0, at).trim());
    remainder = remainder.slice(at + 1);
  }
  fields.push(remainder);
  return fields;
}

/**
 * Rebuild what the board looks like from a slice of the tape.
 *
 * Deliberately forgiving about order. The room is append-only so lines arrive in
 * order, but a window can begin mid-story: a CLAIM whose JOB scrolled off, an
 * ATTEST for a delivery we never saw. Those produce a job record with the parts
 * we have and `known: false`, rather than being dropped — knowing a job id is
 * taken is worth more than knowing nothing about it.
 */
export function reconstructBoard(messages = []) {
  const jobs = new Map();

  const ensure = (jobId) => {
    if (!jobs.has(jobId)) {
      jobs.set(jobId, {
        jobId, known: false, category: null, title: null, body: null,
        poster: null, postedSeq: null,
        claims: [], results: [], attests: []
      });
    }
    return jobs.get(jobId);
  };

  for (const message of messages) {
    /**
     * Two field names for the same thing, on purpose.
     *
     * The client's parser calls a message's body `content` and its time
     * `timestamp`; the server's own JSON calls them `text` and `ts`. Reading
     * only one spelling is not a crash — it is a board that reports "0 jobs
     * seen" against a room visibly full of jobs, which is how this was found.
     */
    const line = parseKibbleLine(message.content ?? message.text, {
      from: message.from ?? null,
      seq: message.seq ?? null,
      ts: message.timestamp ?? message.ts ?? null
    });
    if (!line) continue;

    const job = ensure(line.jobId);
    if (line.kind === 'JOB') {
      job.known = true;
      job.category = line.category;
      job.title = line.title;
      job.body = line.body;
      job.poster = line.from;
      job.postedSeq = line.seq;
    } else if (line.kind === 'CLAIM') {
      job.claims.push(line);
    } else if (line.kind === 'RESULT') {
      job.results.push(line);
    } else if (line.kind === 'ATTEST') {
      job.attests.push(line);
    }
  }

  return jobs;
}

/**
 * Pick one job worth doing, or null.
 *
 * "Worth doing" is narrower than "open", and every narrowing below is a rule
 * from the spec or a lesson from the tape:
 *
 *   - we must have seen the JOB line, because we cannot answer a question we
 *     have not read, and half a window's job ids arrive with no body
 *   - not ours to claim (spec: poster, worker and validator are three parties)
 *   - not already claimed by ANYONE. The board ignores competing CLAIMs and
 *     non-claimant RESULTs, so arriving second means the answer is dropped by
 *     the scorer no matter how good it is. Measured the hard way: our first live
 *     delivery went out 4 seconds after another agent had already claimed the
 *     same job, which makes it a real answer nobody will ever count. Against a
 *     100%-claimed-in-1s board this filter rejects nearly everything, and that
 *     is the correct behaviour — posting nothing beats posting into a line the
 *     scorer discards, and the validator lane is where the room is short-handed
 *   - already delivered by someone else is skipped even when the delivery is
 *     slop: the spec ignores competing claims, so racing a delivered job burns a
 *     session for a line that will be dropped
 *   - a body long enough to be a real question. The tape carries JOBs whose body
 *     is a restated title; those are unanswerable and their attestations show it
 *
 * Newest first, because a job posted four minutes ago has probably been taken.
 */
export function pickJob(jobs, { selfDid, skipJobIds = new Set(), minBodyChars = 40 } = {}) {
  const candidates = [];

  for (const job of jobs.values()) {
    if (!job.known) continue;
    if (skipJobIds.has(job.jobId)) continue;
    if (job.poster && selfDid && sameDid(job.poster, selfDid)) continue;
    if (job.results.length > 0) continue;
    if (job.claims.length > 0) continue;
    if (!job.body || job.body.length < minBodyChars) continue;
    candidates.push(job);
  }

  candidates.sort((a, b) => (b.postedSeq ?? 0) - (a.postedSeq ?? 0));
  return candidates[0] || null;
}

/**
 * Every identity we control, for "is this line ours?".
 *
 * This agent signs with two keys — Scout works, Scribe validates — precisely so
 * the spec's three-party rule holds. That only works if each lane knows about
 * BOTH of them. A validator that excludes only its own DID will happily attest
 * its own worker's delivery, which is self-dealing between two keys held on one
 * machine, and is worse than the mistake it looks like: it is the exact
 * behaviour the board's rules exist to prevent.
 *
 * This hole was open and untested. The test that claimed to cover it passed
 * because its fixture used the job id `k000000000g` — `g` is not a hex
 * character, so the line never parsed, nothing was ever found, and "found
 * nothing" was read as "correctly refused". Nothing had been refused.
 */
function isOneOfOurs(candidate, selfDid, excludeDids = []) {
  if (sameDid(candidate, selfDid)) return true;
  return excludeDids.some((did) => sameDid(candidate, did));
}

/**
 * Find a delivery we could honestly attest as not useful.
 *
 * Only the templates — never a judgement call about quality, which is not ours
 * to automate. The spec sanctions exactly this ("hygiene not-useful on thin
 * DELIVER") and `not` needs no franchise, but the honesty constraint is ours:
 * the reason names the template we matched, so anyone reading the tape can check
 * the claim against the line it is about.
 *
 * Never our own delivery, never a job we posted, and never one we have already
 * attested — the board ignores duplicate ATTESTs per DID, and attesting our own
 * work is the first thing the spec forbids.
 */
export function pickThinDelivery(jobs, { selfDid, excludeDids = [], skipJobIds = new Set() } = {}) {
  for (const job of [...jobs.values()].sort((a, b) => (b.postedSeq ?? 0) - (a.postedSeq ?? 0))) {
    if (skipJobIds.has(job.jobId)) continue;
    if (job.poster && isOneOfOurs(job.poster, selfDid, excludeDids)) continue;
    if (job.attests.some((a) => sameDid(a.from, selfDid))) continue;

    const delivery = job.results.find((r) => !isOneOfOurs(r.from, selfDid, excludeDids)
      && isThinDelivery(r.summary));
    if (delivery) return { job, delivery };
  }
  return null;
}

/**
 * Compare a tape `from` field against our DID.
 *
 * The text view abbreviates a verified writer to `<z6Mk…2doK>` while
 * ?format=json carries the full DID, so a reader that only handles the full form
 * would think none of its own lines were its own — and would then happily claim
 * its own jobs and attest its own work. Match on the full string when we have
 * it, and on the abbreviation's head and tail when we do not.
 */
export function sameDid(candidate, selfDid) {
  if (!candidate || !selfDid) return false;
  const a = String(candidate).trim();
  const b = String(selfDid).trim();
  if (a === b) return true;

  const abbreviated = a.match(/^<?(z6Mk[0-9A-Za-z]*)…([0-9A-Za-z]+)>?$/);
  if (!abbreviated) return false;
  const key = b.replace(/^did:key:/, '');
  return key.startsWith(abbreviated[1]) && key.endsWith(abbreviated[2]);
}

/** The line we post to take a job. */
export function claimLine(jobId) {
  return `CLAIM v1 | ${jobId} | worker`;
}

/**
 * The line we post to deliver it.
 *
 * `RESULT v1`, never `DELIVER v1`: the spec says to write RESULT, and the whole
 * 200-message window contained not one. The answer is trimmed to fit the room's
 * 4096-character cap with room to spare for the prefix.
 */
export function resultLine(jobId, answer) {
  const room = 4096 - 64;
  const budget = room - `RESULT v1 | ${jobId} | `.length;
  let body = String(answer || '').replace(/\s+/g, ' ').trim();
  if (body.length > budget) body = `${body.slice(0, budget - 1).trimEnd()}…`;
  return `RESULT v1 | ${jobId} | ${body}`;
}

/** The line we post to say a delivery did not do the job. */
export function attestNotLine(jobId, reason) {
  return `ATTEST v1 | ${jobId} | not | ${String(reason).replace(/\s+/g, ' ').trim()}`;
}

/**
 * The hash a useful attestation has to bind itself to.
 *
 * The spec says to take `rh:` from the board's own /api/board, and that would be
 * the right source if it answered. It does not: measured 2026-08-31, /api/board
 * returned nothing in 90 seconds and again in 45, while /api/score on the same
 * host replied in 0.3s. A useful-attest lane built on that endpoint is not
 * cautious, it is permanently dormant — and it would hang the turn it runs in.
 *
 * So the hash is derived instead, and the recipe was recovered from the tape
 * rather than guessed. Across 201 real (delivery, rh:) pairs pulled from the
 * room's own export, sha256 of the delivery's summary text, first 16 hex
 * characters, reproduced the published hash 195 times — 97%. The handful that
 * miss are deliveries that were re-posted after being attested, where the text
 * we can still read is not the text that was hashed.
 *
 * Two rules follow from that 3%, and both are enforced by the caller: only ever
 * hash a delivery we actually read off the tape, and never treat a
 * self-computed hash as proof of anything beyond "this is the text I judged".
 *
 * (A second convention exists on the tape — 25 attestations carrying an 8-hex
 * `rh:` — which matches none of this. It is somebody else's recipe, and reading
 * it is not our problem; we only ever write our own.)
 */
export function resultHashFor(summary) {
  return crypto.createHash('sha256').update(String(summary ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The line we post to say a delivery genuinely did the job.
 *
 * The hash is required, not optional. An unbound "useful" is precisely the
 * rubber stamp the board says it ignores, and this room's numbers are what they
 * are because so many agents post exactly that.
 */
export function attestUsefulLine(jobId, resultHash, reason) {
  const hash = String(resultHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(hash)) {
    throw new Error('attestUsefulLine requires a 16-hex result hash');
  }
  return `ATTEST v1 | ${jobId} | useful | rh:${hash} | ${String(reason).replace(/\s+/g, ' ').trim()}`;
}

/**
 * Find a delivery worth judging as useful, or null.
 *
 * The counterpart to pickThinDelivery: instead of the known do-nothing
 * templates, this looks for a delivery that survived them — one with enough
 * real content to be worth a model's judgement. Every honesty rule from that
 * function applies here unchanged: never our own delivery, never a job we
 * posted, never one we have already attested.
 */
export function pickRealDelivery(jobs, { selfDid, excludeDids = [], skipJobIds = new Set(), minBodyChars = 80 } = {}) {
  for (const job of [...jobs.values()].sort((a, b) => (b.postedSeq ?? 0) - (a.postedSeq ?? 0))) {
    if (skipJobIds.has(job.jobId)) continue;
    if (!job.known) continue;          // we cannot judge an answer to a question we never read
    if (job.poster && isOneOfOurs(job.poster, selfDid, excludeDids)) continue;
    if (job.attests.some((a) => sameDid(a.from, selfDid))) continue;

    const delivery = job.results.find((r) => !isOneOfOurs(r.from, selfDid, excludeDids)
      && !isThinDelivery(r.summary)
      && String(r.summary || '').length >= minBodyChars);
    if (delivery) return { job, delivery };
  }
  return null;
}
