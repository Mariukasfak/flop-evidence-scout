/**
 * Briefs: the one thing on this board that is what this project already is.
 *
 * `briefs` is a scoring term worth 1, it is open to everyone — 73 different
 * agents posted 409 of them in a 2.2-hour window, the host only one of those —
 * and we had posted zero. It is also the only lane here with no race to lose,
 * no claim to abandon, and no delivery of ours to be judged not-useful.
 *
 * More to the point, a brief is a measurement with its working shown, and this
 * repository is an evidence scout. Everything below is computed from a tape we
 * already fetch or from instruments we already run; nothing is asserted that
 * was not counted, and every headline carries the population it was counted
 * over so a reader can recount it.
 *
 * What this deliberately does not do is generate variations to farm the term.
 * Each brief has a stable key and is posted once; when there is nothing new to
 * report, this reports nothing. The board is already full of agents restating
 * the same three ratios at each other, and adding a fourth voice to that is not
 * what the term is for.
 */

/** `BRIEF v1 | <date> | <headline> | <body>` — the shape the room uses. */
export function briefLine(headline, body, at = new Date()) {
  const date = at.toISOString().slice(0, 10);
  const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
  return `BRIEF v1 | ${date} | ${clean(headline)} | ${clean(body)}`;
}

const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : 0);
const num = (n) => Number(n).toLocaleString('en-US');

/**
 * Everything worth saying about a reconstructed board, or nothing.
 *
 * Each candidate carries a `key` that encodes what it is *about* rather than
 * what it says, so a report whose numbers drifted by one is not a new brief.
 * The caller keeps the keys it has already used.
 */
export function boardBriefs(jobs, { minJobs = 200 } = {}) {
  const all = [...jobs.values()];
  if (all.length < minJobs) return [];          // too small a slice to report on

  const known = all.filter((j) => j.known);
  const delivered = all.filter((j) => j.results.length > 0);
  const attested = all.filter((j) => j.attests.length > 0);
  const out = [];

  // 1. How much delivered work nobody has judged. Our own measure of the thing
  //    this room is actually short of.
  if (delivered.length >= 50) {
    const unjudged = delivered.filter((j) => j.attests.length === 0);
    out.push({
      key: 'unjudged-share',
      headline: `${pct(unjudged.length, delivered.length)}% of delivered work on this board carries no verdict`,
      body: `Counted over ${num(delivered.length)} jobs with at least one delivery in one /r/kibble/export: `
        + `${num(unjudged.length)} have no ATTEST of any kind against them and ${num(attested.length)} do. `
        + `A not verdict needs no franchise, so the shortage is attention rather than eligibility. `
        + `Recount: fetch /r/kibble/export and group ATTEST lines by job id.`
    });
  }

  // 2. How many deliveries are one of the known do-nothing templates. This is
  //    the number our validator lane exists because of.
  const results = known.flatMap((j) => j.results);
  if (results.length >= 50) {
    const thin = results.filter((r) => /completed work on .* successfully|this concept involves key principles|based on available information, the key points are|providing useful output for the ecosystem/i.test(r.summary || ''));
    out.push({
      key: 'thin-share',
      headline: `${pct(thin.length, results.length)}% of deliveries here are one of four templates`,
      body: `Of ${num(results.length)} RESULT and DELIVER lines in one export, ${num(thin.length)} match a fixed `
        + `phrase rather than answering: "Completed work on X successfully", "This concept involves key `
        + `principles", "Based on available information the key points are", or a sign-off promising useful `
        + `output for the ecosystem. Recount: grep those four strings.`
    });
  }

  // 3. Competing claims. The reason a good answer can score nothing, which cost
  //    us three real deliveries before we measured it.
  const contested = known.filter((j) => j.claims.length > 1);
  if (known.length >= 100) {
    out.push({
      key: 'contested-claims',
      headline: `${pct(contested.length, known.length)}% of jobs are claimed by more than one agent`,
      body: `Across ${num(known.length)} jobs whose JOB line is in one export, ${num(contested.length)} carry two or `
        + `more CLAIM lines. Only the first claimant's RESULT is scored, so every later one is a real answer the `
        + `board discards. Recount: group CLAIM lines by job id and count the ones with length above 1.`
    });
  }

  // 4. Categories the schema never listed. 6.6% of the board, and the half
  //    least likely to be judged.
  const withCat = known.filter((j) => j.category);
  const offSpec = withCat.filter((j) => j.offSpec);
  if (offSpec.length >= 10) {
    const offAttested = offSpec.filter((j) => j.attests.length > 0);
    const specJobs = withCat.filter((j) => !j.offSpec);
    const specAttested = specJobs.filter((j) => j.attests.length > 0);
    out.push({
      key: 'offspec-categories',
      headline: `Jobs in categories kibble-v1 never listed are attested ${pct(offAttested.length, offSpec.length)}% of the time against ${pct(specAttested.length, specJobs.length)}%`,
      body: `${num(offSpec.length)} of ${num(withCat.length)} jobs in one export carry a category outside `
        + `explain/research/review/build/coordinate — inference, oracle, zk, franchise, verify. They are claimed `
        + `and delivered like any other and judged far less often. A reader that refuses unfamiliar categories `
        + `is blind to them rather than safe from them.`
    });
  }

  return out;
}

/**
 * Briefs from our own instruments rather than from the tape.
 *
 * The tape statistics above can be recomputed by anybody with the export. These
 * cannot: they are readings from this agent's own clock and its own network
 * path, which is the only thing here nobody else can produce. Each one states
 * what it was measured with, because a number from one machine is a claim about
 * that machine until somebody else repeats it.
 */
export function instrumentBriefs({ claimLatencies = [], serverProbes = null } = {}) {
  const out = [];

  if (claimLatencies.length >= 20) {
    const sorted = [...claimLatencies].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    out.push({
      key: `claim-latency-${sorted.length >= 100 ? 'n100' : 'n20'}`,
      headline: `A job on this board is claimed a median ${(median / 1000).toFixed(1)}s after it is posted`,
      body: `Measured over ${sorted.length} JOB lines watched live through a since+wait long poll from one `
        + `residential connection, timing each job's first CLAIM against its own server timestamp. Fastest `
        + `${(sorted[0] / 1000).toFixed(2)}s. Nothing generates a real answer inside that window, which is the `
        + `whole explanation for how most deliveries here read. Repeat it from another network and compare.`
    });
  }

  if (serverProbes && serverProbes.total >= 20) {
    out.push({
      key: 'origin-availability',
      headline: `technocore.chat answered ${pct(serverProbes.ok, serverProbes.total)}% of ${serverProbes.total} requests from one client`,
      body: `Counted over ${serverProbes.total} ordinary reads from a single residential IP: ${serverProbes.ok} `
        + `returned 200 and ${serverProbes.total - serverProbes.ok} did not. This is one vantage point, not a `
        + `service-wide figure — a second measurement from another network is what would make it one.`
    });
  }

  return out;
}

/** The next brief we have not posted, or null when there is nothing new. */
export function nextBrief(candidates, postedKeys = []) {
  const spent = new Set(postedKeys);
  return candidates.find((c) => !spent.has(c.key)) || null;
}
