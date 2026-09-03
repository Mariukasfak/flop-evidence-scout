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
 * A frozen score is therefore not evidence about our behaviour, and a rising
 * one is not proof a change worked unless the engine moved too. So every
 * reading records `engine_seq`, and the delta line says plainly when the engine
 * did not advance.
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
  const seqBefore = previous?.agents?.find((a) => a.engineSeq)?.engineSeq;
  if (seq && seqBefore && seq === seqBefore) {
    const mins = Math.round((Date.parse(reading.at) - Date.parse(previous.at)) / 60_000);
    console.log(`\nthe scorer has not advanced in ${mins} min (engine_seq ${seq}). `
      + 'A flat reading here says nothing about us.');
  } else if (seq) {
    console.log(`\nengine_seq ${seq}${seqBefore ? ` (was ${seqBefore})` : ''}`);
  }
}

main().catch((err) => {
  console.error(`score log failed: ${err.message}`);
  process.exitCode = 1;
});
