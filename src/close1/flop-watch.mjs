/**
 * The FLOP upstream watch beyond the close-1 issue list: the archive-publication
 * topic (issues #15 and #25 are ONE logical topic), merged changes in the
 * protocol repos, and direct @Mariukasfak interaction.
 *
 * Official versus community is decided by who wrote it, never by what they say:
 * a FLOP maintainer is `sv` or a GitHub OWNER/MEMBER of the org. A commenter
 * with `author_association=NONE` is [COMMUNITY] whatever their name or tone.
 * Community text can be a lead; it never changes a trust class, a mode or a cap.
 *
 * Nothing here posts, comments or writes to GitHub: it only reads, through the
 * shared rate-limited client (ETag revalidation costs no quota).
 */
import crypto from 'node:crypto';

export const OFFICIAL = '[OFICIALU]';
export const COMMUNITY = '[COMMUNITY]';

/** Watched issues that are the same story: one alert per new fact, not one per thread. */
export const TOPIC_GROUPS = Object.freeze({
  'flop-labs/technocore-close-call-challenge#15': 'CLOSE1_ARCHIVE_PUBLICATION',
  'flop-labs/technocore-close-call-challenge#25': 'CLOSE1_ARCHIVE_PUBLICATION'
});
export const groupOf = (key) => TOPIC_GROUPS[key] ?? null;

const norm = (s) => String(s ?? '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
const digest = (group, kind, text) => crypto.createHash('sha256').update(`${group}|${kind}|${norm(text)}`).digest('hex').slice(0, 16);
const MAX_DIGESTS = 60;

/**
 * Notes about the same grouped topic that say the same thing (same comment text
 * copied into #15 and #25, or reported by both threads in one run) become one.
 * `prevDigests` carries the memory across runs. Returns { notes, digests }.
 */
export function dedupeGroupedAlerts(notes, prevDigests = []) {
  const seen = new Set(prevDigests);
  const fresh = [];
  const out = [];
  for (const n of notes) {
    const group = n.group ?? groupOf(n.key);
    if (!group || !['maintainer_reply', 'community_integrity_claim', 'community_comment'].includes(n.kind)) { out.push(n); continue; }
    const d = digest(group, n.kind, n.body ?? n.text);
    if (seen.has(d)) continue;
    seen.add(d); fresh.push(d);
    out.push({ ...n, group });
  }
  return { notes: out, digests: [...prevDigests, ...fresh].slice(-MAX_DIGESTS) };
}

/* ------------------------------------------------------------ merged changes */

const KEYWORDS = /htlc|conformance|golden|settle|escrow|sign(?:ing|ature)?|identity|did:|room|budget|tclk|offer|protocol|breaking|referee|archive|close-1|mint|nonce|domain[- ]separation|rfc|spec/i;

/**
 * Repos whose merged commits can change our agent or the meaning of our evidence.
 * yellowpaper is the specification: any merge to main is news. The others only
 * when the commit message names something that touches signing, rooms, settlement
 * or the close-1 flow.
 */
export const HEAD_WATCH = Object.freeze([
  { repo: 'flop-labs/yellowpaper', kind: 'yellowpaper_change', all: true },
  { repo: 'flop-labs/flop-core', kind: 'protocol_change_merged', all: false },
  { repo: 'flop-labs/technocore-chat', kind: 'protocol_change_merged', all: false },
  { repo: 'flop-labs/tclk', kind: 'protocol_change_merged', all: false }
]);
const KEEP_SHAS = 20;

/** Latest commits of each watched repo, remembering which we have already seen. Never throws. */
export async function observeHeads({ prev = null, gh, nowMs }) {
  const out = {};
  for (const w of HEAD_WATCH) {
    const before = prev?.[w.repo];
    try {
      const list = await gh.json(`https://api.github.com/repos/${w.repo}/commits?per_page=10`, { allow404: true });
      if (!Array.isArray(list)) { out[w.repo] = before ?? { unavailable: true }; continue; }
      const commits = list.map((c) => ({ sha: String(c.sha).slice(0, 10), title: String(c.commit?.message ?? '').split('\n')[0].slice(0, 120), date: c.commit?.author?.date ?? null, author: c.author?.login ?? c.commit?.author?.name ?? null }));
      const seen = new Set(before?.seen ?? []);
      const fresh = before && !before.unavailable ? commits.filter((c) => !seen.has(c.sha)) : [];
      out[w.repo] = { checked_at: new Date(nowMs).toISOString(), head: commits[0] ?? null, seen: [...new Set([...commits.map((c) => c.sha), ...(before?.seen ?? [])])].slice(0, KEEP_SHAS), fresh, baseline: !before || Boolean(before.unavailable) };
    } catch { if (before) out[w.repo] = { ...before, fresh: [] }; }
  }
  return out;
}

export function headAlerts(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const w of HEAD_WATCH) {
    for (const c of next[w.repo]?.fresh || []) {
      if (!w.all && !KEYWORDS.test(c.title)) continue;   // routine merge: not news
      out.push({ kind: w.kind, key: w.repo, text: `${OFFICIAL} ${w.repo} merged to main: ${c.title} (${c.sha}${c.author ? `, ${c.author}` : ''})` });
    }
  }
  return out;
}

/* ---------------------------------------------------- @Mariukasfak interaction */

export const OUR_LOGIN = 'mariukasfak';
const MENTION = /@mariukasfak\b/i;
const MAX_THREADS_PER_RUN = 3;
/** The first look reads the newest comment id of every thread (one request each) so old comments are never reported as new. */
const MAX_BASELINE_THREADS = 10;
const SUBSTANTIVE = 40;

/**
 * Threads that involve our account (we wrote, commented or were mentioned) and
 * changed since the last look. New comments by others are read for a direct
 * mention or a maintainer word; state changes of threads WE opened are recorded.
 * The first look is a baseline. Never throws.
 */
export async function observeMentions({ prev = null, gh, isMaintainer, nowMs }) {
  const at = new Date(nowMs).toISOString();
  try {
    const q = encodeURIComponent(`involves:Mariukasfak org:flop-labs`);
    const res = await gh.json(`https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=10`, { allow404: true });
    const items = Array.isArray(res?.items) ? res.items : null;
    if (!items) return prev ?? { checked_at: at, threads: {}, events: [], unavailable: true };
    const threads = { ...(prev?.threads || {}) };
    const events = [];
    let spent = 0;
    for (const i of items) {
      // `url` = api.github.com/repos/<owner>/<repo>/issues/<n>; the shared client's slimmer drops repository_url.
      const key = `${String(i.url ?? '').split('/repos/')[1]?.split('/issues/')[0] ?? 'flop-labs/?'}#${i.number}`;
      const before = prev?.threads?.[key];
      const ours = String(i.user?.login ?? '').toLowerCase() === OUR_LOGIN;
      const t = { title: String(i.title).slice(0, 100), state: i.state, updated: i.updated_at, opened_by_us: ours, comments: i.comments, last_comment_id: before?.last_comment_id ?? 0, is_pr: Boolean(i.pull_request), merged: Boolean(i.pull_request?.merged_at) };
      threads[key] = t;
      if (!before) {
        // Baseline: remember the newest comment id so old ones are never reported as new.
        if (i.comments && spent < MAX_BASELINE_THREADS) {
          spent += 1;
          const last = await gh.json(`https://api.github.com/repos/${key.split('#')[0]}/issues/${i.number}/comments?per_page=1&page=${Math.max(1, i.comments)}`).catch(() => []);
          t.last_comment_id = last?.[0]?.id ?? 0;
        }
        continue;
      }
      if (ours && before.state !== i.state) events.push({ type: 'STATE', key, title: t.title, state: i.state, merged: t.merged, at });
      if (i.updated_at === before.updated && i.comments === before.comments) { t.last_comment_id = before.last_comment_id; continue; }
      if (i.comments > (before.comments ?? 0) && spent >= MAX_THREADS_PER_RUN) {
        // Over this run's budget: leave the old count so the thread is read next run instead of being skipped for good.
        t.comments = before.comments; t.updated = before.updated; t.last_comment_id = before.last_comment_id;
        continue;
      }
      if (i.comments > (before.comments ?? 0) && spent < MAX_THREADS_PER_RUN) {
        spent += 1;
        const page = Math.max(1, Math.ceil(i.comments / 100));
        const cs = (await gh.json(`https://api.github.com/repos/${key.split('#')[0]}/issues/${i.number}/comments?per_page=100&page=${page}`).catch(() => [])) || [];
        for (const c of cs) {
          if (!(c.id > (before.last_comment_id ?? 0))) continue;
          const author = String(c.user?.login ?? '');
          if (author.toLowerCase() === OUR_LOGIN) continue;
          const m = { id: c.id, author, association: c.author_association ?? null, text: String(c.body ?? '').replace(/\s+/g, ' ').slice(0, 300) };
          const official = isMaintainer({ author, association: m.association });
          const direct = MENTION.test(c.body ?? '');
          if (official && m.text.length >= SUBSTANTIVE) events.push({ type: 'OFFICIAL', key, title: t.title, ...m, direct, at });
          else if (direct) events.push({ type: 'COMMUNITY_MENTION', key, title: t.title, ...m, at });
        }
        t.last_comment_id = cs.length ? Math.max(before.last_comment_id ?? 0, ...cs.map((c) => c.id)) : before.last_comment_id;
      }
    }
    return { checked_at: at, threads, events, baseline: !prev };
  } catch { return prev ? { ...prev, events: [] } : { checked_at: at, threads: {}, events: [], unavailable: true }; }
}

export function mentionAlerts(prev, next) {
  const out = [];
  if (!prev || !next?.events) return out;
  for (const e of next.events) {
    if (e.type === 'OFFICIAL') out.push({ kind: 'mention_official', key: e.key, text: `${OFFICIAL} ${e.key} (${e.title}): ${e.author} wrote${e.direct ? ' to @Mariukasfak' : ''}: ${e.text.slice(0, 260)}` });
    else if (e.type === 'COMMUNITY_MENTION') out.push({ kind: 'mention_community', key: e.key, text: `${COMMUNITY} ${e.key} (${e.title}): ${e.author} mentioned @Mariukasfak: ${e.text.slice(0, 220)}` });
    else if (e.type === 'STATE') out.push({ kind: 'our_thread_state', key: e.key, text: `[LOCAL] ${e.key} (${e.title}) is now ${e.merged ? 'merged' : e.state}` });
  }
  return out;
}
