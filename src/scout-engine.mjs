import { formatKnowledgeResponse, findRelevantKnowledge } from './knowledge.mjs';
import { Guardrails } from './guardrails.mjs';
import { getDidShardedPath } from './identity.mjs';

export class ScoutEngine {
  constructor({
    identity,
    client,
    guardrails = new Guardrails(),
    stateKey = null,
    scribeIdentity = null
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
    this.stateKey = stateKey || `scout_state_${identity.did.slice(-8)}`;
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastSeenSeq: 0,
      lastMailboxSeq: 0,
      lastCheckin: null,
      handledCount: 0,
      profilePublished: false
    };
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv('scout', this.stateKey);
      if (remote && typeof remote === 'object') {
        this.localState = { ...this.localState, ...remote };
      }
    } catch {
      // If remote /kv/ is not yet available, keep local state
    }
    return this.localState;
  }

  async saveRemoteState() {
    try {
      this.localState.lastActive = new Date().toISOString();
      await this.client.setKv('scout', this.stateKey, this.localState);
    } catch (err) {
      console.warn('Failed to persist state to Technocore /kv/:', err.message);
    }
  }

  async runTurn({ room = 'lobby' } = {}) {
    await this.loadRemoteState();
    this.localState.totalTurns += 1;

    // 1. Ensure sharded DID profile is published
    if (!this.localState.profilePublished) {
      try {
        await this.client.publishDidProfile(this.identity);
        this.localState.profilePublished = true;
      } catch (err) {
        console.warn('Failed to publish DID profile:', err.message);
      }
    }

    // 2. Read room messages (e.g. /r/lobby)
    let roomData = null;
    try {
      roomData = await this.client.readRoom(room, {
        since: this.localState.lastSeenSeq > 0 ? this.localState.lastSeenSeq : null,
        limit: 20
      });
    } catch (err) {
      return {
        action: 'error',
        error: `Failed to read room ${room}: ${err.message}`,
        did: this.identity.did,
        turns: this.localState.totalTurns,
        lastSeenSeq: this.localState.lastSeenSeq
      };
    }

    const messages = Array.isArray(roomData?.messages) ? roomData.messages : [];
    const newMessages = messages.filter((m) => {
      const seq = Number(m.seq || m.id || 0);
      return seq > this.localState.lastSeenSeq && m.from !== this.identity.did;
    });

    let actionTaken = 'monitoring_room';
    let outgoingMessage = null;
    let targetRoom = room;
    let detailPayload = {};

    // 3. Check for relevant inquiries in /r/lobby
    for (const msg of newMessages) {
      const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
      const relevant = findRelevantKnowledge(text);
      
      if (relevant.length > 0 && /\?|how|kaip|kas|kur|mcp|did|kv|rest|airdrop|claim/i.test(text)) {
        const knowledgeAnswer = formatKnowledgeResponse(text);
        outgoingMessage = `[FLOP Scout -> ${msg.from || 'Agent'}]: ${knowledgeAnswer}`;
        actionTaken = 'answered_inquiry';
        targetRoom = room;
        this.localState.handledCount += 1;
        detailPayload = {
          targetAgent: msg.from || 'Agent',
          inquiry: text,
          reason: `Aptikta užklausa apie ${relevant.map(r => r.topic).join(', ')}`,
          response: knowledgeAnswer
        };
        break;
      }
    }

    // 4. Check Scout's private mailbox for Scribe sync messages
    const scoutKey = getDidShardedPath(this.identity.did).key;
    const scoutMailbox = `mb-p-scout-${scoutKey}`;
    const scribeKey = this.scribeIdentity?.did ? getDidShardedPath(this.scribeIdentity.did).key : null;
    const scribeMailbox = scribeKey ? `mb-p-scribe-${scribeKey}` : null;

    if (!outgoingMessage && scribeMailbox) {
      try {
        const mbData = await this.client.readRoom(scoutMailbox, { limit: 5 });
        const mbMsgs = Array.isArray(mbData?.messages) ? mbData.messages : [];
        const newMb = mbMsgs.filter(m => Number(m.seq || 0) > (this.localState.lastMailboxSeq || 0));
        if (newMb.length > 0) {
          const latest = newMb[newMb.length - 1];
          this.localState.lastMailboxSeq = Number(latest.seq || 0);
          outgoingMessage = `[FLOP Scout -> Scribe Ack]: Verified sync #${latest.seq} | Mesh state synchronized | Turn #${this.localState.totalTurns}.`;
          targetRoom = scribeMailbox;
          actionTaken = 'coop_ack';
          detailPayload = {
            targetAgent: this.scribeIdentity?.did ? `Scribe <${this.scribeIdentity.did.slice(0, 14)}...>` : 'Scribe Agent',
            mailbox: scribeMailbox,
            reason: 'Dvipusis sinchronizacijos patvirtinimas tarp Scout ir Scribe pašto dėžučių',
            response: outgoingMessage
          };
        }
      } catch {
        // Non-blocking mailbox check
      }
    }

    // 5. If no specific inquiry or ack, periodic signed check-in
    if (!outgoingMessage && (!this.localState.lastCheckin || Date.now() - new Date(this.localState.lastCheckin).getTime() > 1800_000)) {
      outgoingMessage = `[FLOP Scout Check-in]: Active persistent DID ${this.identity.did.slice(0, 16)}... | State /kv/ turns: ${this.localState.totalTurns} | Monitoring documentation & agent inquiries.`;
      actionTaken = 'signed_checkin';
      targetRoom = room;
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        reason: 'Periodinis Ed25519 pasirašytas būsenos check-in',
        response: outgoingMessage
      };
    }

    // Attempt to send message if allowed by guardrails
    if (outgoingMessage) {
      outgoingMessage = outgoingMessage.replace(/[\r\n\t]+/g, ' ').trim();
      const isPriority = actionTaken === 'answered_inquiry' || actionTaken === 'coop_ack';
      const check = this.guardrails.canSendMessage(outgoingMessage, { isPriorityInquiry: isPriority });
      if (check.allowed) {
        try {
          await this.client.postMessage(targetRoom, outgoingMessage, this.identity);
          this.guardrails.recordSent(outgoingMessage);
        } catch (err) {
          actionTaken = `send_failed: ${err.message}`;
          console.warn('Failed to post message to Technocore:', err.message);
        }
      } else {
        actionTaken = `monitoring_pacing: ${check.reason}`;
        detailPayload.pacingReason = check.reason;
      }
    }

    if (!outgoingMessage) {
      detailPayload = {
        reason: 'Kambarys skaitomas realiu laiku, palaikomas saugus tempas (anti-spam).'
      };
    }

    if (newMessages.length > 0) {
      const maxSeq = Math.max(...newMessages.map((m) => Number(m.seq || m.id || 0)));
      if (maxSeq > this.localState.lastSeenSeq) {
        this.localState.lastSeenSeq = maxSeq;
      }
    }

    await this.saveRemoteState();

    return {
      action: actionTaken,
      did: this.identity.did,
      room: targetRoom,
      turns: this.localState.totalTurns,
      handledCount: this.localState.handledCount,
      lastSeenSeq: this.localState.lastSeenSeq,
      details: detailPayload
    };
  }
}
