/**
 * Draws the project's hero image from the measurement series.
 *
 * Deliberately original artwork. Other repositories in this space embed Flop
 * Labs' banner and screenshots of their posts; putting someone else's brand at
 * the top of an unaffiliated page implies an endorsement that does not exist, so
 * this draws its own thing instead.
 *
 * The picture is the thesis: a field of faint dots for the identities registered
 * on the network — one dot per thousand, counted from the real figure — with two
 * lit nodes for the agents this repository actually runs. It restates itself
 * every time the numbers move, which is the point.
 *
 * Run: node tools/render-hero.mjs   (writes docs/hero.svg)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SERIES = path.resolve('docs/measurements/timeseries.json');
const OUT = path.resolve('docs/hero.svg');

const W = 1280;
const H = 480;

const series = JSON.parse(fs.readFileSync(SERIES, 'utf8'));
const last = series.observations[series.observations.length - 1];
const totalDids = last.sharded_did_estimate + last.legacy_did_count;
const dotCount = Math.max(40, Math.min(420, Math.round(totalDids / 300)));

/**
 * Deterministic placement: the same data must draw the same picture, or every
 * rebuild is a spurious diff in git. A counter-mode hash is enough randomness
 * for a scatter and costs nothing.
 */
function positions(count, seedText) {
  const out = [];
  let i = 0;
  while (out.length < count) {
    const h = crypto.createHash('sha256').update(`${seedText}:${i++}`).digest();
    const x = 60 + (h.readUInt32BE(0) / 0xffffffff) * (W - 120);
    const y = 70 + (h.readUInt32BE(4) / 0xffffffff) * (H - 150);
    const r = 1.1 + (h[8] / 255) * 1.5;
    // Keep the centre clear so the headline stays readable over the field.
    const inTextBand = y > 180 && y < 300 && x > 60 && x < 760;
    if (!inTextBand) out.push({ x, y, r, o: 0.10 + (h[9] / 255) * 0.30 });
  }
  return out;
}

const dots = positions(dotCount, `flop-evidence-scout:${last.at}`)
  .map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(2)}" fill="var(--hero-swarm,#7B8494)" opacity="${d.o.toFixed(2)}"/>`)
  .join('\n  ');

const fmt = (v) => Number(v).toLocaleString('en-US');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img"
  aria-label="Two signed agents among roughly ${fmt(totalDids)} identities registered on Technocore">
  <title>FLOP Evidence Scout</title>
  <desc>A field of faint dots representing the identities registered on technocore.chat, with two lit nodes for the agents this repository runs.</desc>

  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="var(--hero-signal,#A25C00)" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="var(--hero-signal,#A25C00)" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="var(--hero-bg,#F6F7F9)"/>

  <!-- the swarm: one dot per ~300 registered identities -->
  ${dots}

  <!-- the two agents this repository actually operates -->
  <circle cx="980" cy="196" r="58" fill="url(#glow)"/>
  <circle cx="1108" cy="308" r="58" fill="url(#glow)"/>
  <line x1="980" y1="196" x2="1108" y2="308" stroke="var(--hero-signal,#A25C00)" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7"/>
  <text x="1044" y="245" font-family="Archivo,system-ui,sans-serif" font-size="11" font-weight="600"
        fill="var(--hero-signal,#A25C00)" text-anchor="middle" letter-spacing="0.08em" transform="rotate(41 1044 252)">SIGNED</text>

  <circle cx="980" cy="196" r="9" fill="var(--hero-signal,#A25C00)"/>
  <circle cx="1108" cy="308" r="9" fill="var(--hero-signal,#A25C00)"/>
  <text x="980" y="172" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-ink,#14181F)" text-anchor="middle">Scout</text>
  <text x="1108" y="340" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-ink,#14181F)" text-anchor="middle">Scribe</text>

  <text x="60" y="150" font-family="Archivo,system-ui,sans-serif" font-size="13" font-weight="600"
        fill="var(--hero-signal,#A25C00)" letter-spacing="0.16em">FLOP EVIDENCE SCOUT</text>

  <text x="60" y="216" font-family="Archivo,system-ui,sans-serif" font-size="44" font-weight="700"
        fill="var(--hero-ink,#14181F)" letter-spacing="-0.02em">Two agents that can prove</text>
  <text x="60" y="266" font-family="Archivo,system-ui,sans-serif" font-size="44" font-weight="700"
        fill="var(--hero-ink,#14181F)" letter-spacing="-0.02em">what they did.</text>

  <text x="60" y="310" font-family="Source Serif 4,Georgia,serif" font-size="17"
        fill="var(--hero-muted,#4A5261)">Autonomous, continuously running, and independently verifiable —</text>
  <text x="60" y="334" font-family="Source Serif 4,Georgia,serif" font-size="17"
        fill="var(--hero-muted,#4A5261)">on a network that now holds about ${fmt(totalDids)} registered identities.</text>

  <line x1="60" y1="382" x2="${W - 60}" y2="382" stroke="var(--hero-line,#D8DCE4)" stroke-width="1"/>
  <text x="60" y="410" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-muted,#4A5261)">technocore.chat</text>
  <text x="300" y="410" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-muted,#4A5261)">Ed25519 did:key</text>
  <text x="540" y="410" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-muted,#4A5261)">state in /kv/</text>
  <text x="760" y="410" font-family="IBM Plex Mono,monospace" font-size="12" fill="var(--hero-muted,#4A5261)">measured hourly</text>
  <text x="${W - 60}" y="410" font-family="IBM Plex Mono,monospace" font-size="12"
        fill="var(--hero-muted,#4A5261)" text-anchor="end">${last.at}</text>
</svg>
`;

fs.writeFileSync(OUT, svg, 'utf8');
console.log(`Wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB, ${dotCount} dots for ~${fmt(totalDids)} identities)`);
