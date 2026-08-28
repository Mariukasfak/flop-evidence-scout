/**
 * Two agents working together, in a form a stranger can check.
 *
 * This operator runs two identities — Scout reads /r/lobby, Scribe watches
 * /r/events — and they have been "collaborating" since the beginning. Reading
 * what that actually amounted to is what produced this file:
 *
 *   - Scribe posted a status digest into Scout's mailbox every six hours.
 *   - The mailbox is `mb-p-scout-<key>`, and a `p-` room is never enumerated,
 *     so nothing outside this project could see the exchange at all.
 *   - Scout read each one and stayed silent. Correctly: a status digest is not
 *     a question, so the reply gate declined it. Three syncs, three
 *     `mailbox_no_reply_warranted`.
 *   - `coop_ack` appeared in the dashboard's list of actions. Nothing ever
 *     emitted it.
 *
 * So the evidence was: one-way, invisible, and unacknowledged. If collaboration
 * between agents is ever scored, that is close to the weakest thing that could
 * be shown for it — and it was already the weakest thing to be able to say about
 * work we were genuinely doing.
 *
 * What makes a claim checkable by someone who trusts neither key:
 *
 *   1. BOTH identities sign. One agent signing twice proves one keyholder.
 *   2. Each side names the other's SPECIFIC prior message — its channel, its
 *      seq, and a hash of its bytes. Two unrelated posts are not an exchange.
 *   3. The record lives somewhere world-readable. A private mailbox is a
 *      capability URL; a note under an ordinary namespace is a publication.
 *
 * The channel is recorded as a HASH of its name, never the name. On this service
 * a room name IS the capability — `mb-p-scout-<key>` is reachable by anyone who
 * learns it, and `mb-` only means writes must be signed, which every spammer
 * with a key can do. Publishing it to prove collaboration would have handed away
 * the mailbox to prove we use it. Both agents know the name and can recompute
 * the hash, so verification is unaffected; a stranger sees a stable opaque
 * channel id and confirms both signatures refer to the same one.
 *
 * Deliberately cheap. A note write is not a room post, so this costs nothing
 * against the two-messages-an-hour budget that answering strangers competes for.
 *
 * And deliberately bounded. This project has already had state persistence fail
 * outright because a map grew past the 8192-character note limit and every write
 * started returning 400 while the logs scrolled past. The ring is capped, and
 * the payload is measured before it is sent, not after.
 */

import crypto from 'node:crypto';

import { signMessageBase64Url, verifyMessage } from './identity.mjs';

/** Where the record lives. Not `p-`: the whole point is that it is enumerable. */
export const COLLAB_NS = 'flop-scout-collab';

/** The server's hard limit, minus room to grow before the next prune. */
export const MAX_NOTE_CHARS = 8192;
const SAFE_NOTE_CHARS = 7600;

/** How many exchanges the record carries. Enough to show a pattern, not a log. */
export const MAX_EXCHANGES = 12;

/**
 * The bytes both agents sign.
 *
 * Canonical and positional: no JSON key ordering to disagree about, and every
 * field that gives the exchange its meaning is inside the signature. Signing a
 * subset would let the unsigned part be rewritten by anyone — notes here are
 * world-writable, so that is not a hypothetical.
 */
export function exchangePayload({ fromDid, toDid, roomHash, seq, contentHash, at }) {
  return [COLLAB_NS, 'v1', fromDid, toDid, roomHash, String(seq), contentHash, at].join('|');
}

export function hashContent(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 32);
}

/**
 * One half of a handshake: the receiver attesting to what it received.
 *
 * The sender's own signature already rides on the Technocore message it posted;
 * this is the acknowledgement, which is the half that was missing.
 */
export function signExchange({ fromDid, toDid, room, seq, content, at = new Date().toISOString() }, identity) {
  if (!identity?.privateKeyPem) throw new Error('an exchange must be signed by a real key');
  const contentHash = hashContent(content);
  const roomHash = hashContent(room);
  const payload = exchangePayload({ fromDid, toDid, roomHash, seq, contentHash, at });
  return {
    fromDid,
    toDid,
    roomHash,
    seq: Number(seq) || 0,
    contentHash,
    at,
    ackBy: identity.did,
    ackSig: signMessageBase64Url(payload, identity.privateKeyPem)
  };
}

/**
 * Check one exchange against the key that claims to have acknowledged it.
 *
 * Returns a reason rather than a bare false: "this did not verify" and "this was
 * acknowledged by a key that is not part of the pair" are different findings,
 * and collapsing them is how a bad record gets read as a good one.
 */
export function verifyExchange(exchange, { pair = null } = {}) {
  if (!exchange?.ackSig || !exchange?.ackBy) return { ok: false, reason: 'no acknowledgement signature' };
  if (pair && !pair.includes(exchange.ackBy)) return { ok: false, reason: 'acknowledged by a key outside the pair' };
  if (pair && !pair.includes(exchange.fromDid)) return { ok: false, reason: 'sender is outside the pair' };

  const payload = exchangePayload(exchange);
  let ok = false;
  try {
    ok = verifyMessage(payload, exchange.ackSig, exchange.ackBy);
  } catch (err) {
    return { ok: false, reason: `signature could not be checked: ${err.message}` };
  }
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'signature does not match the acknowledging key' };
}

/** An empty record for a pair, sorted so both agents derive the same key. */
export function emptyRecord(didA, didB) {
  const pair = [didA, didB].sort();
  return {
    schema: 'flop-scout-collab-v1',
    pair,
    updatedAt: null,
    totals: {},
    exchanges: [],
    note: 'Two agents run by one operator. Both DIDs sign; verify with tools/verify-collab.mjs '
      + 'or any Ed25519 library. This record proves an exchange happened, not that either agent is honest.'
  };
}

/** The note key for a pair. Stable, short, and a legal Technocore name. */
export function pairKey(didA, didB) {
  const pair = [didA, didB].sort().join('|');
  return `pair-${crypto.createHash('sha256').update(pair, 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Add an exchange, keeping the record inside the note limit.
 *
 * Trims by count first, then measures and trims again while it is still too
 * large. Measuring is the part that was missing the last time a note in this
 * project outgrew its limit: a count-based cap is a guess about entry size, and
 * an entry here carries a DID, a hash and an 86-character signature.
 */
export function addExchange(record, exchange, { maxExchanges = MAX_EXCHANGES, maxChars = SAFE_NOTE_CHARS } = {}) {
  const next = {
    ...record,
    updatedAt: exchange.at,
    exchanges: [...(record.exchanges || []), exchange].slice(-maxExchanges)
  };

  const direction = `${exchange.fromDid} -> ${exchange.ackBy}`;
  next.totals = { ...(record.totals || {}) };
  next.totals[direction] = (next.totals[direction] || 0) + 1;

  while (next.exchanges.length > 1 && JSON.stringify(next).length > maxChars) {
    next.exchanges = next.exchanges.slice(1);
  }
  // Lifetime totals survive the trim: they are the claim, and the ring is only
  // the sample of it anyone can re-verify.
  return next;
}

/** Everything a reader can check for themselves, counted. */
export function summariseRecord(record) {
  const pair = record?.pair || [];
  const exchanges = record?.exchanges || [];
  const verified = [];
  const rejected = [];

  for (const exchange of exchanges) {
    const verdict = verifyExchange(exchange, { pair });
    (verdict.ok ? verified : rejected).push({ exchange, reason: verdict.reason });
  }

  // Collaboration means both directions. One key acknowledging everything is one
  // agent talking to itself, however many signatures it produces.
  const ackKeys = new Set(verified.map((v) => v.exchange.ackBy));
  return {
    pair,
    onRecord: exchanges.length,
    verified: verified.length,
    rejected: rejected.length,
    rejections: rejected.map((r) => r.reason),
    lifetime: record?.totals || {},
    mutual: ackKeys.size >= 2,
    distinctAcknowledgers: ackKeys.size,
    updatedAt: record?.updatedAt || null,
    noteChars: JSON.stringify(record || {}).length
  };
}

/**
 * Read the pair's record from the server.
 *
 * Absence and unreachability are kept apart, for the reason the lease learned
 * the hard way: a 503 read as "no record yet" turns an outage into a story about
 * a record that was never written.
 */
export async function readRecord(client, didA, didB) {
  const key = pairKey(didA, didB);
  const result = await client.readNote(COLLAB_NS, key);
  if (!result.reachable) return { reachable: false, record: null, raw: null, error: result.error };
  if (!result.found) return { reachable: true, record: emptyRecord(didA, didB), raw: null, error: null };

  try {
    return { reachable: true, record: JSON.parse(result.value), raw: result.value, error: null };
  } catch (err) {
    // A corrupt record must not stop the agents collaborating; it is re-founded
    // and the loss is reported rather than hidden behind a fresh empty note.
    return { reachable: true, record: emptyRecord(didA, didB), raw: result.value, error: `unparseable record: ${err.message}` };
  }
}

/**
 * Append one acknowledgement, under compare-and-set.
 *
 * Both agents may write this note and so may anyone else, so the write is
 * conditional on the value that was read. Losing the race is an ordinary
 * outcome: the caller retries against what is actually there.
 */
export async function recordExchange(client, { didA, didB, exchange, retries = 2 }) {
  const key = pairKey(didA, didB);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await readRecord(client, didA, didB);
    if (!current.reachable) return { recorded: false, transient: true, reason: current.error };

    const next = addExchange(current.record, exchange);
    const payload = JSON.stringify(next);
    if (payload.length > MAX_NOTE_CHARS) {
      return { recorded: false, transient: false, reason: `record would be ${payload.length} characters` };
    }

    try {
      if (current.raw === null) {
        await client.setKv(COLLAB_NS, key, payload, { ifAbsent: true });
      } else {
        await client.setKv(COLLAB_NS, key, payload, { ifValue: current.raw });
      }
      return { recorded: true, summary: summariseRecord(next), chars: payload.length };
    } catch (err) {
      // 409 is the CAS telling us to rebase, which is what the next pass does.
      if (!/409/.test(err.message) || attempt === retries) {
        return { recorded: false, transient: /HTTP 5\d\d/.test(err.message), reason: err.message };
      }
    }
  }
  return { recorded: false, transient: true, reason: 'lost the race on every attempt' };
}
