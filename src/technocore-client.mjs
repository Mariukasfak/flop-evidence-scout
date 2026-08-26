import {
  signMessageBase64Url,
  singleLineSweep,
  getDidShardedPath,
  getShortId,
  isValidTechnocoreName
} from './identity.mjs';

/**
 * Fail loudly and locally instead of sending a request the server will answer
 * with `400 bad name`. Silent 400s are how the /kv/ state persistence stayed
 * broken while the dashboard reported it as working.
 */
export function assertValidName(kind, name) {
  if (!isValidTechnocoreName(name)) {
    throw new Error(
      `Invalid Technocore ${kind} "${name}": must match /^[a-z0-9][a-z0-9_-]{0,47}$/ ` +
      '(lowercase letters, digits, - and _, 1-48 chars).'
    );
  }
  return name;
}

/**
 * Note reads are prefixed by the server with an `!! UNTRUSTED CONTENT ...`
 * banner and a blank line. Parsing the raw body therefore always failed, which
 * silently discarded the agent's own persisted state on every startup.
 * The banner is a warning about the payload, not part of it — and the payload
 * stays data, never instructions.
 */
export function stripUntrustedBanner(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length && (lines[start].startsWith('!!') || lines[start].trim() === '')) {
    start += 1;
  }
  return lines.slice(start).join('\n').trim();
}

export function parseNoteBody(text) {
  const body = stripUntrustedBanner(text);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}

export function parseRoomText(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split('\n');
  const messages = [];
  const lineRegex = /^\[(\d+)\]\s+([0-9T:.Z-]+)\s+<([^>]+)>\s+(.*)$/;

  for (const line of lines) {
    const match = line.trim().match(lineRegex);
    if (match) {
      messages.push({
        seq: Number(match[1]),
        timestamp: match[2],
        from: match[3],
        content: match[4]
      });
    }
  }

  return messages;
}

export class TechnocoreClient {
  constructor({
    baseUrl = 'https://technocore.chat',
    fetchFn = globalThis.fetch,
    timeoutMs = 15_000
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async readRoom(room = 'lobby', { since = null, wait = 0, limit = 50, format = 'text' } = {}) {
    const params = new URLSearchParams();
    if (since !== null && since !== undefined) params.set('since', String(since));
    if (wait > 0) params.set('wait', String(Math.min(10, Math.max(0, wait))));
    if (limit && limit !== 50) params.set('limit', String(limit));
    if (format === 'json') params.set('format', 'json');

    const query = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}${query}`;
    
    const controller = new AbortController();
    const timeout = (wait > 0 ? (wait + 5) * 1000 : this.timeoutMs);
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.fetch(url, {
        headers: {
          'user-agent': 'FLOP-Evidence-Scout/1.0',
          'accept': format === 'json' ? 'application/json' : 'text/plain, application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Technocore read error: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json') || format === 'json') {
        const json = await response.json();
        return { messages: Array.isArray(json) ? json : (json.messages || []) };
      }

      const text = await response.text();
      const messages = parseRoomText(text);
      return { messages, raw: text };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async postSignedMessage(room = 'lobby', text, identity) {
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Identity required for signed message');
    }
    assertValidName('room', room);

    const sweptText = singleLineSweep(text);
    const nonce = Date.now().toString();
    const payloadToSign = `${room}|${nonce}|${sweptText}`;
    const sigB64Url = signMessageBase64Url(payloadToSign, identity.privateKeyPem);
    
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}/say-signed/${encodeURIComponent(identity.did)}/${sigB64Url}/${nonce}/${encodeURIComponent(sweptText)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': 'FLOP-Evidence-Scout/1.0'
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Technocore post error: HTTP ${response.status} ${errText || response.statusText}`);
      }

      const textRes = await response.text();
      return { ok: true, raw: textRes };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async postMessage(room = 'lobby', content, identity) {
    return await this.postSignedMessage(room, content, identity);
  }

  async getKv(ns, key) {
    const url = key ? `${this.baseUrl}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}` : `${this.baseUrl}/kv/${encodeURIComponent(ns)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return null;
      const text = await response.text();
      return parseNoteBody(text);
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
    assertValidName('namespace', ns);
    assertValidName('key', key);

    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    const sweptValue = singleLineSweep(stringValue);

    const params = new URLSearchParams();
    if (ifValue !== null) params.set('if', ifValue);
    if (ifAbsent) params.set('if_absent', '1');

    const query = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}/set/${encodeURIComponent(sweptValue)}${query}`;
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: { 'user-agent': 'FLOP-Evidence-Scout/1.0' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Technocore note write failed: HTTP ${response.status} ${body.slice(0, 160)}`);
      }
      return true;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async publishDidProfile(identity, profile = {}) {
    if (!identity?.did) return false;
    const { shard, key } = getDidShardedPath(identity.did);
    const {
      mailbox = `mb-p-scout-${key}`,
      type = 'autonomous_evidence_scout',
      agent = 'FLOP Evidence Scout',
      operator = 'github.com/Mariukasfak/flop-evidence-scout',
      feed = null
    } = profile;
    const profileText =
      `did: ${identity.did} | pubkey: ${identity.rawPublicKeyHex || ''} | mailbox: ${mailbox} ` +
      `| type: ${type} | agent: ${agent} | operator: ${operator}` +
      (feed ? ` | feed: ${feed}` : '');
    return await this.setKv(shard, key, profileText);
  }

  /**
   * Presence convention: /kv/<room>/hb-<nick>/set/<last seq seen>.
   * Accepts a did:key (converted to a spec-valid short id) or a ready short id.
   */
  async recordPresence(room, didOrShortId, seq) {
    const shortId = String(didOrShortId).startsWith('did:key:')
      ? getShortId(didOrShortId)
      : String(didOrShortId).toLowerCase();
    return await this.setKv(room, `hb-${shortId}`, String(seq ?? 0));
  }

  /**
   * Claim a d-<name> room as its owner: a signed, if_absent note in room-owners.
   * Signature covers `room-owners|d-<room>|<nonce>|<the same did:key>`.
   */
  async claimRoomOwnership(roomName, identity, { nonce = Date.now() } = {}) {
    const room = roomName.startsWith('d-') ? roomName : `d-${roomName}`;
    assertValidName('room', room);
    if (!identity?.did || !identity?.privateKeyPem) {
      throw new Error('Identity required to claim room ownership');
    }

    const payloadToSign = `room-owners|${room}|${nonce}|${identity.did}`;
    const sig = signMessageBase64Url(payloadToSign, identity.privateKeyPem);
    const url =
      `${this.baseUrl}/kv/room-owners/${room}/set-signed/${encodeURIComponent(identity.did)}` +
      `/${sig}/${nonce}/${encodeURIComponent(identity.did)}?if_absent=1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: { 'user-agent': 'FLOP-Evidence-Scout/1.0' },
        signal: controller.signal
      });
      clearTimeout(timer);
      const body = await response.text().catch(() => '');
      // 409 means someone already owns it — that is an answer, not a crash.
      return { ok: response.ok, status: response.status, room, body: body.slice(0, 200) };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, room, body: err.message };
    }
  }

  /** Reserved, world-writable topic note rendered next to the room in /rooms. */
  async setRoomTopic(room, topic) {
    return await this.setKv('topic', room, topic);
  }

  async health() {
    try {
      const res = await this.readRoom('lobby', { limit: 1 });
      return { ok: true, messageCount: res.messages?.length ?? 0 };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
