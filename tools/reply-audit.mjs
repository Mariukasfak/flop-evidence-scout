/**
 * Does anyone reply to us?
 *
 * The entire strategy rests on one claim: that being *answered* is worth more
 * than posting, because the service itself publishes a zero-response share and
 * almost nobody on this network is holding a conversation. That claim has been
 * asserted in a published guide, written into a README, and used to justify
 * every design decision here — and it has never been measured.
 *
 * This measures it. It reads the rooms the agents work plus their mailboxes,
 * finds anything that mentions either identity, and reports how many distinct
 * strangers that is. The honest answer may well be zero, in which case the
 * premise is wrong and the plan says to keep the artifacts and drop the
 * conversational agent.
 *
 * Run: node tools/reply-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity, getDidShardedPath } from '../src/identity.mjs';
import { TechnocoreClient } from '../src/technocore-client.mjs';
import { DEFAULT_WATCH_ROOMS } from '../src/scout-engine.mjs';

const OUT = path.resolve('docs/reply-audit.json');

const scout = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
const scribe = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');

const OURS = [scout.did, scribe.did];

/**
 * Matching on a prefix is useless here: `did:key:z6Mk` opens every DID on the
 * network. The first version of this used a 12-character prefix and reported 87
 * distinct responders, all of them oracle bots quoting their own key — a
 * fabricated headline for the one metric this whole project rests on.
 *
 * A mention must therefore carry the full DID, or a tail long enough to be
 * unique. Sixteen base58 characters is roughly 94 bits; a collision is not the
 * thing to worry about.
 */
const MENTION_NEEDLES = OURS.flatMap((did) => [did, did.slice(-16)]);

/** How the text view renders us: <z6Mk…3zgn>, so the whole field must equal it. */
const OUR_RENDERED = OURS.map((did) => `z6Mk…${did.slice(-4)}`);

const isOurs = (from) => OURS.includes(from) || OUR_RENDERED.includes(from);

async function scanRoom(client, room) {
  try {
    const data = await client.readRoom(room, { limit: 100 });
    return (data.messages || []).map((m) => ({
      room,
      seq: Number(m.seq || 0),
      from: m.from || '',
      text: m.content || m.text || ''
    }));
  } catch (err) {
    return [{ room, error: err.message }];
  }
}

async function main() {
  const client = new TechnocoreClient({ baseUrl: process.env.TECHNOCORE_URL || 'https://technocore.chat' });

  const rooms = [
    ...DEFAULT_WATCH_ROOMS,
    'lobby',
    `mb-p-scout-${getDidShardedPath(scout.did).key}`,
    `mb-p-scribe-${getDidShardedPath(scribe.did).key}`
  ];

  const all = [];
  for (const room of rooms) all.push(...await scanRoom(client, room));

  const errors = all.filter((m) => m.error).map((m) => ({ room: m.room, error: m.error }));
  const messages = all.filter((m) => !m.error);

  const ourPosts = messages.filter((m) => isOurs(m.from));
  const mentions = messages.filter((m) => !isOurs(m.from) && MENTION_NEEDLES.some((needle) => m.text.includes(needle)));
  const inbound = messages.filter((m) => !isOurs(m.from) && m.room.startsWith('mb-p-'));

  /**
   * A stranger echoing our own outgoing format back at us is not a reply.
   * Three agents are writing `[FLOP Scribe -> Scout Sync]` into our mailbox with
   * keys that are not our Scribe's — the mailbox name is published in our DID
   * note, so anyone can write there, and some are copying the format. Counting
   * that as engagement would be flattering the metric.
   */
  const OUR_FORMATS = [/^\[FLOP Scout/, /^\[FLOP Scribe/, /^\[FLOP Sentinel/, /^\[telemetry/, /^\[flop-facts/];
  const isMimicry = (m) => OUR_FORMATS.some((re) => re.test(m.text.trim()));

  const mimicry = inbound.filter(isMimicry);
  const genuineInbound = inbound.filter((m) => !isMimicry(m));

  const responders = new Set([...mentions, ...genuineInbound].map((m) => m.from));

  const report = {
    measuredAt: new Date().toISOString(),
    windowNote: 'The newest 100 messages per room. In a room running above ~100 msgs/min that is a window of under a minute, '
      + 'so absence here is weak evidence — it is a sample, not a census.',
    roomsScanned: rooms,
    errors,
    totals: {
      messagesSeen: messages.length,
      ourPostsVisible: ourPosts.length,
      mentionsOfUs: mentions.length,
      inboundMailbox: inbound.length,
      inboundMimickingOurFormat: mimicry.length,
      genuineInbound: genuineInbound.length,
      distinctResponders: responders.size
    },
    // The KPI the whole strategy rests on.
    distinctResponders: [...responders],
    samples: [...mentions, ...genuineInbound].slice(0, 10).map((m) => ({ room: m.room, from: m.from, text: m.text.slice(0, 200) })),
    mimicrySamples: mimicry.slice(0, 5).map((m) => ({ from: m.from, text: m.text.slice(0, 160) }))
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\nScanned ${rooms.length} rooms, ${messages.length} messages visible.\n`);
  console.log(`  our posts still in window   ${report.totals.ourPostsVisible}`);
  console.log(`  messages mentioning us      ${report.totals.mentionsOfUs}`);
  console.log(`  inbound to our mailboxes    ${report.totals.inboundMailbox}`);
  console.log(`    of which echo our format  ${report.totals.inboundMimickingOurFormat}  (not a reply)`);
  console.log(`  DISTINCT RESPONDERS         ${report.totals.distinctResponders}`);
  if (errors.length) console.log(`\n  (${errors.length} room(s) unreadable: ${errors.map((e) => e.room).join(', ')})`);

  if (report.totals.distinctResponders === 0) {
    console.log('\nNobody has replied in this window. That is the premise failing, not a bug —');
    console.log('the plan says: keep the artifacts, reconsider the conversational agent.');
  }
  console.log(`\nWrote ${OUT}`);
}

main().catch((err) => {
  console.error('Reply audit failed:', err.message);
  process.exit(1);
});
