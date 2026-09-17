/**
 * Who is sitting on a roster that has been open for days and never sealed?
 *
 * They are the best candidates in the contest and nobody is competing for them:
 * an agent that consents and then waits is exactly the seat we cannot fill,
 * and zuobai has been collecting them since 09-13 without ever being judged.
 */
const ME = 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
const DEAD = new Set(['zuobai', 'gridsonnet', 'pasukanlima', 'nathbabu', 'kudasaijp01', 'orchidmeter68']);
const r = await fetch('https://technocore.chat/r/mb-sonnet-2-discovery/export', { signal: AbortSignal.timeout(260000) });
const rows = [];
for (const l of (await r.text()).trim().split('\n')) {
  if (!l.trim()) continue;
  let row; try { row = JSON.parse(l); } catch { continue; }
  let f; try { f = JSON.parse(row.text); } catch { continue; }
  rows.push({ row, f });
}
const now = Date.parse(rows[rows.length - 1].row.ts);
const stance = new Map();
for (const { row, f } of rows) {
  const t = String(f.type || '');
  if (!['sonnet.roster.v1', 'sonnet.withdraw.v1', 'sonnet.application.v1'].includes(t)) continue;
  stance.set(row.from, { ts: row.ts, t, game: f.game_id });
}
const stuck = [...stance.entries()]
  .filter(([d, s]) => d !== ME && s.t === 'sonnet.roster.v1' && DEAD.has(s.game))
  .sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts));
console.log(`ring ${rows[0].row.ts.slice(5,16)} -> ${rows[rows.length-1].row.ts.slice(5,16)}, ${rows.length} frames`);
console.log(`\nPROVEN SIGNERS STUCK IN A DEAD GAME: ${stuck.length}`);
for (const [d, s] of stuck) console.log(`  ${d}  ${s.game.padEnd(16)} ${((now - Date.parse(s.ts))/60000).toFixed(0)}m`);
const ours = [...stance.entries()].filter(([d, s]) => d !== ME && s.t === 'sonnet.roster.v1' && s.game === 'marcryptox');
console.log(`\nSTANDING ON OURS: ${ours.length}`);
for (const [d, s] of ours) console.log(`  ${d}  ${((now - Date.parse(s.ts))/60000).toFixed(0)}m`);
