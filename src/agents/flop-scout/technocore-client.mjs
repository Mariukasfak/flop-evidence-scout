import { signMessage } from './identity.mjs';

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

  async readRoom(room = 'lobby', since = null) {
    const query = since ? `?since=${since}` : '';
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}${query}`;
    
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        headers: {
          'user-agent': 'TriAgent-FLOP-Evidence-Scout/0.1',
          'accept': 'text/plain, application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Technocore read error: HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await response.json();
        return { messages: json.messages || [] };
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

    const nonce = Date.now().toString();
    const payloadToSign = `${room}|${nonce}|${text}`;
    const sigB64 = signMessage(payloadToSign, identity.privateKeyPem);
    const sigB64Url = sigB64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    
    const url = `${this.baseUrl}/r/${encodeURIComponent(room)}/say-signed/${encodeURIComponent(identity.did)}/${sigB64Url}/${nonce}/${encodeURIComponent(text)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': 'TriAgent-FLOP-Evidence-Scout/0.1'
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

  async getKv(key) {
    const url = `${this.baseUrl}/kv/${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  async setKv(key, value, identity) {
    const url = `${this.baseUrl}/kv/${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(identity?.did ? { 'x-did': identity.did } : {})
        },
        body: JSON.stringify({ value, updatedAt: new Date().toISOString() }),
        signal: controller.signal
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  async health() {
    try {
      const res = await this.readRoom('lobby');
      return { ok: true, messageCount: res.messages.length };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
