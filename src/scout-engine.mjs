import { formatKnowledgeResponse, findRelevantKnowledge } from './knowledge.mjs';
import { Guardrails } from './guardrails.mjs';

export class ScoutEngine {
  constructor({
    identity,
    client,
    guardrails = new Guardrails(),
    stateKey = null
  }) {
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Valid Ed25519 identity is required for ScoutEngine');
    }
    if (!client) {
      throw new Error('Technocore client is required for ScoutEngine');
    }

    this.identity = identity;
    this.client = client;
    this.guardrails = guardrails;
    this.stateKey = stateKey || `scout_state_${identity.did.slice(-8)}`;
    this.localState = {
      did: identity.did,
      totalTurns: 0,
      lastSeenSeq: 0,
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
      } catch {
        // non-blocking
      }
    }

    let roomData;
    try {
      roomData = await this.client.readRoom(room, { since: this.localState.lastSeenSeq > 0 ? this.localState.lastSeenSeq : null });
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
    let detailPayload = {};

    // Check if there are relevant inquiries from other agents
    for (const msg of newMessages) {
      const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
      const relevant = findRelevantKnowledge(text);
      
      if (relevant.length > 0 && /\?|how|kaip|kas|kur|mcp|did|kv|rest|airdrop|claim/i.test(text)) {
        const knowledgeAnswer = formatKnowledgeResponse(text);
        outgoingMessage = `[FLOP Scout -> ${msg.from || 'Agent'}]: ${knowledgeAnswer}`;
        actionTaken = 'answered_inquiry';
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

    // If no specific inquiry, consider a periodic signed status check-in
    if (!outgoingMessage && (!this.localState.lastCheckin || Date.now() - new Date(this.localState.lastCheckin).getTime() > 1800_000)) {
      outgoingMessage = `[FLOP Scout Check-in]: Active persistent DID ${this.identity.did.slice(0, 16)}... | State /kv/ turns: ${this.localState.totalTurns} | Monitoring documentation & agent inquiries.`;
      actionTaken = 'signed_checkin';
      this.localState.lastCheckin = new Date().toISOString();
      detailPayload = {
        reason: 'Periodinis Ed25519 pasirašytas būsenos check-in',
        response: outgoingMessage
      };
    }

    // Attempt to send message if allowed by guardrails
    if (outgoingMessage) {
      outgoingMessage = outgoingMessage.replace(/[\r\n\t]+/g, ' ').trim();
      const check = this.guardrails.canSendMessage(outgoingMessage);
      if (check.allowed) {
        try {
          await this.client.postMessage(room, outgoingMessage, this.identity);
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
        reason: `Stebimas kambarys /r/${room} (naujų žinučių: ${newMessages.length})`,
        latestSnippet: messages.slice(-3).map(m => `<${(m.from || '').slice(0, 14)}> ${m.content || ''}`).join(' | ')
      };
    }

    // Update highest seen message sequence
    if (messages.length > 0) {
      const maxSeq = Math.max(...messages.map((m) => Number(m.seq || m.id || 0)));
      if (maxSeq > this.localState.lastSeenSeq) {
        this.localState.lastSeenSeq = maxSeq;
      }
    }

    try {
      await this.client.recordPresence(room, this.identity.did.slice(-8), this.localState.lastSeenSeq);
    } catch {
      // non-blocking presence update
    }

    await this.saveRemoteState();

    return {
      action: actionTaken,
      did: this.identity.did,
      turns: this.localState.totalTurns,
      lastSeenSeq: this.localState.lastSeenSeq,
      handledCount: this.localState.handledCount,
      details: detailPayload,
      timestamp: new Date().toISOString()
    };
  }
}
