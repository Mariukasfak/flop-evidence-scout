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

/**
 * How many messages one read is worth.
 *
 * Technocore 0.11.0 documents `limit` as clamping to 1..200. Measured against
 * /r/lobby on 2026-08-31: limit=25 returns 8,746 bytes, limit=200 returns
 * 67,718 — eight times the messages for the same round-trip, in the same time,
 * because the second is dominated by latency and not by payload.
 *
 * That ratio is the whole argument. /r/lobby runs at roughly 3,100 messages a
 * minute and a cycle takes about forty seconds, so a 25-message window saw
 * about one percent of what happened and the rest fell off the ring unread —
 * 17,346 messages went missing that way in one earlier stretch. The read budget
 * is 600 a minute per IP and the agent uses about twenty, so nothing here is
 * scarce except the messages themselves.
 */
export const READ_WINDOW = 200;

export class TechnocoreClient {
  constructor({
    baseUrl = 'https://technocore.chat',
    fetchFn = globalThis.fetch,
    timeoutMs = 15_000,
    readOnly = false
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;

    /**
     * When the transport last actually worked, counted here rather than guessed
     * at by every caller.
     *
     * During a full Technocore outage each cycle produces the same twenty lines
     * — state write failed, activity not recorded, post failed, lease
     * unreachable — once a minute, for hours. The agent is fine and the log is
     * unreadable, which is how "I still don't really see it working" happens
     * while the process is healthy and doing its job locally.
     *
     * One counter in the one place that knows the truth: the fetch itself.
     */
    this.lastOkAt = null;
    this.consecutiveFailures = 0;

    this.fetch = async (url, init) => {
      try {
        const response = await fetchFn(url, init);
        // A 5xx is the server refusing, not the transport working. Only an
        // answer we could have used counts as reaching it.
        if (response.ok || response.status < 500) {
          this.lastOkAt = Date.now();
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures += 1;
        }
        return response;
      } catch (err) {
        this.consecutiveFailures += 1;
        throw err;
      }
    };
    /**
     * Refuse every write, here, rather than in each caller.
     *
     * --dry-run used to mean only "stop after one cycle". It gated the lease and
     * nothing else, so a dry run posted signed messages to the live lobby,
     * claimed rooms and wrote notes exactly as a real run did — a flag whose name
     * promises a rehearsal while delivering the opposite. `npm run dry-run` is a
     * published entry point in this repository.
     *
     * Gating at the client is the reason it stays fixed: four engines write, and
     * a fifth added later inherits the guarantee instead of having to remember
     * it. Reads are untouched — observing costs nobody anything.
     */
    this.readOnly = readOnly;
  }

  /** The one place a write is refused, so no caller can forget to ask. */
  assertWritable(what) {
    if (this.readOnly) throw new Error(`dry run: refusing to ${what}`);
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
        const raw = Array.isArray(json) ? json : (json.messages || []);
        /**
         * One message shape, whichever lane it arrived on.
         *
         * The JSON view names the fields `ts` and `text`; the text view parses to
         * `timestamp` and `content`. Callers were quietly coping with both —
         * `msg.content ?? msg.text` in one place, `msg.content` alone in another —
         * which is how a reader ends up silently working on one format and
         * returning nothing on the other.
         */
        return {
          messages: raw.map((m) => ({
            ...m,
            timestamp: m.timestamp ?? m.ts ?? null,
            content: m.content ?? m.text ?? '',
            text: m.text ?? m.content ?? ''
          })),
          /**
           * The oldest seq the room still holds, which is how a reader learns it
           * missed something.
           *
           * The manual is explicit: "If a reply reports first_seq greater than
           * your since+1, you missed lines." A room is a ring — /r/lobby runs at
           * ~2,900 messages a minute and drops history past ~10 MiB — so a
           * cursor that falls behind during a restart or a lease standdown does
           * not lag, it loses. Upstream also just fixed a reaped-and-recreated
           * room restarting its seq at 1, which starved old cursors silently;
           * this is the field that makes either case visible.
           */
          firstSeq: Number.isFinite(json?.first_seq) ? json.first_seq : null,
          lastSeq: Number.isFinite(json?.last_seq) ? json.last_seq : null,
          /**
           * Which conversation this room is on, published since 0.11.0.
           *
           * A room that was reaped and recreated restarts its seq, and until now
           * that arrived looking exactly like a ring that had dropped history:
           * both show up as first_seq ahead of our cursor. They are not the same
           * event. A ring dropping messages means we read too slowly. A new
           * generation means the conversation we were following no longer
           * exists, and the cursor we are carrying refers to a different room
           * that happens to share a name.
           *
           * Reporting them as one thing made the second unfixable — no amount of
           * reading faster helps.
           */
          generation: Number.isFinite(json?.generation) ? json.generation : null
        };
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
    this.assertWritable(`post a signed message to /r/${room}`);
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
    this.assertWritable(`post to /r/${room}`);
    return await this.postSignedMessage(room, content, identity);
  }

  /**
   * Read a note and say WHY there is nothing, when there is nothing.
   *
   * getKv() below returns null for a missing note and null for a 503, and that
   * conflation is not harmless. The cross-machine lease read a transient
   * "Service Unavailable" as "nobody holds this", tried to claim it, failed on
   * the same outage, and reported "lost the race to claim it" — an outage
   * described as contention, which is the kind of wrong diagnosis that costs an
   * hour of looking in the wrong place.
   *
   * Anything that must distinguish absence from ignorance uses this instead.
   */
  async readNote(ns, key) {
    const url = `${this.baseUrl}/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (response.status === 404) {
        return { reachable: true, found: false, value: null, status: 404, error: null };
      }
      if (!response.ok) {
        return { reachable: false, found: null, value: null, status: response.status, error: `HTTP ${response.status}` };
      }
      const text = await response.text();
      return { reachable: true, found: true, value: stripUntrustedBanner(text), status: response.status, error: null };
    } catch (err) {
      clearTimeout(timer);
      return { reachable: false, found: null, value: null, status: 0, error: err.message };
    }
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
    /**
     * 0.11.0 refuses both conditions at once with a 400, and is right to.
     * if_absent means "nothing is there", if= means "this exact value is
     * there", and there is no correct pick between them. Before 0.11.0 the
     * server silently dropped the if= and still answered ok — so a caller that
     * sent both got a write it never asked for and no way to know. Caught here
     * rather than as an opaque 400 from a server round-trip away.
     */
    if (ifAbsent && ifValue !== null) {
      throw new Error('setKv: if_absent and if= are mutually exclusive — send one or the other');
    }
    this.assertWritable(`write the note /kv/${ns}/${key}`);
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
      feed = null,
      /**
       * `tclk1:<rails>` — the token that says we speak the escrow convention.
       *
       * The spec calls it a routing hint and nothing more: this note is
       * world-writable and forgeable, so the token proves only that somebody
       * wrote it. Getting it wrong costs a counterparty one wasted message and
       * never funds. It is here so an agent looking for a partner can tell
       * before spending that message.
       */
      rails = null
    } = profile;
    const profileText =
      `did: ${identity.did} | pubkey: ${identity.rawPublicKeyHex || ''} | mailbox: ${mailbox} ` +
      `| type: ${type} | agent: ${agent} | operator: ${operator}` +
      (feed ? ` | feed: ${feed}` : '') +
      (rails && rails.length ? ` | tclk1:${rails.join(',')}` : '');
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
    this.assertWritable(`claim ownership of /r/${roomName}`);
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
