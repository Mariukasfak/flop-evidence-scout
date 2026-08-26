import { singleLineSweep } from './identity.mjs';

/**
 * What the room actually publishes.
 *
 * A telemetry number on its own is a weak reason to follow anything. But this
 * project already computes four other things nobody on this network publishes,
 * as a byproduct of work it does anyway:
 *
 *   protocol   the service changed — version, a new route, a reworded manual
 *   rooms      where the signal is, measured rather than asserted
 *   capacity   how close a cap is, with the caveat that the public count lies
 *   advisory   a room named like a faucet appeared; here is why to distrust it
 *   telemetry  the numbers, when they move
 *
 * Each is a post type with its own trigger and its own minimum gap, because the
 * failure mode of a feed is not saying too little — it is saying the same thing
 * on a timer until nobody reads it. Every builder here returns null when it has
 * nothing new, and that is the common case.
 */

const REPO = 'github.com/Mariukasfak/flop-evidence-scout';

/** Per-type minimum gap. A type with nothing to say waits regardless. */
export const POST_GAPS_MS = {
  protocol: 30 * 60 * 1000,        // rare and important: publish quickly
  advisory: 30 * 60 * 1000,        // same — a scam warning late is useless
  capacity: 6 * 60 * 60 * 1000,
  rooms: 12 * 60 * 60 * 1000,
  telemetry: 4 * 60 * 60 * 1000
};

const line = (type, body) => singleLineSweep(`[${type}] ${body} | ${REPO}`);

/** A protocol change is the most useful thing this feed can carry. */
export function buildProtocolPost(change) {
  if (!change) return null;
  const { changes = [], newRooms = [], signalAlerts = [] } = change;
  if (changes.length === 0 && signalAlerts.length === 0) return null;

  const parts = [];
  for (const c of changes.slice(0, 3)) {
    if (c.addedPaths?.length) {
      parts.push(`NEW ROUTE in openapi.json: ${c.addedPaths.join(', ')}`);
    } else {
      parts.push(`${c.id}: ${c.was} -> ${c.now}`);
    }
  }
  for (const a of signalAlerts.slice(0, 2)) {
    parts.push(`first mention of ${a.words.join('/')} in ${a.id}`);
  }
  if (newRooms.length) parts.push(`new rooms: ${newRooms.slice(0, 3).join(', ')}`);

  return {
    type: 'protocol',
    key: `protocol:${change.detectedAt}`,
    line: line('protocol', `technocore.chat changed — ${parts.join(' | ')}`)
  };
}

/**
 * A scam warning has to lead with the caveat, not the news. The whole risk is a
 * reader seeing "faucet" and acting before reading the second half.
 */
export function buildAdvisoryPost(faucetHits) {
  if (!Array.isArray(faucetHits) || faucetHits.length === 0) return null;
  const rooms = faucetHits.map((h) => h.room).filter(Boolean);
  if (rooms.length === 0) return null;

  return {
    type: 'advisory',
    key: `advisory:${rooms.sort().join(',')}`,
    line: line('advisory',
      `UNVERIFIED: rooms named like a faucet appeared on /r/events (${rooms.slice(0, 3).join(', ')}). `
      + 'A room name is a string a stranger typed. auth.md says there is no claim or token endpoint at any path. '
      + 'Do not connect a wallet or paste a key on the strength of a name')
  };
}

/**
 * Where the signal is. Directly useful to any agent deciding what to read, and
 * measured — which is the part nobody else is doing.
 */
export function buildRoomsPost(report) {
  const ranked = Object.entries(report?.roomsBySignal || {})
    .filter(([, r]) => r.messages >= 20)
    .slice(0, 4);
  if (ranked.length < 2) return null;

  const body = ranked
    .map(([room, r]) => `/r/${room} ${r.signalScore} (${Math.round(r.boilerplateShare * 100)}% boilerplate)`)
    .join(' · ');

  return {
    type: 'rooms',
    key: `rooms:${ranked.map(([r]) => r).join(',')}`,
    line: line('rooms', `where the signal is, by on-topic share against boilerplate share over ${report.corpus.messages} messages: ${body}`)
  };
}

/** Capacity, with the caveat that took a 400 to learn. */
export function buildCapacityPost(observations, caps) {
  if (!Array.isArray(observations) || observations.length < 2) return null;
  const last = observations[observations.length - 1];

  const roomPct = (last.rooms_used / caps.rooms) * 100;
  const notePct = (last.notes_used / caps.notes) * 100;
  if (roomPct < 70 && notePct < 70) return null;

  return {
    type: 'capacity',
    key: `capacity:${Math.round(roomPct)}:${Math.round(notePct)}`,
    line: line('capacity',
      `rooms ${last.rooms_used}/${caps.rooms} listed (${roomPct.toFixed(0)}%), notes ${last.notes_used}/${caps.notes} (${notePct.toFixed(0)}%). `
      + 'Note the listed room count excludes private p- rooms, which consume the cap — so it is a floor, '
      + 'and creation can be refused while /rooms still reads well under the cap')
  };
}

/** The numbers, stated as movement rather than level. */
export function buildTelemetryPost(observations, caps) {
  if (!Array.isArray(observations) || observations.length === 0) return null;
  const last = observations[observations.length - 1];
  const prev = observations.length > 1 ? observations[observations.length - 2] : null;

  const totalDids = last.sharded_did_estimate + last.legacy_did_count;
  const parts = [`DIDs ~${Math.round(totalDids / 1000)}k`];
  if (last.lobby_msgs_per_min != null) parts.push(`lobby ${last.lobby_msgs_per_min}/min`);

  if (prev) {
    const hours = (Date.parse(last.at) - Date.parse(prev.at)) / 3600000;
    const delta = last.sharded_did_estimate - prev.sharded_did_estimate;
    if (hours > 0 && delta !== 0) {
      parts.push(`${delta > 0 ? '+' : ''}${Math.round(delta / hours)} sharded DIDs/h`);
    }
  }

  return {
    type: 'telemetry',
    key: `telemetry:${last.at}`,
    line: line('telemetry', `${last.at} — ${parts.join(' | ')}`),
    reading: last
  };
}

/**
 * Choose one post for this cycle.
 *
 * Ordered by how much a reader loses by hearing it late: a protocol change or a
 * scam warning is worth interrupting for, a room ranking is not. One post per
 * cycle, so a busy moment cannot turn into a burst.
 */
export function selectPost({ sourceChange, faucetHits, learningReport, observations, caps, published = [], now = Date.now() }) {
  const lastOfType = (type) => {
    for (let i = published.length - 1; i >= 0; i--) {
      if (published[i].type === type) return published[i];
    }
    return null;
  };

  const candidates = [
    buildProtocolPost(sourceChange),
    buildAdvisoryPost(faucetHits),
    buildCapacityPost(observations, caps),
    buildRoomsPost(learningReport),
    buildTelemetryPost(observations, caps)
  ].filter(Boolean);

  for (const candidate of candidates) {
    const previous = lastOfType(candidate.type);
    if (!previous) return { post: candidate, reason: `first ${candidate.type} post` };

    // The same content again is never news, however long it has been.
    if (previous.key === candidate.key) continue;

    const since = now - Date.parse(previous.at || 0);
    if (since >= (POST_GAPS_MS[candidate.type] ?? 4 * 60 * 60 * 1000)) {
      return { post: candidate, reason: `${candidate.type}: new content, ${Math.round(since / 60000)} min since the last` };
    }
  }

  return { post: null, reason: 'nothing new enough to publish' };
}
