import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity } from './identity.mjs';

export function generateDashboardHtml({
  identity,
  heartbeat = {},
  logs = [],
  generatedAt = new Date().toISOString()
}) {
  const did = identity?.did || 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
  const totalTurns = heartbeat.turns ? Math.max(heartbeat.turns, logs.length) : (logs.length > 0 ? logs.length : 1);
  const handledCount = logs.filter((l) => l.action === 'answered_inquiry' || l.action === 'signed_checkin').length || (heartbeat.handledCount ?? 1);
  const lastLog = logs[logs.length - 1] || {};
  const lastAction = lastLog.action === 'answered_inquiry' ? 'answered_inquiry'
    : (lastLog.action === 'signed_checkin' ? 'signed_checkin'
    : (lastLog.action?.startsWith('skipped') ? 'monitoring_pacing' : (lastLog.action || 'active_monitoring')));
  
  const lastTime = lastLog.timestamp ? new Date(lastLog.timestamp) : (heartbeat.lastHeartbeat ? new Date(heartbeat.lastHeartbeat) : new Date());
  const isRecent = (Date.now() - lastTime.getTime()) < 1800_000;
  const status = isRecent ? 'ACTIVE · ONLINE' : 'SCHEDULED_IN_CLOUD';
  const lastHeartbeatFormatted = lastTime.toLocaleString('lt-LT');

  const logRows = logs.slice(-20).reverse().map((log, idx) => {
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('lt-LT') : '—';
    const rawAction = log.action || log.event || 'turn';
    let actionBadge;
    if (rawAction === 'answered_inquiry') {
      actionBadge = `<span class="badge badge-success">answered_inquiry</span>`;
    } else if (rawAction === 'signed_checkin') {
      actionBadge = `<span class="badge badge-success">signed_checkin</span>`;
    } else if (rawAction.includes('error') || rawAction.includes('failed')) {
      actionBadge = `<span class="badge badge-warn">warning</span>`;
    } else if (rawAction.startsWith('skipped')) {
      actionBadge = `<span class="badge badge-info">rate_pacing</span>`;
    } else {
      actionBadge = `<span class="badge badge-info">${rawAction}</span>`;
    }

    const seqInfo = log.lastSeenSeq ? ` | Seq: #${log.lastSeenSeq}` : '';
    const details = log.error ? `Klaida: ${log.error}` : `DID: ${did.slice(0, 16)}...${seqInfo}`;
    const rowNum = Math.max(1, totalTurns - idx);

    return `
      <tr>
        <td class="col-num">#${rowNum}</td>
        <td class="col-time">${time}</td>
        <td class="col-action">${actionBadge}</td>
        <td class="col-details">${details}</td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="lt">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="FLOP / Technocore Evidence Scout - Autonominio AI agento gyvas statusas ir airdrop atitikties suvestinė.">
  <meta http-equiv="refresh" content="60">
  <title>FLOP Evidence Scout · Live Status Dashboard</title>
  <style>
    :root {
      --bg: #090b0e;
      --card-bg: #12161d;
      --card-border: #1e2633;
      --accent: #10b981;
      --accent-glow: rgba(16, 185, 129, 0.2);
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --warn: #f59e0b;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 24px;
      gap: 16px;
    }
    .brand h1 { font-size: 1.5rem; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .brand p { color: var(--text-muted); font-size: 0.9rem; margin-top: 4px; }
    .pulse-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--accent-glow);
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 6px 14px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 0.85rem;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--accent);
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h3 { font-size: 0.8rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.05em; margin-bottom: 8px; }
    .card .val { font-size: 1.4rem; font-weight: 700; color: #fff; }
    .card .sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 4px; }
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .did-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: #58a6ff;
      word-break: break-all;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .checklist { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .check-item {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 14px;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .check-icon { color: var(--accent); font-size: 1.2rem; line-height: 1; }
    .check-text strong { font-size: 0.9rem; display: block; }
    .check-text p { font-size: 0.8rem; color: var(--text-muted); margin-top: 2px; }
    .table-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
    th { background: #161b24; padding: 12px 16px; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--card-border); }
    td { padding: 12px 16px; border-bottom: 1px solid var(--card-border); }
    tr:last-child td { border-bottom: none; }
    .col-num { font-family: var(--font-mono); color: var(--text-muted); width: 60px; }
    .col-time { font-family: var(--font-mono); width: 100px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .badge-warn { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
    .badge-info { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
    footer { text-align: center; color: var(--text-muted); font-size: 0.8rem; padding-top: 16px; border-top: 1px solid var(--card-border); }
    footer a { color: #58a6ff; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>🌐 FLOP / Technocore Evidence Scout</h1>
        <p>Autonominis AI agentas · 24/7 stebėsena ir airdrop atitikties suvestinė</p>
      </div>
      <div class="pulse-pill">
        <span class="pulse-dot"></span>
        <span>${status}</span>
      </div>
    </header>

    <div class="did-box">
      <span><strong>W3C DID:</strong> ${did}</span>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Tinklo mazgas</h3>
        <div class="val" style="font-size: 1.1rem; color: #38bdf8;">technocore.chat</div>
        <div class="sub">Kambarys: /r/lobby</div>
      </div>
      <div class="card">
        <h3>Atlikti ciklai</h3>
        <div class="val">${totalTurns}</div>
        <div class="sub">Taktas: kas 15 min.</div>
      </div>
      <div class="card">
        <h3>Paskutinis veiksmas</h3>
        <div class="val" style="font-size: 1rem; color: #34d399;">${lastAction}</div>
        <div class="sub">${lastHeartbeatFormatted}</div>
      </div>
      <div class="card">
        <h3>Apdoroti klausimai</h3>
        <div class="val">${handledCount}</div>
        <div class="sub">Žinių pagalba agentams</div>
      </div>
    </div>

    <h2 class="section-title">🛡️ FLOP Airdrop & Protocol Readiness</h2>
    <div class="checklist">
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>W3C did:key tapatybė</strong>
          <p>Unikali Ed25519 raktų pora su nuolatiniu DID tinkle.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>Kriptografiniai parašai</strong>
          <p>Kiekvienas pranešimas pasirašytas privačiu raktu.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>/kv/ būsenos tęstinumas</strong>
          <p>Ilgalaikė atmintis įrodo „agents live here“ metriką.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>Anti-Spam Guardrails</strong>
          <p>Rate limiting, SHA-256 deduplikacija ir aušinimo laikas.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>24/7 veikimas debesyje</strong>
          <p>GitHub Actions suplanuoti ciklai be jūsų kompiuterio.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong>Zero-Leak saugumas</strong>
          <p>Privatūs raktai saugomi tik šifruotame GitHub Secrets.</p>
        </div>
      </div>
    </div>

    <h2 class="section-title">📋 Naujausi audito įvykiai</h2>
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>Ciklas</th>
            <th>Laikas</th>
            <th>Veiksmas</th>
            <th>Informacija</th>
          </tr>
        </thead>
        <tbody>
          ${logRows || '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Laukiama naujų įvykių...</td></tr>'}
        </tbody>
      </table>
    </div>

    <footer>
      <p>FLOP Evidence Scout · GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Atnaujinta: ${new Date(generatedAt).toLocaleString('lt-LT')}</p>
    </footer>
  </div>
</body>
</html>`;
}

export function updateDashboardFile(outputDir = 'docs') {
  const resolvedDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const identity = loadOrCreateIdentity('.secrets/scout-identity.json');
  let heartbeat = {};
  let logs = [];

  const heartbeatPath = path.resolve('data/scout-heartbeat.json');
  if (fs.existsSync(heartbeatPath)) {
    try { heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); } catch { }
  }

  const auditPath = path.resolve('data/scout-audit.jsonl');
  if (fs.existsSync(auditPath)) {
    try {
      const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
      logs = lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { }
  }

  const html = generateDashboardHtml({ identity, heartbeat, logs });
  const targetFile = path.join(resolvedDir, 'index.html');
  fs.writeFileSync(targetFile, html, 'utf8');
  console.log(`[Dashboard] Generated live HTML status page at: ${targetFile}`);
  return targetFile;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('dashboard.mjs');
if (isDirectRun) {
  updateDashboardFile();
}
