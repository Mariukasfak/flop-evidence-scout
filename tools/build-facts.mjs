/**
 * Renders the status board to docs/flop-facts.md from src/flop-facts.mjs.
 *
 * The published page has always claimed it was "regenerated from
 * src/flop-facts.mjs". Nothing regenerated it. Every update since the board was
 * created was made twice, by hand, and the two could disagree without anything
 * noticing — on a project whose entire argument is that its numbers are checkable.
 *
 * This closes that. test/flop-facts.test.mjs now fails if the committed markdown
 * has drifted from the module, so the claim on the page is enforced rather than
 * asserted.
 *
 * Run: node tools/build-facts.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';

import { renderFactsMarkdown } from '../src/flop-facts.mjs';

const OUT = path.resolve('docs/flop-facts.md');
const check = process.argv.includes('--check');
const rendered = renderFactsMarkdown();

if (check) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== rendered) {
    console.error('docs/flop-facts.md is out of date. Run: node tools/build-facts.mjs');
    process.exit(1);
  }
  console.log('docs/flop-facts.md matches src/flop-facts.mjs');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, rendered, 'utf8');
  console.log(`Wrote ${OUT}`);
}
