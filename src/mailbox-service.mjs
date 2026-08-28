import { getDidShardedPath, getStateKey, singleLineSweep, isValidTechnocoreName } from './identity.mjs';
import { formatKnowledgeResponse, shouldRespond } from './knowledge.mjs';
import { Guardrails } from './guardrails.mjs';

/**
 * Makes the agent addressable instead of merely audible.
 *
 * The DID note already advertises `mailbox: mb-p-scout-<key>`; until now nothing
 * read it. An `mb-` room accepts signed writes only, so every request is
 * attributable to a key, and a sender can be ignored by key.
 *
 * Everything arriving here was written by a stranger. It is data. This service
 * never follows an instruction found in a message, never resolves a URL a
 * message names, and never changes its own configuration from message content —
 * the only thing message text can do is select a fact from a fixed table.
 */

const SENDER_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_REPLIES_PER_TURN = 1;

/**
 * Pull `mailbox: <room>` out of a DID note without trusting anything else in it.
 * The label is matched case-insensitively, the room name is not: a case-blind
 * match would hand back `MB-P-Upper`, which the server rejects as a bad name.
 */
export function parseMailboxFromProfile(noteText) {
  if (typeof noteText !== 'string') return null;
  const match = noteText.match(/(?:^|\|)\s*mailbox:\s*(\S+)/i);
  if (!match) return null;
  const candidate = match[1].replace(/\|+$/, '');
  return isValidTechnocoreName(candidate) ? candidate : null;
}

export class MailboxService {
  constructor({
    identity,
    client,
    guardrails = new Guardrails({ maxPerHour: 4, minCooldownMs: 15_000 }),
    stateKey = null,
    publicFallbackRoom = 'technocore',
    mailboxPrefix = 'mb-p-scout'
  }) {
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Valid Ed25519 identity is required for MailboxService');
    }
    if (!client) throw new Error('Technocore client is required for MailboxService');

    this.identity = identity;
    this.client = client;
    this.guardrails = guardrails;
    this.publicFallbackRoom = publicFallbackRoom;
    this.mailbox = `${mailboxPrefix}-${getDidShardedPath(identity.did).key}`;
    this.stateKey = stateKey || getStateKey(identity.did, 'mbox');
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastMailboxSeq: 0,
      handled: 0,
      answeredSenders: {}
    };
    this.lastStateError = null;
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('mailbox', this.stateKey);
      if (remote && typeof remote === 'object') {
        this.localState = { ...this.localState, ...remote };
      }
    } catch (err) {
      this.lastStateError = err.message;
    }
    return this.localState;
  }

  async saveRemoteState() {
    try {
      this.localState.lastActive = new Date().toISOString();
      await this.client.setKv('mailbox', this.stateKey, this.localState);
      this.lastStateError = null;
      return true;
    } catch (err) {
      this.lastStateError = err.message;
      console.warn('[Mailbox] /kv/ state write failed:', err.message);
      return false;
    }
  }

  /**
   * Where to answer a given sender. Their own mailbox if their DID note names
   * one — that keeps the exchange between the two parties instead of adding to a
   * public room's traffic.
   */
  async resolveReplyRoom(senderDid) {
    if (typeof senderDid !== 'string' || !senderDid.startsWith('did:key:')) {
      return { room: this.publicFallbackRoom, direct: false, reason: 'sender did not sign' };
    }
    try {
      const { shard, key } = getDidShardedPath(senderDid);
      const note = await this.client.getKv(shard, key);
      const mailbox = parseMailboxFromProfile(typeof note === 'string' ? note : JSON.stringify(note ?? ''));
      if (mailbox) return { room: mailbox, direct: true, reason: 'mailbox from DID note' };
      return { room: this.publicFallbackRoom, direct: false, reason: 'DID note names no mailbox' };
    } catch (err) {
      return { room: this.publicFallbackRoom, direct: false, reason: `DID note unreadable: ${err.message}` };
    }
  }

  cooledDown(senderDid) {
    const last = this.localState.answeredSenders?.[senderDid];
    if (!last) return true;
    return Date.now() - new Date(last).getTime() > SENDER_COOLDOWN_MS;
  }

  async runTurn() {
    await this.loadRemoteState();
    this.localState.totalTurns += 1;
    this.localState.answeredSenders = this.localState.answeredSenders || {};

    let inbound = [];
    try {
      // JSON carries the full DID in `from`; the text view truncates it to
      // <z6Mk…uB6z>, which cannot be resolved back to a DID note.
      const data = await this.client.readRoom(this.mailbox, { limit: 20, format: 'json' });
      inbound = Array.isArray(data?.messages) ? data.messages : [];
    } catch (err) {
      await this.saveRemoteState();
      return {
        agent: 'mailbox',
        action: 'error',
        error: `Failed to read mailbox ${this.mailbox}: ${err.message}`,
        did: this.identity.did,
        turns: this.localState.totalTurns,
        handled: this.localState.handled,
        stateError: this.lastStateError
      };
    }

    const cursor = Number(this.localState.lastMailboxSeq || 0);
    const fresh = inbound.filter((m) => {
      const seq = Number(m.seq || m.id || 0);
      return seq > cursor && m.from !== this.identity.did;
    });

    const maxSeq = inbound.reduce((acc, m) => Math.max(acc, Number(m.seq || m.id || 0)), cursor);

    let action = 'mailbox_idle';
    const details = { mailbox: this.mailbox, inbound: fresh.length };
    const skipped = [];
    let replies = 0;
    /**
     * Genuine questions this turn, for the inference workload to draft answers to.
     *
     * Replies here come from a fixed lookup table, which is the one thing a
     * grounded model would do better — and `draft-answer` existed for exactly
     * that while never receiving a single input, because nothing collected the
     * questions. A draft is work and evidence, not a reply: nothing on this path
     * is posted, so a model's output still cannot reach a stranger.
     */
    const questions = [];

    for (const msg of fresh) {
      if (replies >= MAX_REPLIES_PER_TURN) {
        skipped.push({ from: msg.from, reason: 'per-turn reply cap' });
        continue;
      }

      const senderDid = typeof msg.from === 'string' ? msg.from : '';
      const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');

      if (!this.cooledDown(senderDid)) {
        skipped.push({ from: senderDid, reason: 'sender answered within the last hour' });
        continue;
      }

      // A direct message is addressed to us by construction, so the question
      // requirement is relaxed — but the topic and boilerplate checks are not.
      const verdict = shouldRespond(text, { selfDid: this.identity.did });
      if (!verdict.respond) {
        skipped.push({ from: senderDid, reason: verdict.reason });
        continue;
      }

      // Recorded before the guardrail, because a question we were rate-limited
      // out of answering is still a question worth drafting an answer to.
      questions.push({ text, topics: verdict.topics.map((t) => t.topic) });

      const target = await this.resolveReplyRoom(senderDid);
      const answer = formatKnowledgeResponse(text);
      const outgoing = singleLineSweep(`[FLOP Scout -> ${senderDid || 'sender'}]: ${answer}`);

      const check = this.guardrails.canSendMessage(outgoing, { isPriorityInquiry: true });
      if (!check.allowed) {
        skipped.push({ from: senderDid, reason: check.reason });
        continue;
      }

      try {
        await this.client.postMessage(target.room, outgoing, this.identity);
        this.guardrails.recordSent(outgoing);
        this.localState.answeredSenders[senderDid] = new Date().toISOString();
        this.localState.handled += 1;
        replies += 1;
        action = 'mailbox_answered';
        details.targetAgent = senderDid;
        details.room = target.room;
        details.direct = target.direct;
        details.routing = target.reason;
        details.inquiry = text;
        details.response = outgoing;
        details.reason = `Answered a mailbox request about ${verdict.topics.map((t) => t.topic).join(', ')}`;
      } catch (err) {
        action = `send_failed: ${err.message}`;
        skipped.push({ from: senderDid, reason: err.message });
      }
    }

    if (maxSeq > cursor) this.localState.lastMailboxSeq = maxSeq;
    if (skipped.length) details.skipped = skipped;
    if (action === 'mailbox_idle' && fresh.length > 0) action = 'mailbox_no_reply_warranted';

    await this.saveRemoteState();

    return {
      agent: 'mailbox',
      action,
      did: this.identity.did,
      room: this.mailbox,
      turns: this.localState.totalTurns,
      handled: this.localState.handled,
      lastMailboxSeq: this.localState.lastMailboxSeq,
      stateError: this.lastStateError,
      questions,
      details,
      timestamp: new Date().toISOString()
    };
  }
}
