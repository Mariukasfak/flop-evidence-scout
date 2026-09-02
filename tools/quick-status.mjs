/**
 * "Kaip sekasi?" — answered on one screen, without asking anyone.
 *
 * The operator has asked that question in several different ways over several
 * days, and the honest answer has always required reading three files and
 * probing a server. Averages were the wrong answer once already: a mean cycle
 * time looks healthy for a process that has been restarting every ten minutes,
 * because each restart resets the thing being averaged. So this reports the
 * facts that would have shown that — when the process actually started, whether
 * cycles are still arriving, and when the last one was — rather than a summary
 * that survives its own bad news.
 *
 * Everything here is read from disk or measured now. Nothing is inferred from a
 * previous run, and every number is followed by where it came from.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readGitHead } from '../src/daemon.mjs';

const DATA = 'data/local';
const AUDIT = path.join(DATA, 'scout-audit.jsonl');
const HEARTBEAT = path.join(DATA, 'scout-heartbeat.json');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';

const minutesAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;
const fmtAgo = (mins) => {
  if (!Number.isFinite(mins)) return 'nezinoma';
  if (mins < 1) return 'ka tik';
  if (mins < 90) return `pries ${Math.round(mins)} min.`;
  return `pries ${(mins / 60).toFixed(1)} val.`;
};

/**
 * Read the tail of the audit log without loading all of it.
 *
 * It is 6 MB and grows every minute; reading the whole file to answer "what
 * happened lately" would make this tool slower the longer the agent has been
 * healthy, which is exactly backwards.
 */
function tailLines(file, bytes = 400_000) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').filter(Boolean);
}

/**
 * Count matching lines across the whole log, without holding it in memory.
 *
 * The audit is 7 MB and grows every minute. Reading it whole to answer "how
 * many times has this happened" would make the tool slower the longer the agent
 * has been healthy; reading only the tail makes it wrong. Streaming is neither.
 */
function countActions(file, patterns) {
  const counts = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let carry = '';
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      const chunk = carry + buf.toString('utf8', 0, read);
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        for (const [key, re] of Object.entries(patterns)) if (re.test(line)) counts[key] += 1;
      }
    }
    for (const [key, re] of Object.entries(patterns)) if (carry && re.test(carry)) counts[key] += 1;
  } finally {
    fs.closeSync(fd);
  }
  return counts;
}

/**
 * The last line in the whole log matching a pattern, or null.
 *
 * Startup events are rare and the tail is small, so on a healthy agent the most
 * recent one falls out of the 400 KB window within hours — at which point this
 * tool reported "veikia be perkrovimo: nezinoma" and "veikianti versija
 * nezinoma" about a daemon that had restarted cleanly forty minutes earlier and
 * written both facts down. The longer the agent runs well, the less this knew.
 *
 * That is the third time a tail has been mistaken for a whole file here. The
 * tail is right for "what happened lately" and wrong for "when did this last
 * happen"; those are different questions and now use different readers.
 */
function lastMatching(file, pattern) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let carry = '', found = null;
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      const lines = (carry + buf.toString('utf8', 0, read)).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) if (pattern.test(line)) found = line;
    }
    if (carry && pattern.test(carry)) found = carry;
  } finally {
    fs.closeSync(fd);
  }
  if (!found) return null;
  try { return JSON.parse(found); } catch { return null; }
}

function main() {
  console.log('\n================================================================');
  console.log('   KAIP SEKASI');
  console.log('================================================================\n');

  if (!fs.existsSync(AUDIT)) {
    console.log(`${RED}Nera ${AUDIT} — agentas siame kompiuteryje dar nepaleistas.${OFF}\n`);
    return;
  }

  const lines = tailLines(AUDIT);
  const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // ── ar sukasi ─────────────────────────────────────────────────────────
  const cycles = records.filter((r) => r.event === 'cycle_timing');
  const last = cycles[cycles.length - 1];
  const lastAgo = last ? minutesAgo(last.timestamp) : Infinity;

  const live = lastAgo < 3;
  console.log(`  Paskutinis ciklas:   ${live ? GREEN : RED}${fmtAgo(lastAgo)}${OFF}`
    + `${live ? '' : `  ${RED}<- agentas nesisuka${OFF}`}`);

  if (last) {
    console.log(`  Ciklo trukme:        ${(last.cycleMs / 1000).toFixed(1)} s ${DIM}(is ${(last.intervalMs / 1000)} s tarpo)${OFF}`);
    console.log(`  Modelio seansai:     ${last.sessions}/${last.planned}`);
  }

  // Cycles in the last full hour, against the theoretical maximum.
  const hourAgo = Date.now() - 3600_000;
  const lastHour = cycles.filter((c) => new Date(c.timestamp).getTime() > hourAgo).length;
  if (last) {
    const max = Math.round(3600_000 / last.intervalMs);
    const pct = Math.round((100 * lastHour) / max);
    const col = pct >= 90 ? GREEN : pct >= 60 ? YEL : RED;
    console.log(`  Ciklu per valanda:   ${col}${lastHour} is ${max} (${pct}%)${OFF}`);
  }

  // ── ar luzta ──────────────────────────────────────────────────────────
  // Whole-file, not the tail: a healthy agent's last startup scrolls out of the
  // window within hours, and "unknown" about a fact we wrote down is worse than
  // slow. Fatals stay on the tail — a recent crash is the one worth showing.
  const startups = records.filter((r) => r.event === 'startup');
  const fatals = records.filter((r) => r.event === 'fatal');
  const lastStart = lastMatching(AUDIT, /"event":"startup"/) || startups[startups.length - 1];
  const lastUpdate = lastMatching(AUDIT, /"event":"restart_for_update"/);
  console.log(`  Veikia be perkrovimo: ${lastStart ? fmtAgo(minutesAgo(lastStart.timestamp)) : 'nezinoma'}`);
  if (startups.length > 1) {
    console.log(`  ${DIM}Paleidimu sioje istorijoje: ${startups.length}${OFF}`);
  }
  if (fatals.length) {
    console.log(`  ${RED}Luzimu su priezastimi: ${fatals.length}${OFF}`);
    console.log(`  ${DIM}${String(fatals[fatals.length - 1].error).split('\n')[0].slice(0, 90)}${OFF}`);
  }

  // ── ar veikia tas kodas, kuris yra diske ──────────────────────────────
  //
  // A running daemon holds the modules it started with, so a fix can be
  // committed and inert at the same time — which is exactly what happened for
  // most of a day, repeatedly, while the status screen said everything was
  // fine. The daemon now stands down by itself when HEAD moves, but a process
  // started before that landed cannot know to, so the gap has to be visible.
  const onDisk = readGitHead(process.cwd());
  const running = lastStart?.commit ?? null;
  if (onDisk && running && onDisk !== running) {
    console.log(`  ${YEL}Naujas kodas laukia${OFF}  ${DIM}(veikia ${running.slice(0, 7)}, diske ${onDisk.slice(0, 7)})${OFF}`);
    console.log(`  ${DIM}Agentas persileis pats. Jei ne — meniu.bat punktas [14].${OFF}`);
  } else if (onDisk && running) {
    console.log(`  ${GREEN}Veikia naujausias kodas${OFF}  ${DIM}(${running.slice(0, 7)})${OFF}`);
  } else if (onDisk) {
    console.log(`  ${DIM}Veikianti versija nezinoma (paleista pries si patikrinima).${OFF}`);
  }
  if (lastUpdate) {
    console.log(`  ${DIM}Paskutinis savaiminis persileidimas: ${fmtAgo(minutesAgo(lastUpdate.timestamp))}${OFF}`);
  }

  // ── ka nuveike ────────────────────────────────────────────────────────
  console.log('\n----------------------------------------------------------------');
  if (fs.existsSync(HEARTBEAT)) {
    const hb = JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8'));
    console.log(`  Ejimu is viso:       ${hb.turns}`);
    console.log(`  Atsakyta klausimu:   ${hb.handledCount}`);
    console.log(`  Rasymas i serveri:   ${hb.stateOk ? `${GREEN}veikia${OFF}` : `${RED}nepavyksta${OFF}`}`
      + (hb.stateError ? ` ${DIM}(${String(hb.stateError).slice(0, 60)})${OFF}` : ''));
    console.log(`  Paskutinis veiksmas: ${DIM}${String(hb.lastAction).slice(0, 60)}${OFF}`);
  }

  // ── kibble ────────────────────────────────────────────────────────────
  //
  // Counted over the WHOLE log, not the tail the rest of this tool reads.
  // These are lifetime totals and a tail is not one: at 7.3 MB the 400 KB
  // window reported 2 deliveries against 5 that had actually happened, and
  // printed it under a heading that promised a total. A tool that quietly
  // understates is worse than one that says it does not know.
  const totals = countActions(AUDIT, {
    delivered: /"action":"delivered"/,
    attested: /"action":"attested_(not|useful)"/,
    refused: /"action":"refused"/,
    lost: /"action":"claims_lost"/
  });

  console.log('\n----------------------------------------------------------------');
  console.log('  Naudingo darbo lenta');
  console.log(`    pristatyta atsakymu: ${totals.delivered}`);
  console.log(`    pateikta vertinimu:  ${totals.attested}`);
  if (totals.refused || totals.lost) {
    console.log(`    ${DIM}paimta ir palikta:   ${totals.refused} (atsakyti nepavyko)`
      + `, pralaimeta lenktyniu: ${totals.lost}${OFF}`);
  }

  /**
   * The one line worth interrupting someone for.
   *
   * The surface watcher prints a banner to the daemon log, and nobody reads a
   * daemon log. The operator reads this. A published document naming a faucet,
   * a task route or a completion proof is the single event this project is
   * waiting on, so it belongs above the fold rather than in scrollback.
   */
  /**
   * The alert is looked up on its own, not taken from whatever came last.
   *
   * Shipped 2026-09-01 reading the most recent surface record of any kind, and
   * it failed its first real test the next morning: /patterns.md announced the
   * tclk escrow convention at 07:00 and an ordinary /skill.md edit five minutes
   * later took its place on the screen. The routine change hid the one event
   * this whole watcher exists for. A signal now outranks anything quieter and
   * keeps its place until something louder arrives.
   */
  const signal = lastMatching(AUDIT, /"action":"capability_signal"/);
  const surface = signal || lastMatching(AUDIT, /"agent":"surface"/);
  if (surface) {
    const when = fmtAgo(minutesAgo(surface.timestamp));
    if (surface.action === 'capability_signal') {
      console.log('\n----------------------------------------------------------------');
      console.log(`  ${RED}!! SERVERIS PASKELBE KAZKA NAUJA${OFF}  ${DIM}(${surface.surface}, ${when})${OFF}`);
      // Three lines, because this is an alert and not the document. The whole
      // text is a fetch away once somebody is looking.
      for (const line of (surface.signals || []).slice(0, 3)) console.log(`     ${line.slice(0, 70)}`);
      console.log(`  ${DIM}Pasakyk Claude: "patikrink ka serveris paskelbe".${OFF}`);
    } else if (surface.action === 'changed') {
      console.log(`\n  ${DIM}Serverio dokumentacija keitesi: ${surface.surface} (${when}), nieko svarbaus.${OFF}`);
    }
  }

  console.log('\n================================================================');
  console.log(`${DIM}  Visi skaiciai perskaityti is ${AUDIT} ka tik.${OFF}`);
  console.log('================================================================\n');
}

try {
  main();
} catch (err) {
  console.error(`\n${RED}Nepavyko perskaityti busenos:${OFF} ${err.message}\n`);
  process.exit(1);
}
