import { getDidShardedPath, singleLineSweep } from './identity.mjs';
import { Guardrails } from './guardrails.mjs';
import { formatKnowledgeResponse, findRelevantKnowledge } from './knowledge.mjs';

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
    this.stateKey = stateKey || `scribe_state_${identity.did.slice(-8)}`;
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastEventsSeq: 0,
      lastMailboxSeq: 0,
      lastCheckin: null,
      syncedWithScoutCount: 0,
      faucetDiscovered: false,
      profilePublished: false
    };
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('scribe', this.stateKey);
      if (remote && typeof remote === 'object') {
        this.localState = { ...this.localState, ...remote };
      }
    } catch {
      // Non-blocking
    }
    return this.localState;
  }

  async saveRemoteState() {
    try {
      this.localState.lastActive = new Date().toISOString();
      await this.client.setKv('scribe', this.stateKey, this.localState);
    } catch (err) {
      console.warn('Failed to persist scribe state to /kv/:', err.message);
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
        const profileText = `did: ${this.identity.did} | pubkey: ${this.identity.rawPublicKeyHex || ''} | mailbox: ${myMailbox} | type: sentinel_scribe | agent: FLOP Sentinel Scribe`;
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

    // 2. Read Scribe's own private mailbox for Scout ACKs & tasks
    try {
      const mbData = await this.client.readRoom(myMailbox, { limit: 5 });
      const mbMsgs = Array.isArray(mbData?.messages) ? mbData.messages : [];
      const newMb = mbMsgs.filter(m => Number(m.seq || 0) > (this.localState.lastMailboxSeq || 0));
      if (newMb.length > 0) {
        this.localState.lastMailboxSeq = Math.max(...newMb.map(m => Number(m.seq || 0)));
        this.localState.syncedWithScoutCount += newMb.length;
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
    if (eventMessages.length > 0) {
      const maxSeq = Math.max(...eventMessages.map(m => Number(m.seq || m.id || 0)));
      if (maxSeq > this.localState.lastEventsSeq) {
        this.localState.lastEventsSeq = maxSeq;
      }
      for (const ev of eventMessages) {
        const text = ev.content || ev.text || '';
        const match = text.match(/\/r\/([a-z0-9_-]+)/i);
        if (match && match[1]) {
          discoveredRooms.push(match[1]);
          if (/faucet|drip|testnet/i.test(match[1])) {
            this.localState.faucetDiscovered = true;
          }
        }
      }
    }

    // 4. Check for co-op peer sync with Scout Agent
    const scoutKey = this.scoutIdentity?.did ? getDidShardedPath(this.scoutIdentity.did).key : null;
    const scoutMailbox = scoutKey ? `mb-p-scout-${scoutKey}` : null;

    if (scoutMailbox && (!this.localState.lastCheckin || Date.now() - new Date(this.localState.lastCheckin).getTime() > 1800_000)) {
      targetRoom = scoutMailbox;
      outgoingMessage = `[FLOP Scribe -> Scout Sync]: Sentinel node active | Verified events seq: #${this.localState.lastEventsSeq} | State /kv/ intact.`;
      actionTaken = 'coop_sync';
      this.localState.syncedWithScoutCount += 1;
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        targetAgent: this.scoutIdentity?.did ? `Scout <${this.scoutIdentity.did.slice(0, 14)}...>` : 'Scout Agent',
        mailbox: scoutMailbox,
        reason: 'Dviejų agentų tinklo sinchronizacija per privačią pasirašytą pašto dėžutę (Co-op Mesh)',
        response: outgoingMessage
      };
    } else if (!outgoingMessage && (!this.localState.lastCheckin || Date.now() - new Date(this.localState.lastCheckin).getTime() > 3600_000)) {
      targetRoom = lobbyRoom;
      outgoingMessage = `[FLOP Scribe Check-in]: Sentinel Scribe online (DID: ${this.identity.did.slice(0, 16)}...) | Monitoring /r/events and network registry.`;
      actionTaken = 'signed_checkin';
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        reason: 'Periodinis pasirašytas Sentinel būsenos check-in',
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
        reason: `Stebimas /r/${eventsRoom} ir tinklo tapatybių registras (įvykių seka: #${this.localState.lastEventsSeq})`,
        discoveredEvents: eventMessages.length,
        discoveredRoomsCount: discoveredRooms.length
      };
    }

    // 5. Record presence convention
    try {
      await this.client.recordPresence('events', this.identity.did.slice(-8), this.localState.lastEventsSeq);
    } catch {
      // Non-blocking
    }

    await this.saveRemoteState();

    return {
      agent: 'scribe',
      action: actionTaken,
      did: this.identity.did,
      room: targetRoom,
      turns: this.localState.totalTurns,
      lastEventsSeq: this.localState.lastEventsSeq,
      syncedWithScoutCount: this.localState.syncedWithScoutCount,
      details: detailPayload,
      timestamp: new Date().toISOString()
    };
  }
}
