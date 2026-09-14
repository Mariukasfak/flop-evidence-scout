/**
 * Does adaptive polling actually close the gap? Measure it before wiring it in.
 *
 * Runs RoomFollower read-only against the live venue for a few minutes and prints,
 * per room, how many records fell between our cursor and the response. The number
 * to beat is the daemon's own: over the 24 h to 2026-09-14, reading once per 64 s
 * at limit=200, `/r/lobby` had a gap on 1,352 of 1,353 reads and 86.6% of the room
 * never reached the consumer.
 *
 *   node tools/follow-rooms-probe.mjs --minutes=5 --rooms=lobby,technocore,tclk-offers
 */
import { TechnocoreClient } from '../src/technocore-client.mjs';
import { RoomFollower } from '../src/room-follower.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const minutes = Number(arg('minutes', '5')) || 5;
const rooms = String(arg('rooms', 'lobby,technocore,tclk-offers')).split(',').map((r) => r.trim()).filter(Boolean);

const client = new TechnocoreClient({ baseUrl: 'https://technocore.chat', readOnly: true });
const follower = new RoomFollower({ client, rooms, readWindow: 200 });

console.log(`[probe] following ${rooms.join(', ')} for ${minutes} min`);
follower.start();

const started = Date.now();
const tick = setInterval(() => {
  const elapsed = ((Date.now() - started) / 60_000).toFixed(1);
  const s = follower.stats();
  const line = rooms.map((r) => `${r}: ${s[r].reads}r ${s[r].ratePerMin ?? '?'}/min every ${Math.round(s[r].intervalMs / 1000)}s gap=${s[r].gapRecords}`).join(' | ');
  console.log(`[probe] ${elapsed}m  ${line}`);
}, 60_000);
if (typeof tick.unref === 'function') tick.unref();

await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
clearInterval(tick);
follower.stop();

const stats = follower.stats();
const elapsedMin = (Date.now() - started) / 60_000;

console.log('\n[probe] === result ===');
for (const room of rooms) {
  const s = stats[room];
  const produced = Math.round((s.ratePerMin || 0) * elapsedMin);
  const delivered = Math.max(0, produced - s.gapRecords);
  const share = produced > 0 ? (delivered / produced) * 100 : 0;
  /**
   * What one read per 64 s would have missed over the same window, at the same
   * measured rate: each cycle produces rate*64/60 records and delivers at most
   * 200 of them. Stated as a comparison, not as a measurement of the daemon --
   * the daemon's own figure is in its logs.
   */
  const perCycle = (s.ratePerMin || 0) * (64 / 60);
  const cycles = (elapsedMin * 60) / 64;
  const wouldMiss = Math.max(0, Math.round((perCycle - 200) * cycles));
  console.log(
    `${room.padEnd(14)} rate=${String(s.ratePerMin ?? '?').padStart(5)}/min  every ${String(Math.round(s.intervalMs / 1000)).padStart(2)}s  `
    + `reads=${String(s.reads).padStart(3)}  gap=${String(s.gapRecords).padStart(7)}  delivered=${share.toFixed(1)}%  `
    + `(at 64s cadence it would have missed ~${wouldMiss})`
  );
  if (s.errors) console.log(`${' '.repeat(14)} errors=${s.errors} dropped=${s.dropped}`);
}
const totalReads = rooms.reduce((acc, r) => acc + stats[r].reads, 0);
console.log(`[probe] ${totalReads} reads in ${elapsedMin.toFixed(1)} min = ${(totalReads / elapsedMin).toFixed(1)}/min of a 600/min budget`);
