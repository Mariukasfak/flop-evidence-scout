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
  { repo: YP, n: 32, priority: 'HIGH', topic: 'E.40 agent airdrop: work-settled vs escrow-settled' },
  { repo: YP, n: 31, priority: 'HIGH', topic: 'E.38/E.40 account unit' },
  { repo: YP, n: 76, priority: 'HIGH', topic: 'E.38 conversion evidence path' },
  { repo: YP, n: 71, priority: 'P2', topic: 'HTLC settlement amount (watch only)' },
  { repo: 'flop-labs/flop-core', n: 1796, priority: 'P2', topic: 'HTLC amount decision (watch only)' },
  { repo: 'flop-labs/flop-core', n: 1907, priority: 'P2', topic: 'HTLC conformance (watch only)' },
  { repo: 'flop-labs/technocore-chat', n: 937, priority: 'P2', topic: 'async signing identity fix (watch only)' }
]);
/** New yellowpaper issues naming these decisions join the watch on their own. */
export const TITLE_WATCH = Object.freeze({ repo: YP, pattern: /\bE\.(38|40|44)\b/, priority: 'HIGH', topic: 'airdrop decision E.38/E.40/E.44' });
export const MAINTAINERS = new Set(['sv']);
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER']);
const SUBSTANTIVE_CHARS = 40;
/** Issues outside the two listed repos cost a request each; without a token the budget is 60 an hour. */
const SINGLE_FETCH_EVERY_MS = 3600_000;
/** A file whose name suggests a launch record or a detached signature. */
const LAUNCH_FILE = /(launch|seed|attest|signature|\.sig$|\.asc$|\.minisig$)/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const watchKey = (repo, n) => `${repo}#${n}`;
export const isMaintainer = (c) => MAINTAINERS.has(c?.author) || MAINTAINER_ASSOC.has(c?.association);

function headers(env, json = true) {
  const h = { 'user-agent': 'FLOP-Evidence-Scout/1.0' };
  if (json) h.accept = 'application/vnd.github+json';
  if (env.GITHUB_TOKEN) h.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}
async function getJson(fetchFn, url, env, { allow404 = false } = {}) {
  const r = await fetchFn(url, { headers: headers(env) });
  if (allow404 && (r.status === 404 || r.status === 403)) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getText(fetchFn, url, env) {
  const r = await fetchFn(url, { headers: headers(env, false) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}
const slimIssue = (i) => ({ title: String(i.title).slice(0, 120), state: i.state, comments: i.comments, updated: i.updated_at, author: i.user?.login ?? null, association: i.author_association ?? null });

/** One observation of the repo and the watched issues, reusing `prev` for anything unchanged. */
export async function observeUpstream({ prev = null, fetchFn = fetch, nowMs = Date.now(), env = process.env }) {
  const api = 'https://api.github.com/repos';
  const tree = await getJson(fetchFn, `${api}/${REPO}/git/trees/main?recursive=1`, env);
  const files = Object.fromEntries((tree.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const obs = { at: new Date(nowMs).toISOString(), treeSha: tree.sha, files };
  if (prev && prev.treeSha === tree.sha) {
    Object.assign(obs, { manifestSha256: prev.manifestSha256, manifestStatus: prev.manifestStatus, rulesVersion: prev.rulesVersion, headCommit: prev.headCommit });
  } else {
    const raw = `https://raw.githubusercontent.com/${REPO}/main`;
    const manifest = await getText(fetchFn, `${raw}/manifest.json`, env);
    const contest = JSON.parse(await getText(fetchFn, `${raw}/contest.json`, env));
    const commits = await getJson(fetchFn, `${api}/${REPO}/commits?per_page=1`, env);
    Object.assign(obs, {
      manifestSha256: sha256(manifest),
      manifestStatus: JSON.parse(manifest).status ?? null,
      rulesVersion: contest.rules_version ?? null,
      headCommit: commits[0] ? { sha: commits[0].sha.slice(0, 10), title: commits[0].commit.message.split('\n')[0].slice(0, 100) } : null
    });
  }
  const issues = await getJson(fetchFn, `${api}/${REPO}/issues?state=all&per_page=50&sort=updated`, env);
  obs.issues = Object.fromEntries(issues.map((i) => [i.number, slimIssue(i)]));
  const known = new Map(issues.map((i) => [watchKey(REPO, i.number), i]));
  let ypIssues = [];
  try { ypIssues = await getJson(fetchFn, `${api}/${YP}/issues?state=all&per_page=50&sort=updated`, env) || []; } catch { ypIssues = []; }
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
      try { now = await getJson(fetchFn, `${api}/${w.repo}/issues/${w.n}`, env, { allow404: true }); } catch { now = undefined; }
      if (now === null) { obs.watched[key] = { ...w, unavailable: true, checkedAt: obs.at }; continue; }   // private or gone: not an error
      if (!now) { if (before) obs.watched[key] = before; continue; }
    }
    const entry = { ...w, title: String(now.title).slice(0, 120), state: now.state, comments: now.comments, isPr: Boolean(now.pull_request), ...(single ? { checkedAt: obs.at } : {}) };
    if (before && !before.unavailable && before.comments === now.comments && before.state === now.state) {
      obs.watched[key] = { ...entry, lastCommentId: before.lastCommentId, maintainer: before.maintainer || [] };
      continue;
    }
    const page = Math.max(1, Math.ceil((now.comments || 0) / 100));
    const comments = now.comments ? (await getJson(fetchFn, `${api}/${w.repo}/issues/${w.n}/comments?per_page=100&page=${page}`, env)) || [] : [];
    const slim = comments.map((c) => ({ id: c.id, author: c.user?.login ?? null, association: c.author_association ?? null, at: c.created_at, text: String(c.body ?? '').slice(0, 600) }));
    obs.watched[key] = {
      ...entry,
      lastCommentId: slim.length ? Math.max(...slim.map((c) => c.id)) : (before?.lastCommentId ?? 0),
      newSince: before && !before.unavailable ? slim.filter((c) => c.id > (before.lastCommentId ?? 0)) : [],
      maintainer: slim.filter(isMaintainer).slice(-3),
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
      if (!isMaintainer(c) || c.text.replace(/\s+/g, ' ').trim().length < SUBSTANTIVE_CHARS) continue;
      add('maintainer_reply', `${w.priority} ${key} (${w.topic}): ${c.author} wrote: ${c.text.replace(/\s+/g, ' ').slice(0, 280)}`);
    }
    if (w.state !== before.state) add('watched_issue_state', `${w.priority} ${key} (${w.topic}) is now ${w.state}`);
  }
  for (const [n, i] of Object.entries(next.issues || {})) {
    if (!prev.issues?.[n] && isMaintainer(i)) add('new_issue', `close-1 repo: new issue #${n} by ${i.author} "${i.title}"`);
  }
  return out;
}
