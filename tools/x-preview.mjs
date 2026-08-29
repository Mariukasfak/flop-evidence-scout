/**
 * What the agent would post to X, without posting anything.
 *
 * This is the review surface. The operator's own name is on that timeline, so
 * the sequence is always: read what it would say, then decide whether it may.
 * Nothing here can publish — `publishToX` needs `live: true` and credentials,
 * and this file passes neither.
 *
 * Run: node tools/x-preview.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { FACTS } from '../src/flop-facts.mjs';
import {
  selectXPost, buildRefutationPost, loadXConfig, publishToX,
  MAX_POST_CHARS, MAX_POSTS_PER_DAY
} from '../src/x-publisher.mjs';
import { orderForX } from '../src/x-copy.mjs';

const HISTORY = path.resolve('data/x-published.json');

function readHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const published = readHistory();
const configured = loadXConfig() !== null;

console.log('\n=== WHAT WOULD GO TO X ===\n');
console.log(`  credentials     ${configured ? 'configured' : 'NOT configured — nothing can be posted'}`);
console.log(`  already posted  ${published.length}`);
console.log(`  daily ceiling   ${MAX_POSTS_PER_DAY}`);

const { post, reason } = selectXPost({ facts: FACTS, published });

console.log(`\n  decision        ${reason}\n`);

if (post) {
  console.log('  ' + '-'.repeat(66));
  for (const line of post.text.split('\n')) console.log(`  ${line}`);
  console.log('  ' + '-'.repeat(66));
  console.log(`  ${post.chars} of ${MAX_POST_CHARS} characters · key ${post.key}\n`);

  // Proves the dry-run path really is inert, on the real post, every run.
  const attempt = await publishToX(post);
  console.log(`  live attempt without asking: posted=${attempt.posted}, reason=${attempt.reason}\n`);
}

console.log('  EVERYTHING IT COULD EVER SAY\n');
const all = orderForX(FACTS.filter((f) => f.status === 'REFUTED')).map(buildRefutationPost).filter(Boolean);
for (const p of all) {
  // The OPENING line. Whether six posts read as six posts or as one bot is
  // decided by their first lines, so that is what a review has to show.
  const first = p.text.split('\n')[0] || '';
  console.log(`  [${String(p.chars).padStart(3)}] ${first.slice(0, 84)}`);
}
console.log(`\n  ${all.length} refutations total. One a day at most, each posted once, never on a timer.`);
console.log('  Only REFUTED claims are eligible — no status updates, no milestones, no filler.\n');
