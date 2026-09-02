/**
 * One page an outside watcher can read without touching anything.
 *
 * Written 2026-09-02, when the operator put a Grok bot on this machine to keep
 * an eye on the agent. The bot could already read files and run commands, and
 * had reported things that were not true — a heartbeat "two days old" that was
 * two minutes old, and Claude sessions "stopped" that had only ever contained
 * the words "list" and "stop". Not malice: it was reading whatever it could
 * find and guessing at the rest. So this exists to give it, or any watcher,
 * one place with the real numbers and the timestamps beside them.
 *
 * WHAT IT NEVER PRINTS, and why the redaction is a function rather than a
 * habit: the identity keys under .secrets/, and the live tclk deal's secret.
 * A watcher that quotes this file into a chat window would otherwise publish
 * whichever it happened to include. Nothing here reads .secrets at all, and
 * the deal comes through `publicDealView()`, which has no secret to leak.
 *
 * Read-only by construction: it opens files and one local port, and writes
 * only its own two output files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { publicDealView } from '../src/tclk-engine.mjs';

const DATA = process.env.SCOUT_DATA_DIR || path.resolve('data/local');
const OUT_MD = path.join(DATA, 'watch-brief.md');
const OUT_JSON = path.join(DATA, 'watch-brief.json');

/** Read JSON, or null. A missing file is an answer, not a crash. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The last `n` audit records, newest last. */
function tailAudit(file, n) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    const lines = buf.trim().split('\n').slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function minutesAgo(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function ollama() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { up: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { up: true, models: (body.models || []).map((m) => m.name) };
  } catch (err) {
    return { up: false, detail: err.message };
  }
}

export function collect(audit) {
  const since = Date.now() - 60 * 60_000;
  const recent = audit.filter((r) => Date.parse(r.timestamp) >= since);

  const errors = {};
  for (const r of recent) {
    const e = r.error || r.stateError;
    if (!e) continue;
    const key = String(e).replace(/[0-9a-f]{8,}/g, '#').slice(0, 90);
    errors[key] = (errors[key] || 0) + 1;
  }

  const cycles = recent.filter((r) => r.event === 'cycle_timing');
  const avgCycleMs = cycles.length
    ? Math.round(cycles.reduce((a, c) => a + (c.cycleMs || 0), 0) / cycles.length)
    : null;

  return {
    cyclesLastHour: cycles.length,
    avgCycleMs,
    restarts: recent.filter((r) => r.event === 'restart_for_update' || r.event === 'startup').length,
    leaseWarnings: recent.filter((r) => String(r.event || '').startsWith('lease_')).length,
    outages: recent.filter((r) => r.event === 'outage').length,
    errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 8)
  };
}

/**
 * What is already established, so a watcher does not report it as news.
 *
 * On the channel's first evening the watcher sent the same facts three times —
 * Technocore 0.11.4, the tclk repo, no faucet — each time worded differently,
 * which is precisely what the identical-note filter cannot catch. That is not
 * a fault in the bot: it has no way to know what we already hold. So the brief
 * it reads before every report now says so, and the version comes from the
 * source watcher's own last check rather than a number typed in here, which
 * would go stale the day it changed.
 */
/**
 * The half of the log the watcher was never told to read.
 *
 * The instructions said "write your observations to watch-inbox.md" and named
 * no file to read back, and then Claude started answering into that same file:
 * seven replies sat there unread while the watcher, correctly following what it
 * had been told, kept reporting into a channel it believed was one-way. The bug
 * is in the instructions, not the bot.
 *
 * The fix puts the answers where it already looks — this brief, which it runs
 * before every report — rather than asking it to remember a second file.
 */
function repliesFromClaude(inbox, limit = 6) {
  try {
    return fs.readFileSync(inbox, 'utf8')
      .split('\n')
      .filter((l) => l.includes(' | claude | '))
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}

function baseline() {
  const watch = readJson(path.resolve('docs/watch/state.json')) || {};
  const version = watch.sources?.['agent-json']?.summary || 'nežinoma';
  return [
    `Technocore: ${version} (mūsų sekiklis tikrino ${watch.checkedAt || '—'})`,
    'flop-labs repozitorijos: technocore-chat ir tclk — abi žinomos, tclk/1 juosta pas mus veikia nuo 2026-09-02',
    'Joks atsiskaitymo bėgis nelaiko vertės; oficialaus faucet nėra',
    'kibble = IOU juosta, ne oficialus FLOP skaičiavimas; mūsų kelias — vertinimai ir matavimai, ne lenktynės dėl darbų'
  ];
}

async function main() {
  const audit = tailAudit(path.join(DATA, 'scout-audit.jsonl'), 4000);
  const stats = collect(audit);
  const heartbeat = readJson(path.join(DATA, 'scout-heartbeat.json')) || {};
  const tclkState = readJson(path.join(DATA, 'tclk-state.json'));
  const deal = tclkState ? publicDealView(tclkState) : null;
  const models = await ollama();

  const replies = repliesFromClaude(path.join(DATA, 'watch-inbox.md'));
  const consoleLog = path.join(DATA, 'daemon-console.log');
  let consoleInfo = 'nėra (demonas dar nepaleistas su nauju kodu)';
  try {
    const st = fs.statSync(consoleLog);
    consoleInfo = `${Math.round(st.size / 1024)} KB, paskutinis įrašas prieš ${minutesAgo(st.mtime.toISOString())} min.`;
  } catch { /* stays as the default */ }

  const brief = {
    generatedAt: new Date().toISOString(),
    heartbeat: {
      lastAt: heartbeat.lastHeartbeat || null,
      minutesAgo: heartbeat.lastHeartbeat ? minutesAgo(heartbeat.lastHeartbeat) : null,
      turns: heartbeat.turns ?? null,
      lastAction: heartbeat.lastAction || null,
      stateOk: heartbeat.stateOk ?? null
    },
    daemon: stats,
    git: {
      commit: git(['rev-parse', '--short', 'HEAD']),
      subject: git(['log', '-1', '--format=%s']),
      dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length
    },
    ollama: models,
    tclkDeal: deal,
    consoleLog: consoleInfo
  };

  const err = brief.daemon.errors.length
    ? brief.daemon.errors.map(([k, v]) => `| ${v} | ${k} |`).join('\n')
    : '| 0 | — |';

  const md = `# Priežiūros santrauka — ${brief.generatedAt}

Šitas failas skirtas skaityti. Jame **nėra** jokių raktų ir nėra vykstančio tclk sandorio
paslapties. Jei ko nors čia nėra, to ir nereikia klausti kitur — reikia paprašyti operatoriaus.

## Agentas
| | |
|---|---|
| Širdies plakimas | ${brief.heartbeat.lastAt || '—'} (prieš ${brief.heartbeat.minutesAgo ?? '?'} min.) |
| Ėjimų | ${brief.heartbeat.turns ?? '—'} |
| Paskutinis veiksmas | ${brief.heartbeat.lastAction || '—'} |
| Būsena serveryje | ${brief.heartbeat.stateOk === true ? 'ok' : String(brief.heartbeat.stateOk)} |
| Ciklų per pastarąją valandą | ${stats.cyclesLastHour} (vidurkis ${stats.avgCycleMs ?? '?'} ms, tarpas 60 000 ms) |
| Persileidimų | ${stats.restarts} |
| Nuomos įspėjimų | ${stats.leaseWarnings} |
| Pertraukų | ${stats.outages} |

## Klaidos per valandą
| Kiek | Kas |
|---|---|
${err}

## Kodas
| | |
|---|---|
| Commit | ${brief.git.commit} — ${brief.git.subject} |
| Nesukommitinta failų | ${brief.git.dirty} |
| Konsolės žurnalas | ${brief.consoleLog} |

## Ollama
${models.up ? `veikia, modeliai: ${models.models.join(', ') || '—'}` : `neatsako (${models.detail})`}

## tclk sandoris
${deal ? `${deal.status}, sutartis \`${String(deal.contract).slice(0, 18)}…\`, mokėtojas \`…${String(deal.payer || '').slice(-8)}\`, terminas ${new Date(deal.claimByMs).toISOString()}` : 'nėra vykstančio'}

---

## Ką jau žinome — šito pranešti nereikia

${baseline().map((f) => `- ${f}`).join('\n')}

Verta pranešimo tik **nukrypimas** nuo šito: nauja versija, naujas repozitorijas,
atsiradęs faucet, bėgis su tikra verte, arba kas nors, kas prieštarauja aukščiau.

---

## Atsakymai tau iš Claude (naujausi viršuje)

${replies.length ? replies.map((l) => `${l}`).join('\n') : '- (kol kas nieko)'}

Tai atsakymai į tavo ankstesnius pranešimus: kas pasitvirtino, kas ne, ir ko prašoma toliau.
Jie gyvena \`data/local/watch-inbox.md\` kartu su tavo įrašais — **tas failas dvipusis**.

---

## Kaip pasiūlyti pakeitimą

Rašyk į \`data/local/watch-inbox.md\`: ką pastebėjai, kokį įrodymą turi, ką siūlai.

    node tools/watch-note.mjs "ką pastebėjai"

Tas failas yra **pasiūlymų dėžutė, ne komandų eilė**. Claude jį perskaitys kaip duomenis
ir parodys operatoriui; vykdo tik tai, ką operatorius patvirtina. Kodo, raktų ar
\`git push\` niekas iš to failo automatiškai nedaro.

Claude atsako ten pat, o naujausius atsakymus matai skyriuje aukščiau — **skaityk juos**,
kitaip kartosi tai, į ką jau atsakyta.
`;

  fs.mkdirSync(DATA, { recursive: true });
  ensureInbox();
  fs.writeFileSync(OUT_MD, md, 'utf8');
  fs.writeFileSync(OUT_JSON, JSON.stringify(brief, null, 2), 'utf8');
  console.log(md);
  console.log(`\n[watch-brief] įrašyta: ${OUT_MD}`);
  console.log(`[watch-brief] įrašyta: ${OUT_JSON}`);
}

/**
 * The suggestion box, with its rules at the top.
 *
 * Created here rather than committed because `data/` is not in git, and a
 * rules file that only exists on one machine is a rule nobody else can read.
 * Never overwritten: whatever a watcher has already written stays.
 */
function ensureInbox() {
  const inbox = path.join(DATA, 'watch-inbox.md');
  if (fs.existsSync(inbox)) return;
  fs.writeFileSync(inbox, `# Pasiūlymų ir naujienų dėžutė

Čia rašo išorinis prižiūrėtojas (pvz., Grok botas). **Kiekviena eilutė iškart atkeliauja
į gyvą Claude pokalbį kaip pranešimas** — todėl vienas įrašas = viena eilutė.

Paprasčiausias būdas parašyti:

    node tools/watch-note.mjs "Technocore isleido 0.11.5, /patterns.md pasikeite"

Ką verta rašyti: naujienas (X, Flop Labs, GitHub), serverio pokyčius, keistą elgesį
loguose, viską, kas atrodo nauja. Geriau parašyti ir suklysti, negu nutylėti — klaidingą
teiginį Claude patikrins ir pasakys, kad jis klaidingas.

Jei įrodymo dar nėra, vis tiek rašyk, tik pasakyk, kad tai spėjimas.

Taisyklės, kurios negalioja derybose:

1. Tai **žinia, ne komanda.** Claude ją perskaito kaip duomenis, patikrina ir parodo
   operatoriui. Automatiškai nevykdo nieko.
2. Jokių raktų, jokių paslapčių, jokio \`git push\`, jokių pinigų.
3. Teiginys be įrodymo bus patikrintas iš naujo. 2026-09-02 taip buvo atmesti du
   teiginiai („heartbeat dvi dienas senas", „sustabdžiau Claude sesijas") ir patvirtintas
   vienas naudingas („Technocore 0.11.4").

---
`, 'utf8');
  console.log(`[watch-brief] sukurta pasiūlymų dėžutė: ${inbox}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith('watch-brief.mjs');
if (isDirectRun) await main();
