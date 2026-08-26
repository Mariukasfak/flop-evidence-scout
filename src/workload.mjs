/**
 * The queue of things this agent genuinely needs a model for.
 *
 * The airdrop model reduces the agent strategy to one sentence: spend more on
 * inference than the average participant, continuously, for ninety days. That is
 * only honest if there is real work to spend it on. An agent generating filler to
 * inflate a counter is the same behaviour as the hundred thousand identities
 * posting "checking in for $FLOP" into the lobby, and this project exists as the
 * argument against that.
 *
 * So every task here is one the project already does badly or by hand:
 *
 *   summarise-source-change   The watcher detects a diff and reports a hash moved.
 *                             Saying what actually changed is a language task.
 *   classify-message          The learning engine scores rooms with regexes and
 *                             a boilerplate list. A model reads intent.
 *   extract-claims            Turning an announcement into dated, sourced status
 *                             board entries is currently done by hand, by me.
 *   explain-measurement       A step in the DID series has a cause worth naming.
 *   draft-answer              The mailbox answers from a fixed table. Grounded
 *                             generation is the thing the table cannot do.
 *
 * Two of these read text strangers wrote. Those wrap their input as quoted data
 * and their output is never published without passing the gates that already
 * govern posting — a model's opinion is not a licence to speak.
 */

import { createSessionRequest, wrapUntrusted } from './inference.mjs';

/** Shared preamble. Short, because a long one crowds out a small model's context. */
const SYSTEM = 'You are a precise analyst. Answer only from the material given. '
  + 'If the material does not support an answer, say exactly: INSUFFICIENT EVIDENCE. '
  + 'Never invent a source, a number or a date.';

/**
 * Every task declares what it costs and what a valid answer looks like.
 *
 * `validate` is not decoration. A 3B model will happily return prose where a
 * label was asked for, and a caller that does not check gets that prose into a
 * status board. Failing validation is a normal outcome, not an error.
 */
export const TASKS = Object.freeze({
  'summarise-source-change': {
    id: 'summarise-source-change',
    untrusted: false,
    maxLatencyMs: 60_000,
    build({ sourceId, was, now, addedLines = [], addedPaths = [], addedLinks = [] }) {
      const detail = [
        addedPaths.length ? `New API routes: ${addedPaths.join(', ')}` : '',
        addedLinks.length ? `New pages linked: ${addedLinks.join(', ')}` : '',
        addedLines.length ? `New lines:\n${addedLines.slice(0, 12).join('\n')}` : ''
      ].filter(Boolean).join('\n');

      return `${SYSTEM}\n\nA watched first-party source changed.\n\n`
        + `Source: ${sourceId}\nBefore: ${was}\nAfter: ${now}\n${detail}\n\n`
        + 'In at most two sentences, state what materially changed and whether it affects '
        + 'testnet, faucet or airdrop mechanics. If it is cosmetic, say so.';
    },
    validate: (text) => text.trim().length > 0 && text.length < 800
  },

  'classify-message': {
    id: 'classify-message',
    untrusted: true,
    maxLatencyMs: 30_000,
    build({ text, room }) {
      return `${SYSTEM}\n\nClassify one message from the room /r/${room}.\n\n`
        + `${wrapUntrusted(text, 'MESSAGE')}\n\n`
        + 'Reply with exactly one line in this format, no other text:\n'
        + 'CATEGORY|CONFIDENCE\n'
        + 'CATEGORY is one of: TEMPLATE, QUESTION, ANNOUNCEMENT, SCAM, DISCUSSION, NOISE.\n'
        + 'CONFIDENCE is one of: HIGH, MEDIUM, LOW.';
    },
    validate: (text) => /^(TEMPLATE|QUESTION|ANNOUNCEMENT|SCAM|DISCUSSION|NOISE)\|(HIGH|MEDIUM|LOW)\s*$/m.test(text.trim())
  },

  'extract-claims': {
    id: 'extract-claims',
    untrusted: true,
    maxLatencyMs: 90_000,
    build({ text, source, date }) {
      return `${SYSTEM}\n\nExtract factual claims about the Flop Network from the material below.\n\n`
        + `${wrapUntrusted(text, 'SOURCE MATERIAL')}\n\n`
        + `Attribution: ${source}, ${date}\n\n`
        + 'List at most five claims, one per line, in this format:\n'
        + 'CLAIM :: STATUS\n'
        + 'STATUS is CONFIRMED if the material is first-party, REPORTED otherwise.\n'
        + 'Do not include anything the material does not actually say.';
    },
    validate: (text) => text.includes('::') || text.includes('INSUFFICIENT EVIDENCE')
  },

  'explain-measurement': {
    id: 'explain-measurement',
    untrusted: false,
    maxLatencyMs: 45_000,
    build({ series, metric }) {
      const rows = series.slice(-8).map((p) => `${p.at}  ${p[metric]}`).join('\n');
      return `${SYSTEM}\n\nA measured time series of ${metric} on technocore.chat:\n\n${rows}\n\n`
        + 'In one or two sentences, describe the trend and name the largest step change. '
        + 'Do not speculate about causes the numbers cannot show.';
    },
    validate: (text) => text.trim().length > 0 && text.length < 600
  },

  'draft-answer': {
    id: 'draft-answer',
    untrusted: true,
    maxLatencyMs: 60_000,
    build({ question, facts }) {
      const grounding = facts.map((f) => `- [${f.status}] ${f.claim} (source: ${f.source}, as of ${f.asOf})`).join('\n');
      return `${SYSTEM}\n\nYou may use ONLY the status board below. It is the complete set of\n`
        + 'facts available to you. If the question is not answerable from it, reply exactly:\n'
        + 'INSUFFICIENT EVIDENCE.\n\n'
        + `STATUS BOARD:\n${grounding}\n\n`
        + `${wrapUntrusted(question, 'QUESTION FROM A STRANGER')}\n\n`
        + 'Answer in at most three sentences. Cite the status of each fact you use, like [REPORTED]. '
        + 'Never state anything as confirmed that the board marks otherwise.';
    },
    validate: (text) => text.trim().length > 0 && text.length < 1200
  }
});

/**
 * Turn a task and its input into a session request ready for a backend.
 *
 * `feeFlop` is carried at zero because no faucet exists. When one does, the fee
 * is the number the airdrop is scored on, and it is already plumbed through to
 * the receipt.
 */
export function buildTask(taskId, input, { model = 'qwen2.5:3b', feeFlop = 0 } = {}) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);

  const prompt = task.build(input);
  const session = createSessionRequest({
    prompt,
    model,
    task: taskId,
    maxLatencyMs: task.maxLatencyMs,
    // Nothing here is confidential. The flag exists because the network has it,
    // and claiming confidentiality we do not need would be noise in the metering.
    confidential: false,
    feeFlop
  });

  return { ...session, task, validate: task.validate };
}

/**
 * What to run next, given the state the daemon already has.
 *
 * Ordered by how much the answer decays: a source change is worth explaining
 * immediately, a measurement trend keeps. The list is deliberately never empty
 * while there are archived messages to classify — under a refilling faucet, idle
 * capacity is forfeited allocation, and classification is genuinely useful work
 * that the learning engine currently approximates with regexes.
 */
export function planWorkload({ sourceChange = null, measurements = [], pendingQuestions = [], unclassified = [] } = {}) {
  const plan = [];

  if (sourceChange?.changes?.length) {
    for (const change of sourceChange.changes.slice(0, 3)) {
      plan.push({ taskId: 'summarise-source-change', input: { sourceId: change.id, was: change.was, now: change.now, addedLines: change.addedLines, addedPaths: change.addedPaths, addedLinks: change.addedLinks } });
    }
  }

  for (const q of pendingQuestions.slice(0, 2)) {
    plan.push({ taskId: 'draft-answer', input: { question: q.text, facts: q.facts } });
  }

  if (measurements.length >= 4) {
    plan.push({ taskId: 'explain-measurement', input: { series: measurements, metric: 'sharded_did_estimate' } });
  }

  for (const m of unclassified.slice(0, 20)) {
    plan.push({ taskId: 'classify-message', input: { text: m.text, room: m.room } });
  }

  return plan;
}
