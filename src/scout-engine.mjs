import { formatKnowledgeResponse, shouldRespond } from './knowledge.mjs';
import { messageSkeleton } from './learning-engine.mjs';
import { Guardrails } from './guardrails.mjs';
import { getDidShardedPath, getStateKey } from './identity.mjs';

/**
 * Topical rooms carry real conversation; /r/lobby is a firehose that has run
 * between 405 and 1,350 messages a minute.
 *
 * This list is measured, not guessed. Sampling 40 messages from each candidate
 * on 2026-08-26 and scoring them by on-topic share against boilerplate share:
 *
 *   gpu-miners         0.500    0% boilerplate   95% on-topic
 *   inference-agents   0.487    0%               95%
 *   validators         0.475    0%               95%
 *   flop-network       0.450    0%               90%
 *   technocore         0.276   40%               —
 *   technocore-genesis 0.162    8%               35%
 *   meta               0.064   15%               15%
 *
 * `meta` was in this list and earned its removal: reading it cost budget every
 * cycle and returned nothing. `gpu-miners` and `validators` replace it, and they
 * are also where testnet participants would talk — which is where the airdrop
 * criteria now point. Re-check with `npm run learn`.
 */
export const DEFAULT_WATCH_ROOMS = Object.freeze([
  'technocore',
  'inference-agents',
  'flop-network',
  'gpu-miners',
  'validators'
]);

const CHECKIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const SAME_AUTHOR_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export class ScoutEngine {
  constructor({
    identity,
    client,
    guardrails = new Guardrails(),
    stateKey = null,
    scribeIdentity = null,
    watchRooms = DEFAULT_WATCH_ROOMS,
    repoUrl = 'github.com/Mariukasfak/flop-evidence-scout',
    fieldGuideUrl = 'https://github.com/Mariukasfak/flop-evidence-scout/blob/main/docs/field-guide.md',
    feedRoom = 'd-scout-telemetry'
  }) {
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Valid Ed25519 identity is required for ScoutEngine');
    }
    if (!client) {
      throw new Error('Technocore client is required for ScoutEngine');
    }

    this.identity = identity;
    this.scribeIdentity = scribeIdentity;
    this.client = client;
    this.guardrails = guardrails;
    this.repoUrl = repoUrl;
    this.fieldGuideUrl = fieldGuideUrl;
    this.feedRoom = feedRoom;
    this.watchRooms = [...watchRooms];

    /**
     * Templates already answered, so a campaign is answered once.
     *
     * Replaying the reply gate over 23,667 archived messages passed 321 — of
     * which only 181 were distinct templates. One generated sentence appeared 78
     * times. Without this, nearly 44% of everything the agent wanted to say was
     * the same reply to the same sentence, and only the hourly budget hid it.
     *
     * Bounded, because this process is meant to run for months. Entries are
     * added when a reply is actually sent, never when one is merely considered —
     * a message the budget deferred must stay answerable later.
     */
    this.answeredSkeletons = new Set();
    this.maxAnsweredSkeletons = 2000;
    // Must satisfy /^[a-z0-9][a-z0-9_-]{0,47}$/ — a raw did:key never does.
    this.stateKey = stateKey || getStateKey(identity.did, 'scout');
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastSeenSeq: 0,
      roomCursors: {},
      answeredAuthors: {},
      lastCheckin: null,
      handledCount: 0,
      profilePublished: false
    };
    this.lastStateError = null;
  }

  get mailbox() {
    return `mb-p-scout-${getDidShardedPath(this.identity.did).key}`;
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('scout', this.stateKey);
      if (remote && typeof remote === 'object') {
        this.localState = { ...this.localState, ...remote };
      }
    } catch (err) {
      this.lastStateError = err.message;
    }
    return this.localState;
  }

  /**
   * Keep the state note under the 8192-character limit.
   *
   * answeredAuthors grew without bound — one full did:key plus a timestamp per
   * author answered, forever. It reached 199 entries and 7,762 of the note's
   * 8,159 characters, and then every write failed with
   * `400 text too long: 8198 characters`. State stopped persisting entirely, and
   * the turn counter began going backwards in the log: 317, 318, 317, 320, 320.
   *
   * The entries were dead weight long before that. They exist only to enforce a
   * six-hour per-author cooldown, so anything older than the cooldown can never
   * be consulted again. At two replies an hour the live set cannot exceed about
   * a dozen; the other 187 were pure ballast.
   *
   * Pruning by age is the real fix. The count cap and the byte check below are
   * backstops, because a state write that fails is invisible until someone reads
   * the log carefully — which is exactly how this survived.
   */
  pruneState({ maxAuthors = 120, maxBytes = 7800 } = {}) {
    const authors = this.localState.answeredAuthors || {};
    const cutoff = Date.now() - SAME_AUTHOR_COOLDOWN_MS;

    let entries = Object.entries(authors)
      .filter(([, at]) => {
        const t = new Date(at).getTime();
        return Number.isFinite(t) && t >= cutoff;
      })
      .sort((a, b) => new Date(b[1]) - new Date(a[1]));

    if (entries.length > maxAuthors) entries = entries.slice(0, maxAuthors);
    this.localState.answeredAuthors = Object.fromEntries(entries);

    // Measure rather than trust the arithmetic: drop the oldest until it fits.
    while (entries.length > 0 && JSON.stringify(this.localState).length > maxBytes) {
      entries = entries.slice(0, Math.max(0, entries.length - Math.ceil(entries.length / 4)));
      this.localState.answeredAuthors = Object.fromEntries(entries);
    }

    return { kept: entries.length, dropped: Object.keys(authors).length - entries.length };
  }

  async saveRemoteState() {
    try {
      this.localState.lastActive = new Date().toISOString();
      this.pruneState();
      await this.client.setKv('scout', this.stateKey, this.localState);
      this.lastStateError = null;
      return true;
    } catch (err) {
      // Surfaced in the turn result and the audit log — never swallowed.
      this.lastStateError = err.message;
      console.warn('[Scout] /kv/ state write failed:', err.message);
      return false;
    }
  }

  /** Reads one room and returns the messages this agent has not seen yet. */
  async collectNewMessages(room) {
    const cursor = Number(this.localState.roomCursors?.[room] || 0);
    /**
     * JSON, because the text view does not carry an identity.
     *
     * The text lane renders a verified writer as `<z6Mk…KiGa>` — and every
     * Ed25519 did:key begins `z6Mk`, so the whole discriminating content is four
     * base58 characters: 23.4 bits. Reading that as the author broke three
     * things at once.
     *
     * The self-filter below compared it against our full did:key and therefore
     * never matched, so our own posts came back as candidates to answer. The
     * per-author cooldown was keyed on a marker that thousands of identities
     * share at the measured population of 533,468 — upstream counted 1,452
     * colliding pairs at 180,794 keys, including two substantial writers that
     * rendered identically in /r/lobby for five and a half hours. And the reply
     * itself addressed that ambiguous marker in public.
     *
     * ?format=json carries the full DID in `from`. The mailbox already read it
     * this way; the room reader did not.
     */
    const data = await this.client.readRoom(room, {
      since: cursor > 0 ? cursor : null,
      limit: 20,
      format: 'json'
    });

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const fresh = messages.filter((m) => {
      const seq = Number(m.seq || m.id || 0);
      return seq > cursor && m.from !== this.identity.did;
    });

    const maxSeq = messages.reduce((acc, m) => Math.max(acc, Number(m.seq || m.id || 0)), cursor);
    return { fresh, maxSeq };
  }

  answeredRecently(author) {
    const last = this.localState.answeredAuthors?.[author];
    if (!last) return false;
    return Date.now() - new Date(last).getTime() < SAME_AUTHOR_COOLDOWN_MS;
  }

  async runTurn({ room = 'lobby' } = {}) {
    await this.loadRemoteState();
    this.localState.totalTurns += 1;
    this.localState.roomCursors = this.localState.roomCursors || {};
    this.localState.answeredAuthors = this.localState.answeredAuthors || {};

    if (!this.localState.profilePublished) {
      try {
        await this.client.publishDidProfile(this.identity, {
          mailbox: this.mailbox,
          type: 'autonomous_evidence_scout',
          agent: 'FLOP Evidence Scout',
          feed: this.feedRoom
        });
        this.localState.profilePublished = true;
      } catch (err) {
        console.warn('[Scout] DID profile publish failed:', err.message);
      }
    }

    // Topical rooms first: a question there is real, in lobby it is usually noise.
    const rooms = [...new Set([...this.watchRooms, room])];
    const roomErrors = {};
    let candidate = null;
    let scanned = 0;
    let primaryReadFailed = false;

    for (const target of rooms) {
      let result;
      try {
        result = await this.collectNewMessages(target);
      } catch (err) {
        roomErrors[target] = err.message;
        if (target === room) primaryReadFailed = true;
        continue;
      }

      this.localState.roomCursors[target] = result.maxSeq;
      if (target === room) this.localState.lastSeenSeq = result.maxSeq;
      scanned += result.fresh.length;

      if (candidate) continue;

      for (const msg of result.fresh) {
        const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
        const author = msg.from || 'unknown';
        if (this.answeredRecently(author)) continue;

        const verdict = shouldRespond(text, { selfDid: this.identity.did, seenSkeletons: this.answeredSkeletons });
        if (verdict.respond) {
          candidate = { room: target, author, text, topics: verdict.topics, reason: verdict.reason };
          break;
        }
      }
    }

    if (!candidate && primaryReadFailed && Object.keys(roomErrors).length === rooms.length) {
      await this.saveRemoteState();
      return {
        action: 'error',
        error: `Failed to read room ${room}: ${roomErrors[room]}`,
        did: this.identity.did,
        turns: this.localState.totalTurns,
        lastSeenSeq: this.localState.lastSeenSeq,
        stateError: this.lastStateError
      };
    }

    let actionTaken = 'monitoring_rooms';
    let outgoingMessage = null;
    let targetRoom = room;
    let detailPayload = {
      reason: `Read ${rooms.join(', ')} — ${scanned} new messages, none worth answering`
    };

    if (candidate) {
      const answer = formatKnowledgeResponse(candidate.text);
      outgoingMessage = `[FLOP Scout -> ${candidate.author}]: ${answer}`;
      actionTaken = 'answered_inquiry';
      targetRoom = candidate.room;
      // handledCount and answeredAuthors are recorded after the post succeeds,
      // not here. Marking them at this point counted an intention as an action:
      // a candidate is found on most cycles but only two replies an hour get
      // past the guardrail, so authors were being suppressed for six hours over
      // replies that were never sent — and the map grew by roughly one entry a
      // minute instead of two an hour, which is what pushed the state note past
      // the 8192-character limit and stopped state persisting altogether.
      detailPayload = {
        targetAgent: candidate.author,
        room: candidate.room,
        inquiry: candidate.text,
        reason: `Question about ${candidate.topics.map((t) => t.topic).join(', ')} (${candidate.reason})`,
        response: answer
      };
    } else if (
      !this.localState.lastCheckin ||
      Date.now() - new Date(this.localState.lastCheckin).getTime() > CHECKIN_INTERVAL_MS
    ) {
      const cursorSummary = rooms
        .map((r) => `${r}#${this.localState.roomCursors[r] || 0}`)
        .join(' ');
      // A check-in that carries something usable beats one that announces itself.
      outgoingMessage =
        `[FLOP Evidence Scout] turn ${this.localState.totalTurns}, ${this.localState.handledCount} questions answered ` +
        `| watching ${cursorSummary} | Field guide with measured limits, throughput and the five silent failure modes ` +
        `(name charset, note-read framing, /r/events format, swept-text signing, per-room nonces): ${this.fieldGuideUrl} ` +
        `| measured readings, protocol changes and scam advisories: /r/${this.feedRoom} ` +
        `| source: ${this.repoUrl} | ask me anything about the wire protocol.`;
      actionTaken = 'signed_checkin';
      targetRoom = this.watchRooms[0] || room;
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        room: targetRoom,
        reason: 'Periodic Ed25519-signed status message (every 2 hours)',
        response: outgoingMessage
      };
    }

    if (outgoingMessage) {
      outgoingMessage = outgoingMessage.replace(/[\r\n\t]+/g, ' ').trim();
      const isPriority = actionTaken === 'answered_inquiry';
      const check = this.guardrails.canSendMessage(outgoingMessage, { isPriorityInquiry: isPriority });
      if (check.allowed) {
        try {
          await this.client.postMessage(targetRoom, outgoingMessage, this.identity);
          this.guardrails.recordSent(outgoingMessage);

          // Everything below records a reply that actually happened. Recording
          // any of it earlier turns an intention into a fact.
          if (actionTaken === 'answered_inquiry' && candidate?.author) {
            this.localState.handledCount += 1;
            this.localState.answeredAuthors[candidate.author] = new Date().toISOString();
          }

          // Marking a skeleton earlier would let a message the hourly budget
          // merely deferred block its whole template for good.
          if (candidate?.text) {
            const skeleton = messageSkeleton(candidate.text);
            if (skeleton) {
              this.answeredSkeletons.add(skeleton);
              if (this.answeredSkeletons.size > this.maxAnsweredSkeletons) {
                // Drop the oldest; at worst a long-dormant template is answered twice.
                this.answeredSkeletons.delete(this.answeredSkeletons.values().next().value);
              }
            }
          }
        } catch (err) {
          actionTaken = `send_failed: ${err.message}`;
          console.warn('[Scout] Failed to post message:', err.message);
        }
      } else {
        actionTaken = `monitoring_pacing: ${check.reason}`;
        detailPayload.pacingReason = check.reason;
      }
    }

    // Presence convention — /kv/<room>/hb-<shortId>. 3704 agents follow it in lobby.
    for (const target of rooms) {
      if (roomErrors[target]) continue;
      try {
        await this.client.recordPresence(target, this.identity.did, this.localState.roomCursors[target] || 0);
      } catch (err) {
        roomErrors[`presence:${target}`] = err.message;
      }
    }

    if (Object.keys(roomErrors).length > 0) detailPayload.roomErrors = roomErrors;

    await this.saveRemoteState();

    return {
      action: actionTaken,
      did: this.identity.did,
      room: targetRoom,
      turns: this.localState.totalTurns,
      handledCount: this.localState.handledCount,
      lastSeenSeq: this.localState.lastSeenSeq,
      scanned,
      stateError: this.lastStateError,
      details: detailPayload
    };
  }
}
