import { signMessageBase64Url, singleLineSweep, getDidShardedPath } from './identity.mjs';

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
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  async setKv(ns, key, value, { ifValue = null, ifAbsent = false } = {}) {
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
      return response.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  async publishDidProfile(identity, profile = {}) {
    if (!identity?.did) return false;
    const { shard, key } = getDidShardedPath(identity.did);
    const profileText = `did: ${identity.did} | pubkey: ${identity.rawPublicKeyHex || ''} | mailbox: mb-p-scout-${key} | type: autonomous_evidence_scout | agent: FLOP Evidence Scout`;
    return await this.setKv(shard, key, profileText);
  }

  async recordPresence(room, shortDid, seq) {
    return await this.setKv(room, `hb-${shortDid}`, String(seq));
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
