/**
 * Publishing to X, under the same discipline as everything else here.
 *
 * The operator asked for this and it is the riskiest surface the project has.
 * Every other channel we write to is a room agents read; X is a human timeline
 * carrying the operator's own name. A bot posting filler there costs something
 * that cannot be earned back, and the whole argument of this project is that we
 * are the ones not doing that.
 *
 * So the rules are stricter than the room feed's, not looser:
 *
 *   NOTHING ON A TIMER      A post exists because a fact changed, never because
 *                           an interval elapsed. No new fact, no post.
 *   ONE A DAY, AT MOST      A hard ceiling far below the API's. If we ever have
 *                           more than one thing a day worth saying, the extra
 *                           can wait; if we never do, that is the honest answer.
 *   NEVER TWICE             Each post is keyed by content, and a key that has
 *                           been used is never posted again.
 *   DRY RUN BY DEFAULT      Nothing reaches X until credentials exist AND the
 *                           caller asks for a live run. Reading what it would
 *                           have said costs nothing and is the normal mode.
 *
 * What it publishes is the thing nobody else does: claims we have REFUTED, with
 * the source. "Here is a widely repeated FLOP claim, here is why it is wrong,
 * here is where to check" is worth a stranger's attention. "gm, still building"
 * is not, and this file cannot produce it.
 */

import crypto from 'node:crypto';
import { xCopyFor } from './x-copy.mjs';
import fs from 'node:fs';

/** X's limit. Nothing here composes near it — brevity is not a constraint, it is the point. */
export const MAX_POST_CHARS = 280;

/** A ceiling chosen against the audience, not the API. */
export const MAX_POSTS_PER_DAY = 1;

const REPO = 'github.com/Mariukasfak/flop-evidence-scout';

/**
 * Credentials, or null.
 *
 * X needs OAuth 1.0a user context to post — four values, all of them secrets.
 * They live in .secrets/ beside the identities, which is gitignored, and this
 * module never logs one, never puts one in an error message, and never returns
 * one to a caller.
 */
export function loadXConfig({ env = process.env, secretsPath = '.secrets/x-api.json' } = {}) {
  const fromEnv = {
    appKey: env.X_APP_KEY,
    appSecret: env.X_APP_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET
  };
  if (Object.values(fromEnv).every(Boolean)) return { ...fromEnv, source: 'environment' };

  try {
    const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    const keys = ['appKey', 'appSecret', 'accessToken', 'accessSecret'];
    if (keys.every((k) => typeof parsed?.[k] === 'string' && parsed[k].length > 0)) {
      return { ...Object.fromEntries(keys.map((k) => [k, parsed[k]])), source: secretsPath };
    }
  } catch { /* absent or malformed both mean "not configured" */ }

  return null;
}

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * OAuth 1.0a signature, by hand.
 *
 * This project has no dependencies and adding one to post a tweet would be a
 * poor trade: an npm package in the path of the operator's credentials is a
 * supply-chain risk taken for about forty lines of HMAC.
 */
export function signOAuth({ method, url, params = {}, config, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: config.appKey,
    oauth_nonce: nonce ?? crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: config.accessToken,
    oauth_version: '1.0'
  };

  // Signature base: every parameter, percent-encoded, sorted, joined — the order
  // is part of the signature, so a Map would not do.
  const all = { ...params, ...oauth };
  const base = Object.keys(all).sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join('&');
  const signatureBase = `${method.toUpperCase()}&${pct(url)}&${pct(base)}`;
  const signingKey = `${pct(config.appSecret)}&${pct(config.accessSecret)}`;

  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  return {
    header: 'OAuth ' + Object.keys(oauth).sort()
      .map((k) => `${pct(k)}="${pct(oauth[k])}"`)
      .join(', '),
    signatureBase
  };
}

/**
 * The only kind of post this makes: a claim we checked and found false.
 *
 * Refutations are the one thing this project has that a timeline does not
 * already have twenty of. Each carries where to check, because a correction
 * nobody can verify is just another assertion.
 */
export function buildRefutationPost(fact) {
  if (!fact || fact.status !== 'REFUTED') return null;

  /**
   * Hand-written copy, or nothing.
   *
   * Assembling these from the board's fields produced six posts sharing one
   * opening line, two truncated mid-word, and one carrying a DID count that was
   * six and a half times out of date. See src/x-copy.mjs for the full reading.
   *
   * A refutation with no entry there cannot be posted. That is the point: a new
   * one reaches the status board immediately and the timeline only once someone
   * has written the sentence.
   */
  const written = xCopyFor(fact.id);
  if (!written) return null;
  if (written.length > MAX_POST_CHARS) return null;

  return {
    type: 'refutation',
    key: `refutation:${fact.id}`,
    text: written,
    chars: written.length
  };
}

/**
 * Decide whether to post anything at all. Usually not.
 *
 * `published` is the record of what has gone out. The daily ceiling and the
 * never-twice rule are both enforced here rather than at the call site, so a
 * caller cannot get them wrong.
 */
export function selectXPost({ facts = [], published = [], now = Date.now() } = {}) {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const recent = published.filter((p) => Date.parse(p.at) > dayAgo);
  if (recent.length >= MAX_POSTS_PER_DAY) {
    return { post: null, reason: `daily ceiling reached (${MAX_POSTS_PER_DAY})` };
  }

  const used = new Set(published.map((p) => p.key));
  for (const fact of facts) {
    const post = buildRefutationPost(fact);
    if (post && !used.has(post.key)) return { post, reason: 'a refutation not yet published' };
  }
  return { post: null, reason: 'nothing worth saying' };
}

/**
 * Post it, or say what would have been posted.
 *
 * `live` must be passed explicitly. A default that publishes is how an accident
 * becomes a timeline, and the operator's name is on this one.
 */
export async function publishToX(post, { config = loadXConfig(), live = false, fetchFn = fetch } = {}) {
  if (!post?.text) return { posted: false, reason: 'no post' };
  if (post.text.length > MAX_POST_CHARS) {
    return { posted: false, reason: `${post.text.length} characters, over the ${MAX_POST_CHARS} limit` };
  }
  if (!live) return { posted: false, dryRun: true, reason: 'dry run', wouldPost: post.text };
  if (!config) return { posted: false, reason: 'X is not configured — no credentials in .secrets/x-api.json' };

  const url = 'https://api.twitter.com/2/tweets';
  // v2 sends the text as a JSON body, which is NOT part of the OAuth signature.
  const { header } = signOAuth({ method: 'POST', url, params: {}, config });

  const res = await fetchFn(url, {
    method: 'POST',
    headers: { authorization: header, 'content-type': 'application/json' },
    body: JSON.stringify({ text: post.text }),
    signal: AbortSignal.timeout(20_000)
  });

  if (res.status === 429) return { posted: false, transient: true, reason: 'rate limited by X (429)' };
  if (!res.ok) {
    // Deliberately does not echo the response body: an auth error from X can
    // quote the token it rejected.
    return { posted: false, reason: `X refused the post (HTTP ${res.status})` };
  }

  const body = await res.json().catch(() => ({}));
  return { posted: true, id: body?.data?.id ?? null, chars: post.text.length };
}
