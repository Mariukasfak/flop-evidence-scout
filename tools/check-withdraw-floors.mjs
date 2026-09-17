/**
 * Every place the agent can cancel its own roster, and whether it has to wait
 * for the referee first.
 *
 * Five separate branches made the same mistake on 2026-09-17 -- the twelve
 * minute cycle, the proven-signer swap, the departure rule, the regather rule
 * and the switch rule -- and each was found only after it had already spent an
 * hour we did not have. A roster becomes a poem room when the referee seals it
 * and at no other moment, so a branch that withdraws before the referee has had
 * one queue length to look is a branch that can never produce anything.
 *
 * Exemptions are real and are marked in the source with `FLOOR-EXEMPT:` plus
 * the reason. There are four: the contraction (its verdict is already a
 * refusal), an unregistrable member (that roster can never seal at all), the
 * switch (its floor is inside `fresherOffer`), and standing down from an empty
 * roster (no queue position to protect).
 *
 *   node tools/check-withdraw-floors.mjs tools/sonnet2-agent.mjs
 */
import fs from 'node:fs';

const file = process.argv[2] || 'tools/sonnet2-agent.mjs';
const src = fs.readFileSync(file, 'utf8').split('\n');
const FLOOR = /REFEREE_LAG_MIN|heldMin >=|heldMinNow >=|holdMinutesFor|CONSENT_TIMEOUT_MIN/;

let bad = 0;
for (const [n, line] of src.entries()) {
  if (!line.includes("type: 'sonnet.withdraw.v1'")) continue;
  /** Walk back to the branch that guards this post, and to any exemption note. */
  let i = n;
  while (i > 0 && !/^\s*(\} else if|if) \(/.test(src[i])) i--;
  let cond = '';
  for (let j = i; j < Math.min(i + 5, src.length); j++) {
    cond += `${src[j].trim()} `;
    if (src[j].includes('{')) break;
  }
  const exempt = src.slice(Math.max(0, i - 2), i + 1).some((l) => l.includes('FLOOR-EXEMPT'));
  let id = '?';
  for (let j = n; j < Math.min(n + 8, src.length); j++) {
    const m = src[j].match(/request_id: `([a-z-]+)/);
    if (m) { id = m[1]; break; }
  }
  const ok = FLOOR.test(cond) || exempt;
  if (!ok) bad += 1;
  console.log(`${String(n + 1).padStart(5)}  ${id.padEnd(11)}  `
    + `${(exempt ? 'exempt' : ok ? 'floor' : 'NO FLOOR').padEnd(9)}  ${cond.replace(/\s+/g, ' ').slice(0, 84)}`);
}
console.log('');
console.log(bad
  ? `${bad} withdrawal(s) can fire before the referee has judged the roster.`
  : 'Every withdrawal waits for the referee, or says in the source why it need not.');
process.exitCode = bad ? 1 : 0;
