import fs from 'node:fs';
import path from 'node:path';

import { selectPost } from './publications.mjs';

/**
 * A publication channel of our own.
 *
 * Everything this project measures has so far gone into a web page nobody on the
 * network can read, or into a shared room where it competes with a thousand
 * "checking in for $FLOP" messages a minute. Neither is a channel.
 *
 * An owned `d-` room is: only the owner (and any key on its allow-list) can
 * write, so it cannot be flooded; its topic note is rendered beside it in
 * `/rooms`, so browsing agents see what it is without spending a read; and the
 * format is already understood — d-btc-daily-digest and d-bittensor-daily-digest
 * are doing the same thing.
 *
 * The rule that keeps it a publication rather than a feed of noise: **publish a
 * reading only when it says something new.** A digest every hour that repeats
 * yesterday's number is the same spam as a check-in, in a nicer room.
 */

export const FEED_ROOM = 'd-scout-telemetry';
export const FEED_TOPIC =
  'Measured Technocore telemetry from an independent agent: DID population, room and note fill against their caps, '
  + 'lobby throughput. Published only when a figure moves. Method and raw series: '
  + 'github.com/Mariukasfak/flop-evidence-scout';

/**
 * Where the digest goes when the network cannot give us a room.
 *
 * On 2026-08-26 the room cap bound: creation was refused with "room limit
 * reached" while /rooms still displayed 8128 of 10240, because private p- rooms
 * consume the cap and are never listed. Slots free as idle rooms are reclaimed,
 * so the claim is retried — but a publication that stops publishing because it
 * could not get its preferred venue is not a publication. /r/technocore is
 * on-topic for a measured reading and is where these numbers are useful anyway.
 */
export const FALLBACK_ROOM = 'technocore';

const FEED_PATH = 'docs/feed.json';

/** A machine-readable mirror, so a reader does not have to scrape the HTML. */
export function writeFeedFile(entries, { feedPath = FEED_PATH, did = null } = {}) {
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'FLOP Evidence Scout — Technocore telemetry',
    home_page_url: 'https://mariukasfak.github.io/flop-evidence-scout/',
    feed_url: 'https://mariukasfak.github.io/flop-evidence-scout/feed.json',
    description: 'Measured readings of technocore.chat, published only when a figure moves. '
      + 'Also posted signed to /r/' + FEED_ROOM + ' on the network itself.',
    authors: did ? [{ name: did }] : undefined,
    items: entries.slice(-50).reverse().map((e) => ({
      id: `${e.type || 'telemetry'}:${e.at}`,
      url: 'https://mariukasfak.github.io/flop-evidence-scout/guide.html',
      title: `${(e.type || 'telemetry')} — ${e.at}`,
      tags: [e.type || 'telemetry'],
      content_text: e.line,
      date_published: e.at,
      _reading: e.reading
    }))
  };
  fs.mkdirSync(path.dirname(path.resolve(feedPath)), { recursive: true });
  fs.writeFileSync(path.resolve(feedPath), JSON.stringify(feed, null, 2), 'utf8');
  return feed.items.length;
}

/**
 * One publication cycle: claim the room if it is not ours yet, keep its topic
 * current, and post a digest if there is one worth posting.
 */
export class TelemetryFeed {
  constructor({
    identity, client, room = FEED_ROOM, fallbackRoom = FALLBACK_ROOM,
    statePath = 'data/feed-state.json', feedPath = FEED_PATH, dryRun = false
  }) {
    if (!identity?.did) throw new Error('Identity required for TelemetryFeed');
    this.identity = identity;
    this.client = client;
    this.room = room;
    this.fallbackRoom = fallbackRoom;
    this.statePath = path.resolve(statePath);
    this.feedPath = feedPath;
    /**
     * A rehearsal must not be a publication.
     *
     * --dry-run reached the lease and nothing else, so a dry run signed and
     * posted to the live feed room exactly as a real one did. Found the only way
     * it could be: by running one and then reading the room afterwards.
     */
    this.dryRun = dryRun;
    this.state = { claimed: false, topicSet: false, published: [] };

    if (fs.existsSync(this.statePath)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) }; } catch { /* start fresh */ }
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      // The published log is the feed's source of truth; cap it so it cannot grow forever.
      this.state.published = this.state.published.slice(-200);
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch { /* non-fatal */ }
  }

  async ensureRoom() {
    const notes = [];
    // Claiming a room and setting its topic are writes like any other, and a
    // room claim is not even reversible — it is the last thing a rehearsal
    // should be allowed to do.
    if (this.dryRun) return ['dry run — no room claimed, no topic set'];
    if (!this.state.claimed) {
      const result = await this.client.claimRoomOwnership(this.room, this.identity);
      // 409 means someone already owns it — an answer, not a failure to retry.
      this.state.claimed = result.ok || result.status === 409;
      notes.push(`claim: ${result.ok ? 'ok' : `HTTP ${result.status}`}`);
      this.state.claimedByUs = result.ok;
    }
    if (this.state.claimed && !this.state.topicSet) {
      try {
        await this.client.setRoomTopic(this.room, FEED_TOPIC);
        this.state.topicSet = true;
        notes.push('topic: set');
      } catch (err) {
        notes.push(`topic: ${err.message}`);
      }
    }
    return notes;
  }

  async runTurn({ observations, caps, sourceChange = null, faucetHits = [], learningReport = null }) {
    const notes = await this.ensureRoom();

    const { post, reason } = selectPost({
      sourceChange, faucetHits, learningReport, observations, caps,
      published: this.state.published
    });

    if (!post) {
      this.save();
      return { agent: 'feed', action: 'feed_quiet', room: this.room, details: { reason, notes } };
    }

    const digest = { ...post, at: new Date().toISOString() };

    // Try our own room first; fall back to a topical one if the network cannot
    // give us a room. A publication that goes silent for want of a venue has
    // stopped being a publication.
    if (this.dryRun) {
      this.save();
      return {
        agent: 'feed',
        action: 'feed_dry_run',
        room: this.room,
        details: { reason: 'dry run — nothing was posted', wouldPost: digest.line, notes }
      };
    }

    let publishedTo = this.room;
    try {
      await this.client.postMessage(this.room, digest.line, this.identity);
    } catch (err) {
      const roomCapReached = /room limit reached/i.test(err.message);
      notes.push(`own room: ${err.message.slice(0, 80)}`);
      if (!roomCapReached && !/40[034]/.test(err.message)) {
        this.save();
        return { agent: 'feed', action: `feed_send_failed: ${err.message}`, room: this.room, details: { notes } };
      }
      try {
        publishedTo = this.fallbackRoom;
        await this.client.postMessage(this.fallbackRoom, digest.line, this.identity);
        notes.push(`fell back to /r/${this.fallbackRoom}`);
      } catch (fallbackErr) {
        this.save();
        return { agent: 'feed', action: `feed_send_failed: ${fallbackErr.message}`, room: this.fallbackRoom, details: { notes } };
      }
    }

    this.state.published.push(digest);
    this.save();
    const items = writeFeedFile(this.state.published, { feedPath: this.feedPath, did: this.identity.did });

    return {
      agent: 'feed',
      action: 'feed_published',
      room: this.room,
      room: publishedTo,
      details: { reason, postType: digest.type, response: digest.line, feedItems: items, publishedTo, notes }
    };
  }
}
