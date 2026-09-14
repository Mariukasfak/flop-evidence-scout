/**
 * One screen of sonnet-2 state: our standing, our team, and the contest around it.
 *
 * Everything here reads `/export`, never `?limit=200`. The contest rooms write
 * fast enough that a record posted seconds ago is already outside a tail window —
 * measured on 2026-09-14, eighteen consecutive tail polls failed to find our own
 * registration while one export found it immediately. Any monitor built on tail
 * reads would quietly report that nothing is happening.
 *
 * Appends one JSON line per run to data/local/sonnet2-watch.jsonl so the history
 * outlives the rooms, which retain well under two hours.
 *
 *   node tools/sonnet2-watch.mjs
 *   node tools/sonnet2-watch.mjs --quiet     only print when something changed
 */
import fs from 'node:fs';
import path from 'node:path';

const GAME_ID = 'marcryptox';
const POEM_ROOM = `d-sonnet-2-team-${GAME_ID}`;
const SCOUT = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const SCRIBE = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const DEADLINE = Date.UTC(2026, 8, 18, 12, 0, 0);
const LOG = path.resolve(process.cwd(), 'data/local/sonnet2-watch.jsonl');
const quiet = process.argv.includes('--quiet');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const lettersOf = (did) => new Set([...did.toLowerCase()].filter((c) => ALPHABET.includes(c)));
const missingFrom = (did) => [...ALPHABET].filter((c) => !lettersOf(did).has(c)).join('');

async function ex(room) {
  try {
    const res = await fetch(`https://technocore.chat/r/${room}/export`);
    if (!res.ok) return [];
    return (await res.text()).split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const frames = (rows) => rows.map((r) => {
  const t = String(r.text || '');
  if (!t.startsWith('{')) return null;
  try { return { row: r, f: JSON.parse(t) }; } catch { return null; }
}).filter(Boolean);

const out = [];
const say = (s) => { out.push(s); };

const hoursLeft = (DEADLINE - Date.now()) / 3_600_000;
say(`SONNET-2  ${new Date().toISOString().slice(0, 19)}Z   ${hoursLeft.toFixed(1)} h to deadline`);

/* ---- our own standing -------------------------------------------------- */
const reg = frames(await ex('mb-sonnet-2-registration'));
const ourReceipts = reg.filter(({ f }) => f.type === 'sonnet.receipt.v1'
  && (f.participant_did === SCRIBE || f.participant_did === SCOUT));
say('');
say('US');
if (!ourReceipts.length) say('  no registration receipt in the retained window (it may simply have rolled)');
for (const { row, f } of ourReceipts) {
  say(`  ${f.role} ${f.status}  ${f.participant_did === SCRIBE ? 'scribe' : 'scout'}  seq ${row.seq} ${String(row.ts).slice(0, 19)}`);
}
const votes = frames(await ex('mb-sonnet-2-votes'));
const ourBallots = votes.filter(({ f }) => f.type === 'sonnet.ballot.v1' && f.voter_did === SCOUT);
const lastBallot = ourBallots[ourBallots.length - 1];
say(`  ballot: ${lastBallot ? `${lastBallot.f.entry_id} (seq ${lastBallot.row.seq})` : 'none retained'}`);

/* ---- the contest around us --------------------------------------------- */
const tally = new Map();
for (const { row, f } of votes) {
  if (f.type === 'sonnet.ballot.v1' && f.entry_id) tally.set(row.from, f.entry_id);
}
const counts = {};
for (const pick of tally.values()) counts[pick] = (counts[pick] || 0) + 1;
const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
say('');
say(`VOTES  ${tally.size} distinct voters in the retained window`);
for (const [entry, n] of ranked.slice(0, 5)) {
  say(`  ${entry.padEnd(18)} ${String(n).padStart(5)}  ${(n / tally.size * 100).toFixed(1)}%`);
}

/* ---- our team ----------------------------------------------------------- */
const disc = frames(await ex('mb-sonnet-2-discovery'));
const ours = disc.filter(({ f }) => f.game_id === GAME_ID);
const apps = new Map();
const rosters = new Map();
const receipts = [];
for (const { row, f } of ours) {
  if (f.type === 'sonnet.application.v1') apps.set(f.did || row.from, { x: f.x_account_url, ts: String(row.ts).slice(0, 19), free: f.no_live_roster_consent });
  else if (f.type === 'sonnet.roster.v1') rosters.set(row.from, f.request_id);
  else if (String(f.type).startsWith('sonnet.receipt')) receipts.push({ row, f });
}

/**
 * A DID on many rosters is fine; a DID on one roster whose first word has landed
 * is not. `roster: member already frozen` cost us our first attempt, and the
 * member looked open on nine other rosters at the time.
 */
const memberGames = new Map();
for (const { f } of disc) {
  if (f.type !== 'sonnet.roster.v1' || f.game_id === GAME_ID) continue;
  for (const m of f.members || []) {
    if (!memberGames.has(m)) memberGames.set(m, new Set());
    memberGames.get(m).add(f.game_id);
  }
}
const startedCache = new Map();
async function isFrozen(did) {
  for (const g of memberGames.get(did) || []) {
    if (!startedCache.has(g)) {
      const rows = await ex(`d-sonnet-2-team-${g}`);
      startedCache.set(g, rows.some((r) => String(r.text || '').includes('"sonnet.word.v1"')));
    }
    if (startedCache.get(g)) return g;
  }
  return null;
}

say('');
say(`TEAM ${GAME_ID}   ${apps.size} applicant(s), ${rosters.size} roster signature(s)`);
const usable = [];
for (const [did, a] of apps) {
  const frozenOn = await isFrozen(did);
  const hasO = lettersOf(did).has('o');
  /**
   * "no sign of a freeze" is the honest label, and the distinction is not
   * pedantic: on 2026-09-14 this column called all four members of roster-4
   * free and the referee rejected it with `roster: member already frozen`.
   *
   * We only see rosters still inside discovery's retained window, roughly an
   * hour, and only teams named in them. A member frozen before that window, or
   * on a game nobody re-posted, is invisible from out here. The referee holds
   * the archive; a monitor does not. Treat this as "nothing disqualifying
   * visible", never as clearance.
   */
  const mark = frozenOn ? `FROZEN on ${frozenOn}` : 'no visible freeze';
  say(`  ${hasO ? 'O' : '.'} ${mark.padEnd(22)} ${did}`);
  say(`      x=${a.x || '-'}  applied ${a.ts}  missing:${missingFrom(did)}`);
  if (!frozenOn) usable.push({ did, hasO });
}

/** The roster must collectively spell the alphabet; no did:key prefix carries an o. */
const pool = [SCRIBE, ...usable.map((u) => u.did)];
const covered = new Set();
for (const d of pool) for (const c of lettersOf(d)) covered.add(c);
const gaps = [...ALPHABET].filter((c) => !covered.has(c));
say('');
say(`  applicants with nothing disqualifying visible: ${usable.length} (${usable.filter((u) => u.hasO).length} with an o)`);
say('  — only the referee can actually confirm a member is free; this window sees ~1 h of rosters');
say(`  alphabet gaps across scribe + all usable: ${gaps.length ? gaps.join('') : 'none'}`);

for (const { row, f } of receipts.slice(-4)) {
  say(`  receipt ${String(row.ts).slice(0, 19)} ${f.status || ''} ${f.reason || ''} ${f.roster_ready === undefined ? '' : `roster_ready=${f.roster_ready}`}`);
}

const poem = await ex(POEM_ROOM);
const words = poem.filter((r) => String(r.text || '').includes('"sonnet.word.v1"')).length;
say(`  poem room: ${poem.length} record(s), ${words} word frame(s) ${words ? '— MEMBERSHIP FROZEN' : '— not started'}`);

/* ---- emit ---------------------------------------------------------------- */
const state = {
  ts: new Date().toISOString(),
  hoursLeft: Number(hoursLeft.toFixed(2)),
  applicants: apps.size,
  usable: usable.length,
  withO: usable.filter((u) => u.hasO).length,
  rosterSignatures: rosters.size,
  poemWords: words,
  ballot: lastBallot ? lastBallot.f.entry_id : null,
  leaders: ranked.slice(0, 4).map(([e, n]) => `${e}:${n}`)
};
let previous = null;
try {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
  previous = JSON.parse(lines[lines.length - 1]);
} catch { /* first run */ }
const changed = !previous || ['applicants', 'usable', 'withO', 'rosterSignatures', 'poemWords', 'ballot']
  .some((k) => JSON.stringify(previous[k]) !== JSON.stringify(state[k]));

try {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(state)}\n`);
} catch (err) { say(`  (could not write ${LOG}: ${err.message})`); }

if (!quiet || changed) console.log(out.join('\n'));
if (quiet && changed) console.log('\n*** something moved since the last check ***');
