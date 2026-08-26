import fs from 'node:fs';
import path from 'node:path';

import { shouldRespond, isBoilerplate, hasStrongTerm, stripUrls } from './knowledge.mjs';

/**
 * Studies the archived rooms to answer one question the agent cannot answer
 * about itself: **is the reply filter calibrated, or is it wrong in a direction
 * nobody notices?**
 *
 * The previous version counted keyword hits and printed a fixed recommendation.
 * That measures nothing — a keyword tally cannot tell you whether the agent is
 * staying quiet because there is nothing worth answering, or because its own
 * gate is refusing questions it should have taken.
 *
 * So this replays `shouldRespond()` over every archived message and reports the
 * distribution of refusal reasons, plus the specific messages that were refused
 * for a reason that could be a mistake. Both failure directions are visible:
 *
 *   too strict  -> real questions sitting in `off_topic` / `no_matching_facts`
 *   too loose   -> boilerplate surviving the gate
 */

const ARCHIVE_DIR = 'data/chats';
const OUTPUT_DIR = 'data/learning';

/** Reasons that mean "correctly ignored". Anything else is worth a human look. */
const EXPECTED_REFUSALS = new Set(['boilerplate', 'not_a_question', 'too_short']);

function readArchives(archiveDir) {
  const dir = path.resolve(archiveDir);
  if (!fs.existsSync(dir)) return [];

  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const room = file.replace(/-archive\.jsonl$|\.jsonl$/, '');
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        const text = m.content || m.text || '';
        if (text) out.push({ room, from: m.from || 'unknown', seq: Number(m.seq || 0), text });
      } catch { /* a malformed line is not worth failing the pass */ }
    }
  }
  return out;
}

/**
 * How much of a room is worth reading at all. A room where nearly every message
 * is boilerplate is a room to spend fewer reads on, whatever its topic says.
 */
function roomQuality(messages) {
  const byRoom = {};
  for (const m of messages) {
    byRoom[m.room] = byRoom[m.room] || { total: 0, boilerplate: 0, onTopic: 0, questions: 0, writers: new Set() };
    const r = byRoom[m.room];
    r.total += 1;
    r.writers.add(m.from);
    if (isBoilerplate(m.text)) r.boilerplate += 1;
    if (hasStrongTerm(m.text)) r.onTopic += 1;
    if (stripUrls(m.text).includes('?')) r.questions += 1;
  }
  return Object.fromEntries(Object.entries(byRoom).map(([room, r]) => [room, {
    messages: r.total,
    distinctWriters: r.writers.size,
    boilerplateShare: Number((r.boilerplate / r.total).toFixed(2)),
    onTopicShare: Number((r.onTopic / r.total).toFixed(2)),
    questionShare: Number((r.questions / r.total).toFixed(2)),
    // Sorting rooms by this is the actionable output: where is attention worth spending.
    signalScore: Number((((r.onTopic + r.questions) / 2 / r.total) * (1 - r.boilerplate / r.total)).toFixed(3))
  }]));
}

export function analyzeChatArchives({
  archiveDir = ARCHIVE_DIR,
  outputDir = OUTPUT_DIR,
  selfDid = null,
  sampleSize = 8
} = {}) {
  const messages = readArchives(archiveDir);

  const refusals = {};
  const wouldAnswer = [];
  const suspiciousRefusals = [];
  const unmatchedTopics = new Map();

  for (const m of messages) {
    const verdict = shouldRespond(m.text, { selfDid });
    if (verdict.respond) {
      wouldAnswer.push({ room: m.room, from: m.from, text: m.text.slice(0, 160), topics: verdict.topics.map((t) => t.topic) });
      continue;
    }

    refusals[verdict.reason] = (refusals[verdict.reason] || 0) + 1;

    // A question that carries a domain term but matched no fact is the single
    // most useful thing in this whole pass: it is a gap in the knowledge base,
    // stated by a real agent, in its own words.
    if (verdict.reason === 'no_matching_facts' && hasStrongTerm(m.text)) {
      const key = m.text.slice(0, 120);
      unmatchedTopics.set(key, (unmatchedTopics.get(key) || 0) + 1);
    }

    if (!EXPECTED_REFUSALS.has(verdict.reason) && stripUrls(m.text).includes('?') && hasStrongTerm(m.text)) {
      suspiciousRefusals.push({ room: m.room, reason: verdict.reason, text: m.text.slice(0, 160) });
    }
  }

  const rooms = roomQuality(messages);
  const rankedRooms = Object.entries(rooms).sort((a, b) => b[1].signalScore - a[1].signalScore);

  const recommendations = [];

  if (messages.length === 0) {
    recommendations.push({
      priority: 'HIGH',
      area: 'Archives',
      insight: 'No archived messages to study.',
      action: 'Run a cycle against the live network before drawing conclusions from this report.'
    });
  }

  if (suspiciousRefusals.length > 0) {
    recommendations.push({
      priority: 'HIGH',
      area: 'Reply filter',
      insight: `${suspiciousRefusals.length} message(s) asked a question, carried a domain term, and were still refused.`,
      action: 'Read the suspiciousRefusals sample. Either the knowledge base is missing a topic, or shouldRespond() is too strict.'
    });
  }

  if (unmatchedTopics.size > 0) {
    recommendations.push({
      priority: 'HIGH',
      area: 'Knowledge base',
      insight: `${unmatchedTopics.size} on-topic message(s) matched no fact in the table.`,
      action: 'These are gaps stated by real agents in their own words. Consider a new topic in src/knowledge.mjs.'
    });
  }

  const lowSignal = rankedRooms.filter(([, r]) => r.messages >= 20 && r.signalScore < 0.05).map(([name]) => name);
  if (lowSignal.length > 0) {
    recommendations.push({
      priority: 'NORMAL',
      area: 'Room selection',
      insight: `Rooms with almost no signal: ${lowSignal.join(', ')}.`,
      action: 'Reading these costs budget and returns nothing. Consider dropping them from watchRooms.'
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'NORMAL',
      area: 'Reply filter',
      insight: 'Every refusal fell into an expected category and no on-topic question went unmatched.',
      action: 'No change indicated. Re-run after the next batch of archives.'
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: {
      messages: messages.length,
      distinctWriters: new Set(messages.map((m) => m.from)).size,
      rooms: Object.keys(rooms).length
    },
    // The headline number: what share of everything seen is worth a reply.
    answerRate: messages.length ? Number((wouldAnswer.length / messages.length).toFixed(4)) : 0,
    refusalsByReason: Object.fromEntries(Object.entries(refusals).sort((a, b) => b[1] - a[1])),
    roomsBySignal: Object.fromEntries(rankedRooms),
    wouldAnswerSample: wouldAnswer.slice(0, sampleSize),
    suspiciousRefusals: suspiciousRefusals.slice(0, sampleSize),
    knowledgeGaps: [...unmatchedTopics.entries()].slice(0, sampleSize).map(([text, count]) => ({ text, count })),
    recommendations
  };

  try {
    fs.mkdirSync(path.resolve(outputDir), { recursive: true });
    fs.writeFileSync(path.join(path.resolve(outputDir), 'optimization-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Learning] Could not write the report:', err.message);
  }

  return report;
}

export function getLatestLearningReport(outputDir = OUTPUT_DIR) {
  const file = path.join(path.resolve(outputDir), 'optimization-report.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Keeps the newest `keep` messages per archive so the corpus cannot grow without bound. */
export function pruneOldArchives({ archiveDir = ARCHIVE_DIR, keep = 400 } = {}) {
  const dir = path.resolve(archiveDir);
  if (!fs.existsSync(dir)) return { pruned: 0 };

  let pruned = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const full = path.join(dir, file);
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= keep) continue;
    fs.writeFileSync(full, `${lines.slice(-keep).join('\n')}\n`, 'utf8');
    pruned += lines.length - keep;
  }
  return { pruned };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('learning-engine.mjs');
if (isDirectRun) {
  if (process.argv.includes('--prune')) {
    const { pruned } = pruneOldArchives();
    console.log(`[Learning] Pruned ${pruned} old archive lines.`);
  } else if (process.argv.includes('--clean')) {
    const report = analyzeChatArchives();
    const dir = path.resolve(ARCHIVE_DIR);
    let removed = 0;
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.jsonl')) { fs.rmSync(path.join(dir, file)); removed += 1; }
      }
    }
    console.log(`[Learning] Report written from ${report.corpus.messages} messages, then removed ${removed} archive file(s).`);
  } else {
    const report = analyzeChatArchives();
    console.log(`\n[Learning] ${report.corpus.messages} messages from ${report.corpus.distinctWriters} writers across ${report.corpus.rooms} rooms`);
    console.log(`[Learning] Worth answering: ${(report.answerRate * 100).toFixed(1)}%\n`);

    console.log('Refusals by reason:');
    for (const [reason, count] of Object.entries(report.refusalsByReason)) {
      console.log(`  ${String(count).padStart(5)}  ${reason}`);
    }

    console.log('\nRooms by signal:');
    for (const [room, r] of Object.entries(report.roomsBySignal)) {
      console.log(`  ${room.padEnd(20)} signal ${String(r.signalScore).padEnd(6)} boilerplate ${(r.boilerplateShare * 100).toFixed(0)}%  writers ${r.distinctWriters}/${r.messages}`);
    }

    if (report.suspiciousRefusals.length) {
      console.log('\nRefused, but looks like a real question:');
      for (const s of report.suspiciousRefusals) console.log(`  [${s.reason}] ${s.text}`);
    }
    if (report.knowledgeGaps.length) {
      console.log('\nOn-topic but matched no fact:');
      for (const g of report.knowledgeGaps) console.log(`  ${g.text}`);
    }

    console.log('');
    for (const r of report.recommendations) console.log(`[${r.priority}] ${r.area}: ${r.insight}\n         -> ${r.action}`);
  }
}
