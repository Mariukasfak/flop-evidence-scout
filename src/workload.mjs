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

import crypto from 'node:crypto';

import { createSessionRequest, wrapUntrusted } from './inference.mjs';
import { messageSkeleton } from './learning-engine.mjs';

/**
 * A stable key for "this exact piece of work".
 *
 * Without one the planner hands back the same twenty messages every cycle,
 * because it plans from the last room read and a room read returns mostly what
 * it returned a minute ago. At a one-minute interval that is twenty sessions a
 * minute re-deciding questions already answered — wasted disk today and, the
 * moment a session costs $FLOP, wasted budget from the exact pool the airdrop
 * is scored on.
 */
export function jobKey(taskId, input) {
  /**
   * Classification keys on the message's TEMPLATE, not its text.
   *
   * Keying on exact text looked like deduplication and achieved almost nothing:
   * /r/lobby runs at over a thousand messages a minute, so every read returns
   * twenty genuinely new strings — and they are the same message. Our own
   * template analysis found one opening phrase repeated 55-64 times across four
   * rooms, and rooms 69-78% templated.
   *
   * So the honest unit of work is "a kind of message we have not seen", not "a
   * string we have not seen". One classification per template answers the
   * question; the next five hundred instances answer it again. With a free local
   * model that is wasted disk. With sessions priced in $FLOP it is the airdrop
   * budget spent re-reading spam.
   */
  const subject = taskId === 'classify-message'
    ? messageSkeleton(input?.text ?? '') || String(input?.text ?? '')
    : input?.text ?? input?.question ?? input?.sourceId ?? JSON.stringify(input ?? {});

  return crypto.createHash('sha256').update(`${taskId}|${subject}`, 'utf8').digest('hex').slice(0, 24);
}

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
      /**
       * Named placeholders, then examples — because a small model answers with
       * the placeholder.
       *
       * The first version said "reply in this format: CATEGORY|CONFIDENCE", and
       * the first real model to see it replied, literally, `CATEGORY|CONFIDENCE`
       * on two of four messages — and did it on the ambiguous ones, where it had
       * least to go on. The validator caught every one, so nothing bad reached
       * the status board; it simply threw away half the work.
       *
       * Nothing but a real model could have surfaced this. The simulated backend
       * returns a digest and never reads an instruction, so a prompt that reads
       * as a fill-in-the-blank template looked fine for 10,845 sessions.
       */
      return `${SYSTEM}\n\nClassify one message from the room /r/${room}.\n\n`
        + `${wrapUntrusted(text, 'MESSAGE')}\n\n`
        + 'Answer with one word from this list: TEMPLATE, QUESTION, ANNOUNCEMENT, SCAM, DISCUSSION, NOISE.\n'
        + 'Then a pipe character, then one word from this list: HIGH, MEDIUM, LOW.\n'
        + 'Write nothing else — no explanation, no label, no quotes.\n\n'
        + 'Examples of correct answers:\n'
        + 'QUESTION|HIGH\n'
        + 'TEMPLATE|MEDIUM\n'
        + 'NOISE|LOW';
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
export function planWorkload({ sourceChange = null, measurements = [], pendingQuestions = [], unclassified = [], seen = null } = {}) {
  const plan = [];
  /**
   * Two things can make a job redundant, and only one of them was checked.
   *
   * `seen` catches work done on a PREVIOUS cycle. Nothing caught the same job
   * appearing twice in the SAME plan — and that is the common case, not the
   * exotic one: /r/lobby is 69-78% templated, so a single read of twenty
   * messages routinely collapses to one distinct piece of work.
   *
   * Measured on the real thing: twenty messages, one distinct job, nineteen
   * duplicates. Free against a simulated backend that answered instantly, which
   * is why it survived. Against a local model at ~3 s a session it is 57 s of
   * GPU spent re-answering one question, inside a 24 s cycle deadline — so the
   * duplicates were not merely wasteful, they were consuming the entire budget
   * and starving every other kind of work.
   */
  const planned = new Set();
  const isNew = (taskId, input) => {
    const key = jobKey(taskId, input);
    if (planned.has(key)) return false;
    if (seen && seen.has(key)) return false;
    planned.add(key);
    return true;
  };

  if (sourceChange?.changes?.length) {
    for (const change of sourceChange.changes.slice(0, 3)) {
      const input = { sourceId: change.id, was: change.was, now: change.now, addedLines: change.addedLines, addedPaths: change.addedPaths, addedLinks: change.addedLinks };
      if (isNew('summarise-source-change', input)) plan.push({ taskId: 'summarise-source-change', input });
    }
  }

  for (const q of pendingQuestions.slice(0, 2)) {
    const input = { question: q.text, facts: q.facts };
    if (isNew('draft-answer', input)) plan.push({ taskId: 'draft-answer', input });
  }

  // Guarded like every other task. Without the check this one job re-ran every
  // cycle forever: the series only moves when a measurement lands, so explaining
  // it a second time before then buys nothing. The key covers the whole series,
  // so a new observation makes it eligible again — which is exactly when the
  // explanation is worth having.
  if (measurements.length >= 4) {
    const input = { series: measurements, metric: 'sharded_did_estimate' };
    if (isNew('explain-measurement', input)) plan.push({ taskId: 'explain-measurement', input });
  }

  // Filtered BEFORE the cap: twenty already-classified messages would otherwise
  // crowd out the new ones, and the plan would stay permanently busy doing nothing.
  let classified = 0;
  for (const m of unclassified) {
    const input = { text: m.text, room: m.room };
    if (!isNew('classify-message', input)) continue;
    plan.push({ taskId: 'classify-message', input });
    if (++classified >= 20) break;
  }

  return plan;
}
