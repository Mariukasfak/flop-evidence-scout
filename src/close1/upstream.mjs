/**
 * Watch the official close-1 repository for anything that changes what we
 * pinned — new commits on main, a manifest that no longer hashes to ours, the
 * package leaving `draft`, a signed launch record appearing — and a short list
 * of upstream issues whose answers change what our evidence means.
 *
 * Alerts are for substance, not traffic. A watched issue alerts when a FLOP
 * Labs maintainer (`sv`, or an OWNER/MEMBER of the org) comments, or when its
 * state changes; community comments are recorded, never sent. The archive's
 * own publication and freshness are alerted by archive.mjs, not here.
 *
 * `observeUpstream` fetches (a few GitHub API reads a run, comments only when
 * a count moved); `upstreamAlerts` is pure and compares two observations. The
 * repos are read as data — nothing in them is executed or obeyed.
 */
import crypto from 'node:crypto';
import { MAINTAINER, communityLabel, groupOf, dedupeGroupedAlerts, observeHeads, headAlerts, observeMentions, mentionAlerts } from './flop-watch.mjs';

export const REPO = 'flop-labs/technocore-close-call-challenge';
const YP = 'flop-labs/yellowpaper';

/**
 * Why each issue is watched (2026-09-28). P2 entries are research only: close-1
 * is not an HTLC/TCLK settlement protocol, and nothing here changes execution.
 */
export const WATCHED = Object.freeze([
  { repo: REPO, n: 6, priority: 'HIGH', topic: 'close-1 rules' },
  { repo: REPO, n: 8, priority: 'HIGH', topic: 'pnl ties are one tie (Rule 18)' },
  { repo: REPO, n: 9, priority: 'HIGH', topic: 'Rule 11: last reference stands' },
  { repo: REPO, n: 10, priority: 'HIGH', topic: 'mint flow / named-taker test' },
  { repo: REPO, n: 12, priority: 'HIGH', topic: 'per-sweep archive published' },
  { repo: REPO, n: 15, priority: 'HIGH', topic: 'archive lag; owner proof by room listing' },
  { repo: REPO, n: 17, priority: 'HIGH', topic: 'close-1' },
  { repo: REPO, n: 25, priority: 'HIGH', topic: 'archive stalled a second time at 1119 (same topic as #15)' },
  // Community findings (lastbubble2035, pepedesigner; read 2026-09-30). Every statement below is [COMMUNITY] until a maintainer confirms it.
  { repo: REPO, n: 21, priority: 'MEDIUM', topic: 'redacted archive authentication / unsigned index binding',
    summary: 'COMMUNITY: the sha256 of the served redacted bytes already exists per entry in index.json (README documents it), so integrity of the 1023 redacted records is checkable today; the remaining gap is that index.json itself is unsigned, so nothing binds it to the referee. Suggested fix: a referee signature over index.json.' },
  { repo: REPO, n: 22, priority: 'MEDIUM', topic: 'state-root construction / per-key proofs',
    summary: 'COMMUNITY: the construction of the signed state root is not documented and not reproducible from published data (asked of @sv, unanswered). Replay findings: public-room data up to the archive watermark appears auditable without per-key proofs; private-room trades and unpublished sweeps remain the main gap.' },
  { repo: YP, n: 32, priority: 'HIGH', topic: 'E.40 agent airdrop: work-settled vs escrow-settled' },
  { repo: YP, n: 31, priority: 'HIGH', topic: 'E.38/E.40 account unit' },
  { repo: YP, n: 76, priority: 'HIGH', topic: 'E.38 conversion evidence path' },
  { repo: YP, n: 71, priority: 'P2', topic: 'HTLC settlement amount (watch only)' },
  { repo: 'flop-labs/flop-core', n: 1796, priority: 'P2', topic: 'HTLC amount decision (watch only)' },
  { repo: 'flop-labs/flop-core', n: 1907, priority: 'P2', topic: 'HTLC conformance (watch only)' },
  { repo: 'flop-labs/technocore-chat', n: 937, priority: 'P2', topic: 'async signing identity fix (watch only)' }
]);
/** New yellowpaper issues naming these decisions join the watch on their own. */
export const TITLE_WATCH = Object.freeze({ repo: YP, pattern: /\bE\.(38|40|44|48)\b/, priority: 'HIGH', topic: 'airdrop / money-path decision E.38/E.40/E.44/E.48' });
export const MAINTAINERS = new Set(['sv']);
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER']);
const SUBSTANTIVE_CHARS = 40;
/**
 * close-call #15 is where we asked about the stopped archive (2026-09-28). A
 * maintainer answer there is tagged with what it seems to settle, so the
 * operator sees at once whether it names a backfill, a cadence, a lookup,
 * copy provenance, a signed binding or a date before the lock.
 */
export const ARCHIVE_ISSUE = `${REPO}#15`;
export const ARCHIVE_ANSWER_TOPICS = Object.freeze([
  ['backfill', /backfill|resum|catch(?:es|ing)? up|republish|after 766|missing sweeps/i],
  ['cadence', /cadence|hourly|daily|schedule|interval|every \d+/i],
  ['per-owner/per-trade lookup', /lookup|per[- ]owner|per[- ]trade|endpoint|query/i],
  ['copy provenance', /provenance|which copy|countersign/i],
  ['signed binding', /signed|signature|bind|attest/i],
  ['before the lock', /\block\b|10-04|oct(?:ober)? 4/i]
]);
/** Our own comments are not news, and a community comment is logged unless it claims an integrity problem. */
const OUR_LOGINS = new Set(['mariukasfak']);
const INTEGRITY_CLAIM = /mismatch|does(?:n't| not) match|tamper|altered|inconsisten/i;
/** "zero mismatches" reports a clean check; it is a reproduction, not an integrity contradiction. */
const NO_PROBLEM = /\b(?:zero|no|0|without)\s+(?:unexplained\s+)?(?:mismatch(?:es)?|differences?|inconsisten\w*)/gi;
/** Issues outside the two listed repos cost a request each; without a token the budget is 60 an hour. */
const SINGLE_FETCH_EVERY_MS = 3600_000;
/** A file whose name suggests a launch record or a detached signature. */
const LAUNCH_FILE = /(launch|seed|attest|signature|\.sig$|\.asc$|\.minisig$)/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const watchKey = (repo, n) => `${repo}#${n}`;
/**
 * A FLOP maintainer is an OWNER/MEMBER of the org, or a named maintainer (`sv`) who is ALSO shown to
 * publish to the official repo's main (`committers`). A name alone is never enough: with
 * author_association=NONE and no commit history there, the comment is [COMMUNITY].
 * (`sv` reads CONTRIBUTOR/NONE in comments but authors every official commit, so committers proves it.)
 */
export const isMaintainer = (c, committers = null) => {
  if (MAINTAINER_ASSOC.has(c?.association)) return true;
  if (!MAINTAINERS.has(c?.author)) return false;
  const has = Array.isArray(committers) ? committers.includes(c.author) : Boolean(committers?.has?.(c.author));
  return c.association == null || has;
};

/**
 * GitHub, spent carefully. The VPS has no token (2026-09-29): 60 requests an
 * hour, shared with everything else on that address, and one afternoon of
 * dry runs used all of it. So every read goes through one client that
 *   - sends If-None-Match with the ETag of the last answer; a 304 costs no quota,
 *   - remembers X-RateLimit-Remaining / -Reset and makes NO request while the
 *     remaining budget is at the reserve or after a 403/429, until the reset,
 *   - uses GITHUB_TOKEN when one is set, and works without it.
 * Being rate-limited makes the watcher DEGRADED (BLIND after hours without a
 * success); it is never a close-1 trading failure.
 */
export const RESERVE_REQUESTS = 5;
export const WATCH_EVERY_MS = 30 * 60_000;
export const BLIND_AFTER_MS = 3 * 3600_000;

export class RateLimited extends Error {
  constructor(until) { super(`GitHub rate limit: no requests until ${until}`); this.until = until; }
}

/** Keep only what the watcher reads, so the ETag cache stays small. */
function slim(v, depth = 0) {
  if (Array.isArray(v)) return v.map((x) => slim(x, depth + 1));
  if (!v || typeof v !== 'object') return typeof v === 'string' && v.length > 600 ? v.slice(0, 600) : v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (['reactions', 'labels', 'assignees', 'assignee', 'milestone', 'performed_via_github_app', 'timeline_url', 'events_url', 'repository_url', 'labels_url', 'comments_url', 'html_url', 'node_id', 'closed_by', 'sub_issues_summary', 'issue_dependencies_summary'].includes(k)) continue;
    if (k === 'user') { out.user = { login: x?.login ?? null }; continue; }
    out[k] = depth > 3 ? x : slim(x, depth + 1);
  }
  return out;
}

export function makeGitHub({ fetchFn = fetch, env = process.env, nowMs = Date.now(), state = null, cache = {} }) {
  const s = { limit: state?.limit ?? null, remaining: state?.remaining ?? null, reset_at: state?.reset_at ?? null, blocked_until: state?.blocked_until ?? null, requests: 0, not_modified: 0 };
  const etags = { ...cache };
  const until = () => {
    if (s.blocked_until && Date.parse(s.blocked_until) > nowMs) return s.blocked_until;
    if (s.remaining != null && s.remaining <= RESERVE_REQUESTS && s.reset_at && Date.parse(s.reset_at) > nowMs) return s.reset_at;
    return null;
  };
  const note = (r) => {
    const h = (k) => r.headers?.get?.(k) ?? null;
    if (h('x-ratelimit-remaining') != null) s.remaining = Number(h('x-ratelimit-remaining'));
    if (h('x-ratelimit-limit') != null) s.limit = Number(h('x-ratelimit-limit'));
    if (h('x-ratelimit-reset') != null) s.reset_at = new Date(Number(h('x-ratelimit-reset')) * 1000).toISOString();
    if (r.status === 429 || (r.status === 403 && (s.remaining === 0 || h('retry-after')))) {
      const retry = h('retry-after') ? new Date(nowMs + Number(h('retry-after')) * 1000).toISOString() : null;
      s.blocked_until = retry ?? s.reset_at ?? new Date(nowMs + 3600_000).toISOString();
      throw new RateLimited(s.blocked_until);
    }
  };
  async function get(url, { json = true, allow404 = false } = {}) {
    const wait = until();
    if (wait) throw new RateLimited(wait);
    const headers = { 'user-agent': 'FLOP-Evidence-Scout/1.0' };
    if (json) headers.accept = 'application/vnd.github+json';
    if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const cached = etags[url];
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    s.requests += 1;
    const r = await fetchFn(url, { headers });
    note(r);
    if (r.status === 304 && cached) { s.not_modified += 1; return cached.data; }
    if (allow404 && (r.status === 404 || r.status === 403)) return null;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const data = json ? slim(await r.json()) : await r.text();
    const etag = r.headers?.get?.('etag') ?? null;
    if (etag) etags[url] = { etag, data };
    return data;
  }
  return {
    json: (url, opts) => get(url, { ...opts, json: true }),
    text: (url) => get(url, { json: false }),
    blockedUntil: until,
    /** The watcher's state after this run, for the snapshot and the next run. */
    finish(ok, err = null, prevState = null) {
      const lastSuccess = ok ? new Date(nowMs).toISOString() : (prevState?.last_success ?? null);
      const status = ok ? 'OK' : (!lastSuccess || nowMs - Date.parse(lastSuccess) > BLIND_AFTER_MS ? 'BLIND' : 'DEGRADED');
      return {
        status, authenticated: Boolean(env.GITHUB_TOKEN), limit: s.limit, remaining: s.remaining, reset_at: s.reset_at,
        blocked_until: until(), last_success: lastSuccess, last_attempt: new Date(nowMs).toISOString(),
        last_error: ok ? null : String(err?.message ?? err).slice(0, 200), requests_last_run: s.requests, not_modified_last_run: s.not_modified
      };
    },
    etags
  };
}

/** Degraded state without a request: what the snapshot shows while we wait out a reset. */
export function githubStateWhileWaiting(prevState, nowMs) {
  const lastSuccess = prevState?.last_success ?? null;
  const blind = !lastSuccess || nowMs - Date.parse(lastSuccess) > BLIND_AFTER_MS;
  return { ...(prevState || {}), status: prevState?.status === 'OK' ? 'OK' : blind ? 'BLIND' : 'DEGRADED', requests_last_run: 0, not_modified_last_run: 0 };
}

/**
 * One watcher turn: at most every WATCH_EVERY_MS, never while blocked, never
 * throwing. Returns the observation to keep and the alerts it justifies.
 */
export async function watchUpstream({ prev = null, fetchFn = fetch, nowMs = Date.now(), env = process.env, pinned, everyMs = WATCH_EVERY_MS }) {
  // An observation written before this watcher kept its own state was a success at prev.at.
  const g0 = prev?.github ?? (prev?.at ? { status: 'OK', last_success: prev.at, last_attempt: prev.at } : null);
  const lastAttempt = g0?.last_attempt ?? prev?.at ?? null;
  const blocked = [g0?.blocked_until, g0?.remaining != null && g0.remaining <= RESERVE_REQUESTS ? g0.reset_at : null]
    .filter((t) => t && Date.parse(t) > nowMs)[0];
  if (blocked) return { obs: { ...prev, github: githubStateWhileWaiting(g0, nowMs) }, notes: [], ran: false, why: `rate limited until ${blocked}` };
  if (prev && lastAttempt && nowMs - Date.parse(lastAttempt) < everyMs) return { obs: prev.github ? prev : { ...prev, github: g0 }, notes: [], ran: false, why: 'not due' };
  const gh = makeGitHub({ fetchFn, env, nowMs, state: g0, cache: prev?.httpCache ?? {} });
  try {
    const obs = await observeUpstream({ prev, gh, nowMs });
    // Merged changes and @Mariukasfak interaction: read after the main observation, and never able to fail it.
    // Search has its own (smaller) rate-limit bucket and its headers overwrite the shared counters, so it goes first:
    // the last response of a run then belongs to the core API whose budget we actually track.
    obs.mentions = await observeMentions({ prev: prev?.mentions, gh, isMaintainer: (c) => isMaintainer(c, obs.committers), nowMs });
    obs.heads = await observeHeads({ prev: prev?.heads, gh, nowMs });
    obs.httpCache = gh.etags;
    obs.github = gh.finish(true, null, g0);
    const raw = [...upstreamAlerts(prev, obs, pinned), ...communityNotes(prev, obs), ...headAlerts(prev?.heads, obs.heads), ...mentionAlerts(prev?.mentions, obs.mentions)];
    const { notes, digests } = dedupeGroupedAlerts(raw, prev?.alertDigests);
    obs.alertDigests = digests;
    return { obs, notes, ran: true };
  } catch (err) {
    // Keep the last good observation; only the watcher's own state moves.
    return { obs: { ...(prev || {}), httpCache: gh.etags, github: gh.finish(false, err, g0) }, notes: [], ran: true, error: String(err.message).slice(0, 200) };
  }
}

const slimIssue = (i) => ({ title: String(i.title).slice(0, 120), state: i.state, comments: i.comments, updated: i.updated_at, author: i.user?.login ?? null, association: i.author_association ?? null });

/** One observation of the repo and the watched issues, reusing `prev` for anything unchanged. */
export async function observeUpstream({ prev = null, gh = null, fetchFn = fetch, nowMs = Date.now(), env = process.env }) {
  gh ||= makeGitHub({ fetchFn, env, nowMs, state: prev?.github, cache: prev?.httpCache ?? {} });
  const api = 'https://api.github.com/repos';
  const tree = await gh.json(`${api}/${REPO}/git/trees/main?recursive=1`);
  const files = Object.fromEntries((tree.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const obs = { at: new Date(nowMs).toISOString(), treeSha: tree.sha, files };
  if (prev && prev.treeSha === tree.sha) {
    Object.assign(obs, { manifestSha256: prev.manifestSha256, manifestStatus: prev.manifestStatus, rulesVersion: prev.rulesVersion, headCommit: prev.headCommit });
  } else {
    const raw = `https://raw.githubusercontent.com/${REPO}/main`;
    const manifest = await gh.text(`${raw}/manifest.json`);
    const contest = JSON.parse(await gh.text(`${raw}/contest.json`));
    const commits = await gh.json(`${api}/${REPO}/commits?per_page=1`);
    Object.assign(obs, {
      manifestSha256: sha256(manifest),
      manifestStatus: JSON.parse(manifest).status ?? null,
      rulesVersion: contest.rules_version ?? null,
      headCommit: commits[0] ? { sha: commits[0].sha.slice(0, 10), title: commits[0].commit.message.split('\n')[0].slice(0, 100) } : null
    });
  }
  // Who publishes to the official main: the evidence that a named maintainer is one.
  const committers = new Set(prev?.committers || []);
  try { for (const c of (await gh.json(`${api}/${REPO}/commits?per_page=30`)) || []) if (c?.author?.login) committers.add(c.author.login); } catch (err) { if (err instanceof RateLimited) throw err; }
  obs.committers = [...committers];
  const issues = await gh.json(`${api}/${REPO}/issues?state=all&per_page=50&sort=updated`);
  obs.issues = Object.fromEntries(issues.map((i) => [i.number, slimIssue(i)]));
  const known = new Map(issues.map((i) => [watchKey(REPO, i.number), i]));
  let ypIssues = [];
  try { ypIssues = await gh.json(`${api}/${YP}/issues?state=all&per_page=50&sort=updated`) || []; } catch (err) { if (err instanceof RateLimited) throw err; ypIssues = []; }
  for (const i of ypIssues) known.set(watchKey(YP, i.number), i);

  const list = [...WATCHED];
  // Title-matched issues stay watched once found, even after they drop out of the recent-issues page.
  for (const w of Object.values(prev?.watched || {})) if (w.byTitle && !list.some((x) => x.repo === w.repo && x.n === w.n)) list.push({ repo: w.repo, n: w.n, priority: w.priority, topic: w.topic, byTitle: true });
  for (const i of ypIssues) {
    if (!i.pull_request && TITLE_WATCH.pattern.test(i.title) && !list.some((w) => w.repo === YP && w.n === i.number)) {
      list.push({ repo: YP, n: i.number, priority: TITLE_WATCH.priority, topic: TITLE_WATCH.topic, byTitle: true });
    }
  }
  obs.watched = {};
  for (const w of list) {
    const key = watchKey(w.repo, w.n);
    const before = prev?.watched?.[key];
    let now = known.get(key);
    if (!now && before?.checkedAt && nowMs - Date.parse(before.checkedAt) < SINGLE_FETCH_EVERY_MS) { obs.watched[key] = before; continue; }
    const single = !now;
    if (!now) {
      try { now = await gh.json(`${api}/${w.repo}/issues/${w.n}`, { allow404: true }); } catch (err) { if (err instanceof RateLimited) throw err; now = undefined; }
      if (now === null) { obs.watched[key] = { ...w, unavailable: true, checkedAt: obs.at }; continue; }   // private or gone: not an error
      if (!now) { if (before) obs.watched[key] = before; continue; }
    }
    const entry = { ...w, title: String(now.title).slice(0, 120), state: now.state, comments: now.comments, isPr: Boolean(now.pull_request), ...(single ? { checkedAt: obs.at } : {}) };
    if (before && !before.unavailable && before.comments === now.comments && before.state === now.state) {
      obs.watched[key] = { ...entry, lastCommentId: before.lastCommentId, maintainer: before.maintainer || [] };
      continue;
    }
    const page = Math.max(1, Math.ceil((now.comments || 0) / 100));
    const comments = now.comments ? (await gh.json(`${api}/${w.repo}/issues/${w.n}/comments?per_page=100&page=${page}`)) || [] : [];
    const slim = comments.map((c) => ({ id: c.id, author: c.user?.login ?? null, association: c.author_association ?? null, at: c.created_at, text: String(c.body ?? '').slice(0, 600) }));
    obs.watched[key] = {
      ...entry,
      lastCommentId: slim.length ? Math.max(...slim.map((c) => c.id)) : (before?.lastCommentId ?? 0),
      newSince: before && !before.unavailable ? slim.filter((c) => c.id > (before.lastCommentId ?? 0)) : [],
      maintainer: slim.filter((c) => isMaintainer(c, committers)).slice(-3),
      baseline: !before || Boolean(before.unavailable)
    };
  }
  return obs;
}

/**
 * Alerts for what changed. `pinned` = { packageSha256, packageCommit }.
 * The first observation alerts only on standing conditions that differ from
 * what we pinned; after that, on substantive changes only.
 */
export function upstreamAlerts(prev, next, pinned) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (next.manifestSha256 && next.manifestSha256 !== pinned.packageSha256 && next.manifestSha256 !== prev?.manifestSha256) {
    add('package_changed_upstream', `close-1 repo main now has manifest ${next.manifestSha256.slice(0, 12)}…, not our pinned ${pinned.packageSha256.slice(0, 12)}… — the contest rules may have changed`);
  }
  if (next.manifestStatus && next.manifestStatus !== 'draft' && next.manifestStatus !== prev?.manifestStatus) {
    add('package_not_draft', `close-1 package status is now "${next.manifestStatus}" (was draft)`);
  }
  if (next.rulesVersion && !/draft/i.test(next.rulesVersion) && next.rulesVersion !== prev?.rulesVersion) {
    add('rules_version_final', `close-1 rules_version is now "${next.rulesVersion}"`);
  }
  const launch = Object.keys(next.files || {}).filter((p) => LAUNCH_FILE.test(p) && !(prev?.files && p in prev.files));
  if (launch.length) add('launch_record_published', `close-1 repo has new file(s) that may be a signed launch record: ${launch.join(', ')}`);
  if (prev && prev.treeSha !== next.treeSha) {
    const changed = Object.keys({ ...prev.files, ...next.files }).filter((p) => prev.files?.[p] !== next.files?.[p]);
    add('rules_repo_changed', `close-1 repo main changed (${next.headCommit?.sha ?? '?'} ${next.headCommit?.title ?? ''}): ${changed.slice(0, 8).join(', ')}`);
  }
  if (!prev) return out;
  // A previous observation keyed the old way (by bare number) is a baseline for the new watch list.
  const comparable = Object.keys(prev.watched || {}).some((k) => k.includes('#'));
  for (const [key, w] of Object.entries(next.watched || {})) {
    const before = prev.watched?.[key];
    if (!before) {
      if (w.byTitle && comparable) add('new_watched_issue', `${w.priority} ${key} joined the watch list (names ${w.topic}): "${w.title}"`);
      continue;
    }
    if (w.unavailable || before.unavailable) continue;
    for (const c of w.newSince || []) {
      if (!isMaintainer(c, next.committers) || c.text.replace(/\s+/g, ' ').trim().length < SUBSTANTIVE_CHARS) continue;
      const tags = groupOf(key) === 'CLOSE1_ARCHIVE_PUBLICATION' ? ARCHIVE_ANSWER_TOPICS.filter(([, re]) => re.test(c.text)).map(([t]) => t) : [];
      out.push({ kind: 'maintainer_reply', key, body: c.text, text: `${MAINTAINER} ${w.priority} ${key} (${w.topic}): ${c.author} wrote${tags.length ? ` [mentions: ${tags.join(', ')}]` : ''}: ${c.text.replace(/\s+/g, ' ').slice(0, 280)}` });
    }
    if (w.state !== before.state) add('watched_issue_state', `${w.priority} ${key} (${w.topic}) is now ${w.state}`);
  }
  for (const [n, i] of Object.entries(next.issues || {})) {
    if (!prev.issues?.[n] && isMaintainer(i, next.committers)) add('new_issue', `close-1 repo: new issue #${n} by ${i.author} "${i.title}"`);
  }
  return out;
}

/**
 * Community comments on the close-call issues: written to the alert log, not
 * sent (logOnly), unless one claims a concrete integrity problem.
 */
export function communityNotes(prev, next) {
  const out = [];
  if (!prev) return out;
  for (const [key, w] of Object.entries(next.watched || {})) {
    if (w.repo !== REPO || !prev.watched?.[key] || w.unavailable || prev.watched[key].unavailable) continue;
    for (const c of w.newSince || []) {
      const text = c.text.replace(/\s+/g, ' ').trim();
      if (isMaintainer(c, next.committers) || OUR_LOGINS.has(String(c.author).toLowerCase()) || text.length < SUBSTANTIVE_CHARS) continue;
      const claim = INTEGRITY_CLAIM.test(text.replace(NO_PROBLEM, ' '));
      out.push({ kind: claim ? 'community_integrity_claim' : 'community_comment', logOnly: !claim, key, body: text, text: `${communityLabel(text)} ${key}: ${c.author} wrote: ${text.slice(0, 280)}` });
    }
  }
  return out;
}
