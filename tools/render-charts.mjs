/**
 * Renders the measurement time series into standalone SVG charts.
 *
 * Hand-drawn SVG rather than a charting library, for the same reason the agent
 * has no runtime dependencies: the output has to be readable, diffable, and
 * embeddable in a static page with no script and no CDN — the artifact CSP and
 * GitHub Pages both refuse remote assets, and a chart nobody can render is not a
 * chart.
 *
 * Colours come from CSS custom properties so a single stylesheet themes every
 * chart in both light and dark. Never bake a literal colour into the path data.
 *
 * Run: node tools/render-charts.mjs   (writes docs/charts/*.svg)
 */
import fs from 'node:fs';
import path from 'node:path';

const SERIES = path.resolve('docs/measurements/timeseries.json');
const OUT_DIR = path.resolve('docs/charts');

const W = 720;
const H = 300;
const M = { top: 24, right: 24, bottom: 44, left: 68 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hhmm(iso) {
  return iso.slice(11, 16);
}

/** Nice round upper bound, so the axis reads in human numbers. */
function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/**
 * @param {object} spec
 * @param {Array<{at:string, value:number}>} spec.points
 * @param {number|null} spec.cap  draws a cap line when the metric has one
 */
function lineChart({ id, title, subtitle, points, cap = null, unit = '' }) {
  const usable = points.filter((p) => p.value !== null && p.value !== undefined);
  if (usable.length < 2) throw new Error(`${id}: need at least two readings`);

  const t0 = Date.parse(usable[0].at);
  const t1 = Date.parse(usable[usable.length - 1].at);
  const span = Math.max(1, t1 - t0);

  const dataMax = Math.max(...usable.map((p) => p.value), cap ?? 0);
  const yMax = niceMax(dataMax);

  const x = (at) => M.left + ((Date.parse(at) - t0) / span) * PLOT_W;
  const y = (v) => M.top + PLOT_H - (v / yMax) * PLOT_H;

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMax * f));
  const grid = gridValues.map((v) => `
    <line x1="${M.left}" y1="${y(v).toFixed(1)}" x2="${M.left + PLOT_W}" y2="${y(v).toFixed(1)}" class="grid"/>
    <text x="${M.left - 10}" y="${(y(v) + 4).toFixed(1)}" class="tick tick-y">${fmt(v)}</text>`).join('');

  const line = usable.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(usable[usable.length - 1].at).toFixed(1)},${(M.top + PLOT_H).toFixed(1)} L${x(usable[0].at).toFixed(1)},${(M.top + PLOT_H).toFixed(1)} Z`;

  const dots = usable.map((p, i) => {
    const last = i === usable.length - 1;
    return `<circle cx="${x(p.at).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${last ? 5 : 3.5}" class="${last ? 'dot dot-last' : 'dot'}"><title>${esc(hhmm(p.at))} — ${esc(p.value.toLocaleString('en-US'))}${esc(unit)}</title></circle>`;
  }).join('');

  // A reading arrives every hour, so labelling every point stops working almost
  // immediately. Thin to a handful, always keeping the first and the last.
  const maxTicks = 6;
  const step = Math.max(1, Math.ceil(usable.length / maxTicks));
  const tickPoints = usable.filter((_, i) => i % step === 0 || i === usable.length - 1);
  const xTicks = tickPoints.map((p, i) => {
    const anchor = i === 0 ? 'start' : (i === tickPoints.length - 1 ? 'end' : 'middle');
    return `
    <text x="${x(p.at).toFixed(1)}" y="${M.top + PLOT_H + 22}" class="tick" text-anchor="${anchor}">${hhmm(p.at)}</text>`;
  }).join('');

  const capLine = cap === null ? '' : `
    <line x1="${M.left}" y1="${y(cap).toFixed(1)}" x2="${M.left + PLOT_W}" y2="${y(cap).toFixed(1)}" class="cap"/>
    <text x="${M.left + PLOT_W}" y="${(y(cap) - 7).toFixed(1)}" class="cap-label" text-anchor="end">cap ${fmt(cap)}</text>`;

  const lastValue = usable[usable.length - 1].value;
  const endLabel = `<text x="${x(usable[usable.length - 1].at).toFixed(1)}" y="${(y(lastValue) - 14).toFixed(1)}" class="end-label" text-anchor="end">${lastValue.toLocaleString('en-US')}${esc(unit)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <desc>${esc(subtitle)}</desc>
  <style>
    .grid      { stroke: var(--chart-grid, #d8dce4); stroke-width: 1; }
    .cap       { stroke: var(--chart-cap, #9a2b22); stroke-width: 1.5; stroke-dasharray: 5 4; }
    .cap-label { fill: var(--chart-cap, #9a2b22); font: 600 11px Archivo, system-ui, sans-serif; letter-spacing: .04em; }
    .tick      { fill: var(--chart-muted, #737c8c); font: 500 11px "IBM Plex Mono", ui-monospace, monospace; }
    .tick-y    { text-anchor: end; }
    .tick-x    { text-anchor: middle; }
    .series    { fill: none; stroke: var(--chart-line, #a25c00); stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
    .fill      { fill: var(--chart-fill, rgba(162,92,0,.10)); stroke: none; }
    .dot       { fill: var(--chart-line, #a25c00); }
    .dot-last  { stroke: var(--chart-bg, #fff); stroke-width: 2.5; }
    .end-label { fill: var(--chart-line, #a25c00); font: 700 13px Archivo, system-ui, sans-serif; }
    .axis      { stroke: var(--chart-axis, #b9bfca); stroke-width: 1; }
  </style>
  ${grid}
  <path d="${area}" class="fill"/>
  ${capLine}
  <path d="${line}" class="series"/>
  ${dots}
  ${endLabel}
  <line x1="${M.left}" y1="${M.top + PLOT_H}" x2="${M.left + PLOT_W}" y2="${M.top + PLOT_H}" class="axis"/>
  ${xTicks}
</svg>`;
}

function main() {
  const series = JSON.parse(fs.readFileSync(SERIES, 'utf8'));
  const obs = series.observations;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const charts = [
    {
      id: 'did-population',
      title: 'Published DID profiles, sharded namespace',
      subtitle: 'The legacy flat namespace is separately full at 40,960 and cannot take new agents.',
      points: obs.map((o) => ({ at: o.at, value: o.sharded_did_estimate })),
      cap: null
    },
    {
      id: 'lobby-throughput',
      title: '/r/lobby messages per minute',
      subtitle: 'Instantaneous rate over a 20-second window. Down 62% from peak in five hours.',
      points: obs.map((o) => ({ at: o.at, value: o.lobby_msgs_per_min })),
      cap: null,
      unit: '/min'
    },
    {
      id: 'notes-fill',
      title: 'Notes stored against the 327,680 cap',
      subtitle: 'Filling fast during the burst, then almost flat.',
      points: obs.map((o) => ({ at: o.at, value: o.notes_used })),
      cap: series.caps.notes
    },
    {
      id: 'rooms-fill',
      title: 'Rooms against the 10,240 cap',
      subtitle: 'The tightest cap on the service: 78% full and still climbing.',
      points: obs.map((o) => ({ at: o.at, value: o.rooms_used })),
      cap: series.caps.rooms
    }
  ];

  for (const chart of charts) {
    const svg = lineChart(chart);
    const file = path.join(OUT_DIR, `${chart.id}.svg`);
    fs.writeFileSync(file, svg, 'utf8');
    console.log(`${file}  (${svg.length} bytes)`);
  }
  console.log(`\nRendered ${charts.length} charts from ${obs.length} readings.`);
}

main();
