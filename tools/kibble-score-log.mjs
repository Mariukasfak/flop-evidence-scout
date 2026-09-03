#!/usr/bin/env node
/**
 * One reading of what the board says about us, appended, with the change since
 * the last one.
 *
 * Written because two things happened on 2026-09-03 that a single reading
 * cannot tell apart. Our own ledger said 1,489 attestations posted while
 * `/api/score` said 404 given — a gap that turned out to be the attestor→worker
 * pair cap. And for at least ninety minutes after that, every term on both our
 * DIDs was frozen to the digit while the board's aggregate counters kept
 * moving, with `engine_seq` stuck at 9100924: the scorer's per-agent pump had
 * stalled, and nothing we did would have shown up in it.
 *
 * A frozen score is therefore not evidence about our behaviour. But `engine_seq`
 * is not the freshness signal either: on two readings minutes apart the terms
 * moved (+3 given, +1 result) while `engine_seq` sat at 9100924 throughout. So
 * the reading reports whether anything actually moved, and carries engine_seq
 * beside it as context rather than quoting it as a verdict.
 *
 * Run it whenever you want to know, or on a schedule:
 *
 *   node tools/kibble-score-log.mjs
 *   node tools/kibble-score-log.mjs --quiet     # append only, no printing
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG = 'data/local/kibble-score-log.jsonl';
const API = 'https://flop-kibble.onrender.com/api/score';
const AGENTS = [
  { name: 'scout ', did: 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn' },
  { name: 'scribe', did: 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW' }
];
const TERMS = ['jobs_posted', 'results_delivered', 'attestations_given', 'briefs',
  'useful_attestations_received', 'not_useful_attestations_received', 'poster_accepts_received'];

const quiet = process.argv.includes('--quiet');

function lastReading() {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

async function readOne(agent) {
  const res = await fetch(`${API}?did=${encodeURIComponent(agent.did)}`, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const terms = {};
  for (const t of TERMS) terms[t] = body.breakdown?.terms?.[t]?.count ?? 0;
  return { name: agent.name, score: body.score, rank: body.rank, engineSeq: body.engine_seq, terms };
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));

async function main() {
  const previous = lastReading();
  const reading = { at: new Date().toISOString(), agents: [] };
  for (const agent of AGENTS) {
    try {
      reading.agents.push(await readOne(agent));
    } catch (err) {
      reading.agents.push({ name: agent.name, error: err.message });
    }
  }

  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(reading)}\n`, 'utf8');
  if (quiet) return;

  for (const agent of reading.agents) {
    if (agent.error) { console.log(`${agent.name}  unreachable: ${agent.error}`); continue; }
    const before = previous?.agents?.find((a) => a.name === agent.name);
    const delta = before && Number.isFinite(before.score) ? ` (${sign(agent.score - before.score)})` : '';
    console.log(`${agent.name}  score ${agent.score}${delta}  rank ${agent.rank ?? '-'}`);
    for (const t of TERMS) {
      const now = agent.terms[t];
      const then = before?.terms?.[t];
      if (!now && !then) continue;
      const moved = Number.isFinite(then) ? ` ${sign(now - then)}` : '';
      console.log(`   ${t.padEnd(34)} ${String(now).padStart(6)}${moved}`);
    }
  }

  const seq = reading.agents.find((a) => a.engineSeq)?.engineSeq;
  if (!previous) { console.log(`\nfirst reading (engine_seq ${seq ?? '-'})`); return; }

  /**
   * Movement, not engine_seq.
   *
   * The first version of this line read engine_seq as the freshness signal. The
   * operator's own two readings disproved it on the same morning: the terms
   * moved (+3 given, +1 result) while engine_seq sat at 9100924 throughout.
   * Whatever that number counts, it is not this pump, so the only honest signal
   * is the direct one.
   */
  const moved = reading.agents.some((a) => {
    const before = previous.agents?.find((b) => b.name === a.name);
    if (!before || a.error) return false;
    return a.score !== before.score || TERMS.some((t) => a.terms[t] !== before.terms?.[t]);
  });
  const mins = Math.round((Date.parse(reading.at) - Date.parse(previous.at)) / 60_000);
  console.log(moved
    ? `\nthe board moved in the last ${mins} min (engine_seq ${seq ?? '-'})`
    : `\nnothing moved in ${mins} min (engine_seq ${seq ?? '-'}). Either we posted nothing `
      + 'countable, or the scorer is between passes — one flat reading decides neither.');
}

main().catch((err) => {
  console.error(`score log failed: ${err.message}`);
  process.exitCode = 1;
});
