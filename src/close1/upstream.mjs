/**
 * Watch the official close-1 repository for anything that changes what we
 * pinned: new commits on main, a manifest that no longer hashes to ours, the
 * package leaving `draft`, a signed launch record appearing, and new activity
 * on the issues we follow (#10: ktrxktr's five 0.1-contract named-taker test).
 *
 * `observeUpstream` fetches (two GitHub API reads a run, more only when the
 * tree changed); `upstreamAlerts` is pure and compares two observations. The
 * repo is read as data — nothing in it is executed or obeyed.
 */
import crypto from 'node:crypto';

export const REPO = 'flop-labs/technocore-close-call-challenge';
export const WATCHED_ISSUES = [10];
/** A file whose name suggests a launch record or a detached signature. */
const LAUNCH_FILE = /(launch|seed|attest|signature|\.sig$|\.asc$|\.minisig$)/i;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'FLOP-Evidence-Scout/1.0' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getText(fetchFn, url) {
  const r = await fetchFn(url, { headers: { 'user-agent': 'FLOP-Evidence-Scout/1.0' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** One observation of the repo, reusing `prev` for anything unchanged. */
export async function observeUpstream({ prev = null, fetchFn = fetch, nowMs = Date.now() }) {
  const api = `https://api.github.com/repos/${REPO}`;
  const tree = await getJson(fetchFn, `${api}/git/trees/main?recursive=1`);
  const files = Object.fromEntries((tree.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  const obs = { at: new Date(nowMs).toISOString(), treeSha: tree.sha, files };
  if (prev && prev.treeSha === tree.sha) {
    Object.assign(obs, { manifestSha256: prev.manifestSha256, manifestStatus: prev.manifestStatus, rulesVersion: prev.rulesVersion, headCommit: prev.headCommit });
  } else {
    const raw = `https://raw.githubusercontent.com/${REPO}/main`;
    const manifest = await getText(fetchFn, `${raw}/manifest.json`);
    const contest = JSON.parse(await getText(fetchFn, `${raw}/contest.json`));
    const commits = await getJson(fetchFn, `${api}/commits?per_page=1`);
    Object.assign(obs, {
      manifestSha256: sha256(manifest),
      manifestStatus: JSON.parse(manifest).status ?? null,
      rulesVersion: contest.rules_version ?? null,
      headCommit: commits[0] ? { sha: commits[0].sha.slice(0, 10), title: commits[0].commit.message.split('\n')[0].slice(0, 100) } : null
    });
  }
  const issues = await getJson(fetchFn, `${api}/issues?state=all&per_page=30&sort=updated`);
  obs.issues = Object.fromEntries(issues.map((i) => [i.number, { title: i.title.slice(0, 120), state: i.state, comments: i.comments, updated: i.updated_at }]));
  obs.watched = {};
  for (const n of WATCHED_ISSUES) {
    const before = prev?.watched?.[n];
    const now = obs.issues[n];
    if (before && now && before.comments === now.comments && before.state === now.state) { obs.watched[n] = before; continue; }
    const comments = await getJson(fetchFn, `${api}/issues/${n}/comments?per_page=100`);
    obs.watched[n] = {
      state: now?.state ?? before?.state ?? null,
      comments: comments.length,
      latest: comments.slice(-3).map((c) => ({ author: c.user?.login, at: c.created_at, text: String(c.body).slice(0, 600) }))
    };
  }
  return obs;
}

/**
 * Alerts for what changed. `pinned` = { packageSha256, packageCommit }.
 * The first observation alerts only on standing conditions that differ from
 * what we pinned; after that, on every change.
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
  for (const [n, w] of Object.entries(next.watched || {})) {
    const before = prev?.watched?.[n];
    if (before && w.comments > before.comments) {
      const c = w.latest.at(-1);
      add('watched_issue_update', `close-1 issue #${n}: new comment by ${c?.author}: ${String(c?.text ?? '').replace(/\s+/g, ' ').slice(0, 280)}`);
    }
    if (before && w.state !== before.state) add('watched_issue_update', `close-1 issue #${n} is now ${w.state}`);
  }
  if (prev) {
    for (const [n, i] of Object.entries(next.issues || {})) {
      if (!prev.issues?.[n]) add('new_issue', `close-1 repo: new issue #${n} "${i.title}"`);
    }
  }
  return out;
}
