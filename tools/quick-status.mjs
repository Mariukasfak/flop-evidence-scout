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
  const startups = records.filter((r) => r.event === 'startup');
  const fatals = records.filter((r) => r.event === 'fatal');
  const lastStart = startups[startups.length - 1];
  console.log(`  Veikia be perkrovimo: ${lastStart ? fmtAgo(minutesAgo(lastStart.timestamp)) : 'nezinoma'}`);
  if (startups.length > 1) {
    console.log(`  ${DIM}Paleidimu sioje istorijoje: ${startups.length}${OFF}`);
  }
  if (fatals.length) {
    console.log(`  ${RED}Luzimu su priezastimi: ${fatals.length}${OFF}`);
    console.log(`  ${DIM}${String(fatals[fatals.length - 1].error).split('\n')[0].slice(0, 90)}${OFF}`);
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
