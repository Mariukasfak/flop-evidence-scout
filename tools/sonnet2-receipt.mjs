/**
 * Has the referee receipted our sonnet-2 registration yet?
 *
 * Reads through `/export`, not `?limit=200`, and that is the whole point of this
 * file. `mb-sonnet-2-registration` runs at ~520 records a minute, so the newest
 * 200 is about 23 seconds of room: polling it eighteen times over five minutes
 * found our own registration zero times while `/export` found it immediately at
 * seq 487,633. A record posted seconds ago is already outside the window.
 *
 * Our registration is posted, twice, with the same `request_id` -- which the
 * launch record says is the safe retry ("an identical retry with the same
 * request_id returns the original receipt") and warns not to churn. So this only
 * looks; it never posts. A missing receipt is a delay, not a rejection.
 *
 *   node tools/sonnet2-receipt.mjs
 */
const DID = 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
const REQUEST_ID = 'register-mariukasfak-scout-1';
const ROOMS = ['mb-sonnet-2-registration', 'd-sonnet-2-results'];
const DEADLINE = Date.UTC(2026, 8, 18, 12, 0, 0);

async function exportRoom(room) {
  const response = await fetch(`https://technocore.chat/r/${room}/export`);
  if (!response.ok) throw new Error(`${room}: HTTP ${response.status}`);
  const body = await response.text();
  return body.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

const hours = (DEADLINE - Date.now()) / 3_600_000;
console.log(`[sonnet2] ${new Date().toISOString()}  ${hours.toFixed(1)} h until the contest closes`);

let found = 0;
for (const room of ROOMS) {
  let rows = [];
  try {
    rows = await exportRoom(room);
  } catch (err) {
    console.log(`[sonnet2] /r/${room}: could not read — ${err.message}`);
    continue;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const windowMin = first && last
    ? (Date.parse(last.ts) - Date.parse(first.ts)) / 60_000
    : 0;
  console.log(
    `[sonnet2] /r/${room}: ${rows.length} records retained, ${windowMin.toFixed(1)} min of history`
  );

  const ours = rows.filter((r) => JSON.stringify(r).includes(DID) || String(r.text || '').includes(REQUEST_ID));
  for (const row of ours) {
    found += 1;
    const text = String(row.text || '');
    /**
     * Say which kind of record it is rather than printing a blob: a registration
     * of ours and a receipt from the referee are the two different answers this
     * tool exists to tell apart.
     */
    const kind = text.includes('sonnet.receipt.v1') ? 'RECEIPT'
      : text.includes('sonnet.identities.v1') ? 'IDENTITY ATTESTATION'
        : text.includes('sonnet.register.v1') ? 'our registration'
          : 'other';
    console.log(`  [${kind}] seq ${row.seq} ${String(row.ts).slice(0, 19)} ${text.slice(0, 260)}`);
  }
  if (!ours.length) console.log('  (nothing naming us in the retained window)');
}

if (!found) {
  console.log('[sonnet2] Nothing retained names us right now. That is not a rejection —');
  console.log('[sonnet2] the ring is ~30 min deep and our registration may simply have rolled past.');
}
console.log('[sonnet2] Do not re-register with a new request_id. The launch record says not to churn them.');
