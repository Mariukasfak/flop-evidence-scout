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
      handledCount: 0
    };
  }

  async loadRemoteState() {
    try {
      const remote = await this.client.getKv(this.stateKey);
      if (remote?.value && typeof remote.value === 'object') {
        this.localState = { ...this.localState, ...remote.value };
      }
    } catch {
      // If remote /kv/ is not yet available, keep local state
    }
    return this.localState;
  }

  async saveRemoteState() {
    try {
      this.localState.lastActive = new Date().toISOString();
      await this.client.setKv(this.stateKey, this.localState, this.identity);
    } catch (err) {
      console.warn('Failed to persist state to Technocore /kv/:', err.message);
    }
  }

  async runTurn({ room = 'lobby' } = {}) {
    await this.loadRemoteState();
    this.localState.totalTurns += 1;

    let roomData;
    try {
      roomData = await this.client.readRoom(room);
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

    let actionTaken = 'idle';
    let outgoingMessage = null;

    // Check if there are relevant inquiries from other agents
    for (const msg of newMessages) {
      const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
      const relevant = findRelevantKnowledge(text);
      
      if (relevant.length > 0 && /\?|how|kaip|kas|kur|mcp|did|kv|rest|airdrop|claim/i.test(text)) {
        outgoingMessage = `[FLOP Scout -> ${msg.from || 'Agent'}]: ${formatKnowledgeResponse(text)}`;
        actionTaken = 'answered_inquiry';
        this.localState.handledCount += 1;
        break;
      }
    }

    // If no specific inquiry, consider a periodic signed status check-in
    if (!outgoingMessage && (!this.localState.lastCheckin || Date.now() - new Date(this.localState.lastCheckin).getTime() > 1800_000)) {
      outgoingMessage = `[FLOP Scout Check-in]: Active persistent DID ${this.identity.did.slice(0, 16)}... | State /kv/ turns: ${this.localState.totalTurns} | Monitoring documentation & agent inquiries.`;
      actionTaken = 'signed_checkin';
      this.localState.lastCheckin = new Date().toISOString();
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
        actionTaken = `skipped_rate_limit: ${check.reason}`;
      }
    }

    // Update highest seen message sequence
    if (messages.length > 0) {
      const maxSeq = Math.max(...messages.map((m) => Number(m.seq || m.id || 0)));
      if (maxSeq > this.localState.lastSeenSeq) {
        this.localState.lastSeenSeq = maxSeq;
      }
    }

    await this.saveRemoteState();

    return {
      action: actionTaken,
      did: this.identity.did,
      turns: this.localState.totalTurns,
      lastSeenSeq: this.localState.lastSeenSeq,
      handledCount: this.localState.handledCount,
      timestamp: new Date().toISOString()
    };
  }
}
