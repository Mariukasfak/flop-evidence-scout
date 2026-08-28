import { getDidShardedPath, getStateKey, singleLineSweep } from './identity.mjs';
import { Guardrails } from './guardrails.mjs';
import { signExchange, recordExchange } from './collaboration.mjs';

/** What a testnet faucet room would plausibly be called when it appears. */
export const FAUCET_PATTERNS = [/faucet/i, /testnet/i, /\bdrip\b/i, /\btap\b/i];

export function looksLikeFaucet(value) {
  const text = String(value || '');
  return FAUCET_PATTERNS.some((re) => re.test(text));
}

/**
 * Signed peer sync between this operator's own two agents. Kept deliberately
 * rare: two bots acknowledging each other every few minutes is self-dealing,
 * which is exactly the pattern sybil clustering looks for.
 */
const COOP_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class ScribeEngine {
  constructor({
    identity,
    client,
    scoutIdentity = null,
    guardrails = new Guardrails({ maxPerHour: 2, minCooldownMs: 60_000 }),
    stateKey = null
  }) {
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Valid Ed25519 identity is required for ScribeEngine');
    }
    if (!client) {
      throw new Error('Technocore client is required for ScribeEngine');
    }

    this.identity = identity;
    this.scoutIdentity = scoutIdentity;
    this.client = client;
    this.guardrails = guardrails;
    this.stateKey = stateKey || getStateKey(identity.did, 'scribe');
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastEventsSeq: 0,
      lastMailboxSeq: 0,
      lastCheckin: null,
      syncedWithScoutCount: 0,
      faucetDiscovered: false,
      faucetHits: [],
      profilePublished: false
    };
    this.lastStateError = null;
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('scribe', this.stateKey);
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
      await this.client.setKv('scribe', this.stateKey, this.localState);
      this.lastStateError = null;
      return true;
    } catch (err) {
      this.lastStateError = err.message;
      console.warn('[Scribe] /kv/ state write failed:', err.message);
      return false;
    }
  }

  async runTurn({ eventsRoom = 'events', lobbyRoom = 'lobby' } = {}) {
    await this.loadRemoteState();
    this.localState.totalTurns += 1;

    const { shard, key } = getDidShardedPath(this.identity.did);
    const myMailbox = `mb-p-scribe-${key}`;

    // 1. Ensure DID profile is registered
    if (!this.localState.profilePublished) {
      try {
        const profileText = `did: ${this.identity.did} | pubkey: ${this.identity.rawPublicKeyHex || ''} | mailbox: ${myMailbox} | type: sentinel_scribe | agent: FLOP Sentinel Scribe | operator: github.com/Mariukasfak/flop-evidence-scout | feed: d-scout-telemetry`;
        await this.client.setKv(shard, key, profileText);
        this.localState.profilePublished = true;
      } catch {
        // Non-blocking
      }
    }

    let actionTaken = 'monitoring_events';
    let detailPayload = {};
    let outgoingMessage = null;
    let targetRoom = lobbyRoom;

    /**
     * 2. Read Scribe's own mailbox — and sign what the Scout sent back.
     *
     * This used to count inbound messages and throw them away, which is why the
     * collaboration record could never become mutual: only one of the two keys
     * ever signed anything. Counting is not attesting. Now each message from the
     * peer is acknowledged into the same world-readable record the Scout writes
     * to, so both DIDs appear as acknowledgers and a stranger can tell two
     * agents apart from one agent posting twice.
     *
     * JSON, because the text lane truncates the author to four base58
     * characters and the whole point here is knowing exactly who wrote it.
     */
    let coopAcks = 0;
    try {
      const mbData = await this.client.readRoom(myMailbox, { limit: 5, format: 'json' });
      const mbMsgs = Array.isArray(mbData?.messages) ? mbData.messages : [];
      const newMb = mbMsgs.filter(m => Number(m.seq || 0) > (this.localState.lastMailboxSeq || 0));
      if (newMb.length > 0) {
        this.localState.lastMailboxSeq = Math.max(...newMb.map(m => Number(m.seq || 0)));
        this.localState.syncedWithScoutCount += newMb.length;
      }

      const peerDid = this.scoutIdentity?.did;
      for (const msg of newMb) {
        if (!peerDid || msg.from !== peerDid) continue;
        try {
          const exchange = signExchange({
            fromDid: peerDid,
            toDid: this.identity.did,
            room: myMailbox,
            seq: Number(msg.seq || 0),
            content: msg.content ?? msg.text ?? ''
          }, this.identity);
          const result = await recordExchange(this.client, {
            didA: this.identity.did, didB: peerDid, exchange
          });
          if (result.recorded) coopAcks += 1;
        } catch {
          // Best-effort: failing to publish an acknowledgement must never cost
          // the Scribe its actual job, which is watching /r/events.
        }
      }
    } catch {
      // Non-blocking mailbox check
    }

    // 3. Discover new rooms & radar for Testnet Faucet in /r/events
    let eventsData = null;
    try {
      eventsData = await this.client.readRoom(eventsRoom, {
        since: this.localState.lastEventsSeq > 0 ? this.localState.lastEventsSeq : null,
        limit: 20
      });
    } catch {
      // Non-blocking events read
    }

    const eventMessages = Array.isArray(eventsData?.messages) ? eventsData.messages : [];
    const discoveredRooms = [];
    const faucetAlerts = [];
    if (eventMessages.length > 0) {
      const maxSeq = Math.max(...eventMessages.map(m => Number(m.seq || m.id || 0)));
      if (maxSeq > this.localState.lastEventsSeq) {
        this.localState.lastEventsSeq = maxSeq;
      }
      for (const ev of eventMessages) {
        const text = ev.content || ev.text || '';
        // /r/events lines are literally `created <name>` written by ~server.
        const match = text.match(/created\s+([a-z0-9][a-z0-9_-]{0,47})/i) || text.match(/\/r\/([a-z0-9_-]+)/i);
        if (match && match[1]) {
          const roomName = match[1];
          discoveredRooms.push(roomName);
          if (looksLikeFaucet(roomName)) {
            this.localState.faucetDiscovered = true;
            const hit = { room: roomName, seq: Number(ev.seq || 0), at: new Date().toISOString() };
            this.localState.faucetHits = [...(this.localState.faucetHits || []), hit].slice(-10);
            faucetAlerts.push(hit);
          }
        }
      }
    }

    // 4. Check for co-op peer sync with Scout Agent
    const scoutKey = this.scoutIdentity?.did ? getDidShardedPath(this.scoutIdentity.did).key : null;
    const scoutMailbox = scoutKey ? `mb-p-scout-${scoutKey}` : null;

    const sinceCoop = this.localState.lastCoopSync
      ? Date.now() - new Date(this.localState.lastCoopSync).getTime()
      : Infinity;
    const sinceCheckin = this.localState.lastCheckin
      ? Date.now() - new Date(this.localState.lastCheckin).getTime()
      : Infinity;

    if (scoutMailbox && sinceCoop > COOP_SYNC_INTERVAL_MS) {
      targetRoom = scoutMailbox;
      outgoingMessage = `[FLOP Scribe -> Scout Sync]: Sentinel node active | Verified events seq: #${this.localState.lastEventsSeq} | Faucet radar: ${this.localState.faucetDiscovered ? 'HIT' : 'clear'}.`;
      actionTaken = 'coop_sync';
      this.localState.syncedWithScoutCount += 1;
      this.localState.lastCoopSync = new Date().toISOString();
      detailPayload = {
        targetAgent: this.scoutIdentity?.did ? `Scout <${this.scoutIdentity.did.slice(0, 14)}...>` : 'Scout Agent',
        mailbox: scoutMailbox,
        reason: 'Peer sync between this operator’s two agents, via a private signed mailbox',
        response: outgoingMessage
      };
    } else if (!outgoingMessage && sinceCheckin > 4 * 60 * 60 * 1000) {
      // A digest of what actually happened is worth reading; "I am online" is not.
      targetRoom = lobbyRoom;
      const sample = discoveredRooms.slice(0, 3).join(', ') || 'none in this window';
      outgoingMessage =
        `[FLOP Sentinel] /r/events digest at seq #${this.localState.lastEventsSeq}: ` +
        `${discoveredRooms.length} new rooms this window (${sample}) | faucet radar: ` +
        `${this.localState.faucetDiscovered ? 'HIT' : 'clear'} | open source: github.com/Mariukasfak/flop-evidence-scout`;
      actionTaken = 'signed_checkin';
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        reason: 'Periodic signed Sentinel status check-in',
        response: outgoingMessage
      };
    }

    if (outgoingMessage) {
      outgoingMessage = singleLineSweep(outgoingMessage);
      const check = this.guardrails.canSendMessage(outgoingMessage);
      if (check.allowed) {
        try {
          await this.client.postMessage(targetRoom, outgoingMessage, this.identity);
          this.guardrails.recordSent(outgoingMessage);
        } catch (err) {
          actionTaken = `send_failed: ${err.message}`;
          console.warn('[Scribe] Failed to post message:', err.message);
        }
      } else {
        actionTaken = `monitoring_pacing: ${check.reason}`;
        detailPayload.pacingReason = check.reason;
      }
    }

    if (!outgoingMessage) {
      detailPayload = {
        reason: `Watching /r/${eventsRoom} and the identity registry (events seq #${this.localState.lastEventsSeq})`,
        discoveredEvents: eventMessages.length,
        discoveredRoomsCount: discoveredRooms.length
      };
    }

    // 5. Presence convention: the nick must be a lowercase, spec-valid short id.
    let presenceError = null;
    try {
      await this.client.recordPresence(eventsRoom, this.identity.did, this.localState.lastEventsSeq);
    } catch (err) {
      presenceError = err.message;
    }

    if (faucetAlerts.length > 0) {
      detailPayload.faucetAlerts = faucetAlerts;
      detailPayload.reason = `⚠️ FAUCET RADAR: rooms detected — ${faucetAlerts.map((h) => h.room).join(', ')}`;
    }
    if (presenceError) detailPayload.presenceError = presenceError;

    await this.saveRemoteState();

    return {
      agent: 'scribe',
      action: actionTaken,
      did: this.identity.did,
      room: targetRoom,
      turns: this.localState.totalTurns,
      lastEventsSeq: this.localState.lastEventsSeq,
      syncedWithScoutCount: this.localState.syncedWithScoutCount,
      coopAcks,
      discoveredRooms: discoveredRooms.length,
      faucetAlerts,
      faucetDiscovered: Boolean(this.localState.faucetDiscovered),
      stateError: this.lastStateError,
      details: detailPayload,
      timestamp: new Date().toISOString()
    };
  }
}
