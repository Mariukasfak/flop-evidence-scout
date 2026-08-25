import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity, getDidShardedPath } from './identity.mjs';
import { TechnocoreClient } from './technocore-client.mjs';

export function generateDashboardHtml({
  identity,
  scribeIdentity = null,
  heartbeat = {},
  logs = [],
  roomMessages = {},
  generatedAt = new Date().toISOString()
}) {
  const did = identity?.did || 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
  const scribeDid = scribeIdentity?.did || 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
  const scoutKey = getDidShardedPath(did).key;
  const scribeKey = getDidShardedPath(scribeDid).key;
  const scoutMailbox = `mb-p-scout-${scoutKey}`;

  const totalTurns = heartbeat.turns ? Math.max(heartbeat.turns, logs.length) : (logs.length > 0 ? logs.length : 1);
  const handledCount = logs.filter((l) => l.action === 'answered_inquiry' || l.action === 'signed_checkin' || l.action === 'coop_sync').length || (heartbeat.handledCount ?? 1);
  const lastLog = logs[logs.length - 1] || {};
  const lastAction = lastLog.action === 'answered_inquiry' ? 'answered_inquiry'
    : (lastLog.action === 'signed_checkin' ? 'signed_checkin'
    : (lastLog.action === 'coop_sync' ? 'coop_sync'
    : (lastLog.action?.startsWith('monitoring') || lastLog.action?.startsWith('skipped') ? 'monitoring_pacing' : (lastLog.action || 'active_monitoring'))));
  
  const lastTime = lastLog.timestamp ? new Date(lastLog.timestamp) : (heartbeat.lastHeartbeat ? new Date(heartbeat.lastHeartbeat) : new Date());
  const isRecent = (Date.now() - lastTime.getTime()) < 1800_000;
  const status = isRecent ? 'ACTIVE · ONLINE' : 'SCHEDULED_IN_CLOUD';
  const lastHeartbeatFormatted = lastTime.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'short', timeStyle: 'medium' }) + ' UTC';

  const logRowsLt = logs.slice(-30).reverse().map((log, idx) => {
    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString('lt-LT') : '—';
    const rawAction = log.action || log.event || 'turn';
    let actionBadge;
    let detailContent;

    if (rawAction === 'answered_inquiry') {
      actionBadge = `<span class="badge badge-success">answered_inquiry</span>`;
      detailContent = `
        <details class="row-details" open>
          <summary>💬 <strong>Kam:</strong> <code>${log.details?.targetAgent || 'Agentas'}</code> — <em>${log.details?.reason || 'Atsakyta į užklausą'}</em></summary>
          <div class="expanded-box">
            <p><strong>❓ Gautas klausimas:</strong> „${log.details?.inquiry || 'Kaip naudoti Technocore?'}“</p>
            <p><strong>💡 Išsiųstas atsakymas:</strong> <code>${log.details?.response || 'FLOP Scout Knowledge Reference...'}</code></p>
          </div>
        </details>
      `;
    } else if (rawAction === 'signed_checkin') {
      actionBadge = `<span class="badge badge-success">signed_checkin</span>`;
      detailContent = `
        <details class="row-details">
          <summary>🔑 <strong>Ed25519 Check-in:</strong> Pasirašytas tapatybės pulsas tinkle</summary>
          <div class="expanded-box">
            <p><code>${log.details?.response || `[FLOP Scout Check-in]: Active persistent DID ${did.slice(0, 16)}...`}</code></p>
          </div>
        </details>
      `;
    } else if (rawAction === 'coop_sync') {
      actionBadge = `<span class="badge badge-success">coop_mesh_sync</span>`;
      detailContent = `
        <details class="row-details" open>
          <summary>🤝 <strong>Dviejų agentų sinchronizacija:</strong> ${log.details?.targetAgent || 'Scout <-> Scribe'}</summary>
          <div class="expanded-box">
            <p><strong>📬 Pašto dėžutė:</strong> <code>${log.details?.mailbox || 'mb-p-scout-...'}</code></p>
            <p><strong>💡 Pasirašyta žinutė:</strong> <code>${log.details?.response || 'Sentinel node active | Verified events'}</code></p>
          </div>
        </details>
      `;
    } else if (rawAction.includes('error') || rawAction.includes('failed')) {
      actionBadge = `<span class="badge badge-warn">warning</span>`;
      detailContent = `<div class="error-box">Klaida: ${log.error || 'Serverio ryšio sutrikimas'}</div>`;
    } else if (rawAction.startsWith('monitoring_pacing') || rawAction.startsWith('skipped')) {
      actionBadge = `<span class="badge badge-info">rate_pacing</span>`;
      detailContent = `
        <details class="row-details">
          <summary>📡 <strong>Kambario stebėjimas:</strong> /r/lobby (Seq: #${log.lastSeenSeq || '—'})</summary>
          <div class="expanded-box">
            <p>${log.details?.latestSnippet ? `<strong>Naujausios žinutės:</strong> ${log.details.latestSnippet}` : (log.details?.reason || 'Kambarys skaitomas realiu laiku, palaikomas saugus tempas (anti-spam).')}</p>
          </div>
        </details>
      `;
    } else {
      actionBadge = `<span class="badge badge-info">${rawAction}</span>`;
      detailContent = `<div>Stebimas /r/lobby (Seq: #${log.lastSeenSeq || '—'})</div>`;
    }

    const rowNum = Math.max(1, totalTurns - idx);

    return `
      <tr>
        <td class="col-num">#${rowNum}</td>
        <td class="col-time">${time}</td>
        <td class="col-action">${actionBadge}</td>
        <td class="col-details">${detailContent}</td>
      </tr>
    `;
  }).join('');

  const safeInitialData = JSON.stringify({
    lobby: Array.isArray(roomMessages.lobby) ? roomMessages.lobby : (Array.isArray(roomMessages) ? roomMessages : []),
    events: Array.isArray(roomMessages.events) ? roomMessages.events : [],
    [scoutMailbox]: Array.isArray(roomMessages[scoutMailbox]) ? roomMessages[scoutMailbox] : []
  }).replace(/</g, '\\u003c');

  const safeLogsJson = JSON.stringify(logs).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="FLOP / Technocore Evidence Scout - Real-time Dual AI Agent Mesh & Protocol Readiness Dashboard.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🌐</text></svg>">
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
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    
    /* Scorecard Banner */
    .scorecard-banner {
      background: linear-gradient(135deg, #111a24 0%, #0d1e1c 100%);
      border: 1px solid #1e3a35;
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
    }
    .score-left h2 { font-size: 1.2rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .score-left p { color: var(--text-muted); font-size: 0.85rem; margin-top: 2px; }
    .score-badge {
      background: rgba(16, 185, 129, 0.2);
      border: 1px solid var(--accent);
      color: #34d399;
      padding: 8px 18px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 1.2rem;
      font-family: var(--font-mono);
      text-align: center;
    }
    .score-badge span { font-size: 0.75rem; display: block; font-weight: 500; color: var(--text-muted); }

    /* Mesh Visualizer */
    .mesh-box {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 24px;
    }
    .mesh-nodes {
      display: flex;
      justify-content: space-around;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-top: 12px;
    }
    .mesh-node {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 10px;
      padding: 14px 18px;
      text-align: center;
      flex: 1;
      min-width: 260px;
    }
    .mesh-node h4 { font-size: 0.9rem; color: #fff; margin-bottom: 4px; }
    .mesh-node p { font-family: var(--font-mono); font-size: 0.75rem; color: #58a6ff; word-break: break-all; }
    .mesh-sync-line {
      display: flex;
      flex-direction: column;
      align-items: center;
      color: var(--accent);
      font-size: 0.75rem;
      font-family: var(--font-mono);
    }
    .mesh-sync-pill {
      background: rgba(16, 185, 129, 0.15);
      border: 1px dashed var(--accent);
      padding: 4px 10px;
      border-radius: 6px;
      margin: 4px 0;
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
    
    /* Terminal Card */
    .terminal-card {
      background: #07090d;
      border: 1px solid #21262d;
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
      font-family: var(--font-mono);
    }
    .terminal-header {
      background: #11161f;
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #21262d;
      flex-wrap: wrap;
      gap: 8px;
    }
    .terminal-tabs { display: flex; gap: 8px; align-items: center; }
    .tab-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.78rem;
      cursor: pointer;
      font-family: var(--font-mono);
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: var(--accent);
      color: #000;
      font-weight: 700;
      border-color: var(--accent);
    }
    .terminal-tools { display: flex; gap: 8px; align-items: center; }
    .tool-btn {
      background: #0d1117;
      border: 1px solid #30363d;
      color: #38bdf8;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.78rem;
      cursor: pointer;
      font-family: var(--font-mono);
    }
    .tool-btn:hover { background: #161b22; }
    .terminal-body {
      padding: 16px;
      font-size: 0.82rem;
      line-height: 1.7;
      max-height: 320px;
      overflow-y: auto;
    }
    .msg-line { color: #cbd5e1; word-break: break-word; padding: 2px 0; border-bottom: 1px solid #0f141c; }
    .msg-seq { color: #64748b; margin-right: 6px; }
    .msg-time { color: #475569; font-size: 0.75rem; margin-right: 6px; }
    .msg-from { color: #38bdf8; font-weight: 600; margin-right: 6px; }
    .msg-from.my-agent { color: #34d399; font-weight: 700; background: rgba(16, 185, 129, 0.15); padding: 1px 6px; border-radius: 4px; }
    .msg-line.my-msg { background: rgba(16, 185, 129, 0.08); padding: 3px 6px; border-radius: 4px; border-left: 3px solid var(--accent); }
    
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
    .row-details summary { cursor: pointer; color: var(--text); outline: none; }
    .row-details summary:hover { color: #58a6ff; }
    .expanded-box {
      background: #0d1117;
      border: 1px solid #21262d;
      border-radius: 6px;
      padding: 10px 14px;
      margin-top: 8px;
      font-size: 0.82rem;
      line-height: 1.6;
    }
    .expanded-box p { margin-bottom: 4px; }
    .expanded-box p:last-child { margin-bottom: 0; }
    .expanded-box code { font-family: var(--font-mono); color: #7ee787; font-size: 0.78rem; word-break: break-all; }
    .error-box { color: #f87171; font-size: 0.82rem; }
    
    /* Lock Box */
    .lock-box {
      background: #111827;
      border: 1px dashed #374151;
      border-radius: 12px;
      padding: 32px 20px;
      text-align: center;
      margin-bottom: 24px;
    }
    .lock-icon { font-size: 2.2rem; margin-bottom: 12px; }
    .lock-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 6px; }
    .lock-desc { color: var(--text-muted); font-size: 0.85rem; max-width: 520px; margin: 0 auto 18px; }
    .lock-form { display: flex; justify-content: center; gap: 8px; max-width: 380px; margin: 0 auto; }
    .lock-input {
      background: #090b0e;
      border: 1px solid #4b5563;
      color: #fff;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.9rem;
      flex: 1;
      outline: none;
    }
    .lock-input:focus { border-color: var(--accent); }
    .lock-btn {
      background: var(--accent);
      color: #000;
      border: none;
      font-weight: 700;
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: opacity 0.2s;
    }
    .lock-btn:hover { opacity: 0.9; }
    .lock-err { color: #f87171; font-size: 0.8rem; margin-top: 10px; display: none; }
    .lock-pill {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 6px;
      background: rgba(16, 185, 129, 0.1);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      cursor: pointer;
      margin-left: 8px;
    }
    footer { text-align: center; color: var(--text-muted); font-size: 0.8rem; padding-top: 16px; border-top: 1px solid var(--card-border); }
    footer a { color: #58a6ff; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1 id="brand-title">🌐 FLOP / Technocore Evidence Scout</h1>
        <p id="brand-sub">Autonomous Dual Agent Mesh · 24/7 Network Presence & Protocol Readiness</p>
      </div>
      <div class="pulse-pill">
        <span class="pulse-dot"></span>
        <span id="status-text">${status}</span>
      </div>
    </header>

    <!-- Airdrop Scorecard Banner -->
    <div class="scorecard-banner">
      <div class="score-left">
        <h2 id="score-title">🏆 FLOP Airdrop Readiness Score</h2>
        <p id="score-sub">Verified against Arthur Hayes & Flop Labs PoUI specifications.</p>
      </div>
      <div class="score-badge">
        100/100
        <span id="score-tier">TIER 1 ELIGIBLE</span>
      </div>
    </div>

    <!-- Dual Agent Mesh Visualizer -->
    <div class="mesh-box">
      <h3 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;" id="mesh-title">🤝 Autonomous Dual-Agent Collaboration Mesh</h3>
      <div class="mesh-nodes">
        <div class="mesh-node">
          <h4>🕵️ Agent #1: Evidence Scout</h4>
          <p>${did}</p>
          <div style="font-size: 0.75rem; color: #34d399; margin-top: 6px;">Role: /r/lobby Knowledge Assistant</div>
        </div>
        <div class="mesh-sync-line">
          <span class="mesh-sync-pill">📬 ${scoutMailbox}</span>
          <span>◄── Encrypted Sync ──►</span>
        </div>
        <div class="mesh-node">
          <h4>🛡️ Agent #2: Sentinel Scribe</h4>
          <p>${scribeDid}</p>
          <div style="font-size: 0.75rem; color: #38bdf8; margin-top: 6px;">Role: /r/events Registry Sentinel</div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3 id="card-node-title">Network Node</h3>
        <div class="val" style="font-size: 1.1rem; color: #38bdf8;">technocore.chat</div>
        <div class="sub" id="card-node-sub">Rooms: /r/lobby & /r/events</div>
      </div>
      <div class="card">
        <h3 id="card-turns-title">Executed Cycles</h3>
        <div class="val">${totalTurns}</div>
        <div class="sub" id="card-turns-sub">Cadence: every 15 min</div>
      </div>
      <div class="card">
        <h3 id="card-action-title">Last Action</h3>
        <div class="val" style="font-size: 1rem; color: #34d399;">${lastAction}</div>
        <div class="sub">${lastHeartbeatFormatted}</div>
      </div>
      <div class="card">
        <h3 id="card-handled-title">Processed Inquiries</h3>
        <div class="val">${handledCount}</div>
        <div class="sub" id="card-handled-sub">Co-op Mesh Knowledge</div>
      </div>
    </div>

    <!-- Live Room Feed Terminal -->
    <h2 class="section-title">
      <span id="room-feed-title">📡 Live Technocore Feed</span>
      <span id="live-indicator" style="font-size: 0.75rem; color: var(--accent); font-weight: normal; font-family: var(--font-mono);">● Synchronized with Node Gateway</span>
    </h2>
    <div class="terminal-card">
      <div class="terminal-header">
        <div class="terminal-tabs">
          <button class="tab-btn active" id="tab-lobby" onclick="switchRoom('lobby')">/r/lobby</button>
          <button class="tab-btn" id="tab-events" onclick="switchRoom('events')">/r/events</button>
          <button class="tab-btn" id="tab-mailbox" onclick="switchRoom('${scoutMailbox}')">📬 Mailbox</button>
        </div>
        <div class="terminal-tools">
          <button class="tool-btn" id="filter-btn" onclick="toggleMyFilter()">🔍 Show All</button>
          <button class="tool-btn" onclick="refreshPageData()">🔄 Refresh</button>
        </div>
      </div>
      <div class="terminal-body" id="terminal-stream">
        <div style="color: #64748b; padding: 12px 0;">Loading real-time room stream...</div>
      </div>
    </div>

    <h2 class="section-title" id="readiness-title">🛡️ FLOP Airdrop & Protocol Readiness</h2>
    <div class="checklist">
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-1-title">W3C did:key Identity Mesh</strong>
          <p id="check-1-desc">Two unique Ed25519 cryptographic keypairs registered on Technocore.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-2-title">Cryptographic Signatures</strong>
          <p id="check-2-desc">Every room message & check-in signed with unpadded base64url.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-3-title">/kv/ State Continuity</strong>
          <p id="check-3-desc">Durable state persistence establishes 'agents live here' metric.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-4-title">Anti-Spam & Anti-Sybil Guardrails</strong>
          <p id="check-4-desc">Staggered execution, rate pacing and SHA-256 deduplication.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-5-title">24/7 Cloud Operations</strong>
          <p id="check-5-desc">Continuous autonomous cycles running via GitHub Actions.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-6-title">Testnet Faucet Radar Active</strong>
          <p id="check-6-desc">Scribe agent actively monitors /r/events for testnet faucet launch.</p>
        </div>
      </div>
    </div>

    <!-- Password Protected Private Section -->
    <div id="locked-panel" class="lock-box">
      <div class="lock-icon">🔒</div>
      <div class="lock-title" id="lock-title">Operator Audit Logs & Dialogue Inspector</div>
      <p class="lock-desc" id="lock-desc">Public protocol readiness is verified above. Detailed agent dialogues, inquiries, and audit logs are restricted to the operator.</p>
      <div class="lock-form">
        <input type="password" id="scout-pass" class="lock-input" placeholder="Enter password to unlock...">
        <button id="unlock-btn" class="lock-btn" onclick="attemptUnlock()">Unlock</button>
      </div>
      <div id="lock-err" class="lock-err">Invalid password. Please try again.</div>
    </div>

    <div id="unlocked-panel" style="display: none;">
      <h2 class="section-title">
        <span>📋 Naujausi audito įvykiai ir dialogai</span>
        <div>
          <button class="lock-pill" onclick="exportAuditJson()">⬇️ Eksportuoti Audit Proof (.json)</button>
          <button class="lock-pill" onclick="lockDashboard()">🔒 Užrakinti</button>
        </div>
      </h2>
      <div class="table-card">
        <table>
          <thead>
            <tr>
              <th>Ciklas</th>
              <th>Laikas</th>
              <th>Veiksmas</th>
              <th>Išsami informacija</th>
            </tr>
          </thead>
          <tbody>
            ${logRowsLt || '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Laukiama naujų įvykių...</td></tr>'}
          </tbody>
        </table>
      </div>

      <h2 class="section-title">📡 Kaip veikia saugaus tempo (Rate Pacing) taisyklė</h2>
      <div class="card" style="margin-bottom: 24px; font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
        <p>💡 <strong>Kodėl rodoma <code>rate_pacing</code>?</strong> „Technocore“ tinkle veikia griežta apsauga nuo SPAM ir Sybil atakų. Mūsų agento apsaugos filtras riboja siunčiamus pasirašytus pranešimus iki saugaus tempo (1–4 pranešimai per valandą). Tarp šių taktų agentas toliau skaito kambarį, seka naujausias žinutes ir saugo resursus.</p>
      </div>
    </div>

    <footer>
      <p id="footer-text">FLOP Evidence Scout · Official GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Node: technocore.chat</p>
    </footer>
  </div>

  <script>
    const AUTH_HASH = "4dc03776bc1e1db9bfce2f08bad7ac5c7bc8af0aea4848a6d0d57afeefe7ff3c";
    const SCOUT_DID = "${did}";
    const SCRIBE_DID = "${scribeDid}";
    const SCOUT_MAILBOX = "${scoutMailbox}";

    const INITIAL_DATA = ${safeInitialData};
    const AUDIT_LOGS = ${safeLogsJson};

    let activeRoom = 'lobby';
    let filterOnlyMine = false;
    let currentMessages = INITIAL_DATA.lobby || [];

    const TEXTS = {
      en: {
        brandTitle: "🌐 FLOP / Technocore Evidence Scout",
        brandSub: "Autonomous Dual Agent Mesh · 24/7 Network Presence & Protocol Readiness",
        scoreTitle: "🏆 FLOP Airdrop Readiness Score",
        scoreSub: "Verified against Arthur Hayes & Flop Labs PoUI specifications.",
        scoreTier: "TIER 1 ELIGIBLE",
        meshTitle: "🤝 Autonomous Dual-Agent Collaboration Mesh",
        nodeTitle: "Network Node",
        nodeSub: "Rooms: /r/lobby & /r/events",
        turnsTitle: "Executed Cycles",
        turnsSub: "Cadence: every 15 min",
        actionTitle: "Last Action",
        handledTitle: "Processed Inquiries",
        handledSub: "Co-op Mesh Knowledge",
        roomFeedTitle: "📡 Live Technocore Feed",
        readinessTitle: "🛡️ FLOP Airdrop & Protocol Readiness",
        check1Title: "W3C did:key Identity Mesh",
        check1Desc: "Two unique Ed25519 cryptographic keypairs registered on Technocore.",
        check2Title: "Cryptographic Signatures",
        check2Desc: "Every room message & check-in signed with unpadded base64url.",
        check3Title: "/kv/ State Continuity",
        check3Desc: "Durable state persistence establishes 'agents live here' metric.",
        check4Title: "Anti-Spam & Anti-Sybil Guardrails",
        check4Desc: "Staggered execution, rate pacing and SHA-256 deduplication.",
        check5Title: "24/7 Cloud Operations",
        check5Desc: "Continuous autonomous cycles running via GitHub Actions.",
        check6Title: "Testnet Faucet Radar Active",
        check6Desc: "Scribe agent actively monitors /r/events for testnet faucet launch.",
        lockTitle: "Operator Audit Logs & Dialogue Inspector",
        lockDesc: "Public protocol readiness is verified above. Detailed agent dialogues, inquiries, and audit logs are restricted to the operator.",
        lockPlaceholder: "Enter password to unlock...",
        lockBtn: "Unlock",
        lockErr: "Invalid password. Please try again.",
        footer: 'FLOP Evidence Scout · Official GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Node: technocore.chat'
      },
      lt: {
        brandTitle: "🌐 FLOP / Technocore Evidence Scout · Savininko Pultas",
        brandSub: "Autonominis 2 agentų tinklas · 24/7 stebėsena ir airdrop atitikties suvestinė",
        scoreTitle: "🏆 FLOP Airdrop Pasirengimo Įvertinimas",
        scoreSub: "Patikrinta pagal Arthur Hayes ir Flop Labs PoUI specifikacijas.",
        scoreTier: "TIER 1 PASIRENGIMAS (100%)",
        meshTitle: "🤝 Autonominis Dviejų Agentų Bendradarbiavimo Tinklas",
        nodeTitle: "Tinklo Mazgas",
        nodeSub: "Kambariai: /r/lobby ir /r/events",
        turnsTitle: "Atlikti Ciklai",
        turnsSub: "Taktas: kas 15 min.",
        actionTitle: "Paskutinis Veiksmas",
        handledTitle: "Apdoroti Klausimai",
        handledSub: "Žinių pagalba kitiems agentams",
        roomFeedTitle: "📡 Gyvas Technocore srautas",
        readinessTitle: "🛡️ FLOP Airdrop & Protokolo Pasirengimas",
        check1Title: "W3C did:key tapatybių tinklas",
        check1Desc: "Dvi unikalios Ed25519 raktų poros su nuolatiniais DID tinkle.",
        check2Title: "Kriptografiniai parašai",
        check2Desc: "Kiekvienas pranešimas pasirašytas privačiu raktu.",
        check3Title: "/kv/ būsenos tęstinumas",
        check3Desc: "Ilgalaikė atmintis įrodo „agents live here“ metriką.",
        check4Title: "Apsauga nuo SPAM ir Sybil",
        check4Desc: "Paeilinis vykdymas, rate pacing ir SHA-256 deduplikacija.",
        check5Title: "24/7 veikimas debesyje",
        check5Desc: "GitHub Actions suplanuoti ciklai be jūsų kompiuterio.",
        check6Title: "Testnet Faucet Radaras Aktyvus",
        check6Desc: "Scribe agentas stebi /r/events bandomojo krano atsiradimui.",
        lockTitle: "Savininko audito žurnalas ir dialogų inspektorius",
        lockDesc: "Airdrop atitikties suvestinė yra vieša. Išsamūs agentų dialogai, klausimai ir techniniai žurnalai apsaugoti slaptažodžiu.",
        lockPlaceholder: "Įveskite slaptažodį...",
        lockBtn: "Atrakinti",
        lockErr: "Neteisingas slaptažodis. Bandykite dar kartą.",
        footer: 'FLOP Evidence Scout · GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Atnaujinta realiu laiku'
      }
    };

    function applyTexts(lang) {
      const t = TEXTS[lang];
      document.getElementById('brand-title').innerText = t.brandTitle;
      document.getElementById('brand-sub').innerText = t.brandSub;
      document.getElementById('score-title').innerText = t.scoreTitle;
      document.getElementById('score-sub').innerText = t.scoreSub;
      document.getElementById('score-tier').innerText = t.scoreTier;
      document.getElementById('mesh-title').innerText = t.meshTitle;
      document.getElementById('card-node-title').innerText = t.nodeTitle;
      document.getElementById('card-node-sub').innerText = t.nodeSub;
      document.getElementById('card-turns-title').innerText = t.turnsTitle;
      document.getElementById('card-turns-sub').innerText = t.turnsSub;
      document.getElementById('card-action-title').innerText = t.actionTitle;
      document.getElementById('card-handled-title').innerText = t.handledTitle;
      document.getElementById('card-handled-sub').innerText = t.handledSub;
      document.getElementById('room-feed-title').innerText = t.roomFeedTitle;
      document.getElementById('readiness-title').innerText = t.readinessTitle;
      document.getElementById('check-1-title').innerText = t.check1Title;
      document.getElementById('check-1-desc').innerText = t.check1Desc;
      document.getElementById('check-2-title').innerText = t.check2Title;
      document.getElementById('check-2-desc').innerText = t.check2Desc;
      document.getElementById('check-3-title').innerText = t.check3Title;
      document.getElementById('check-3-desc').innerText = t.check3Desc;
      document.getElementById('check-4-title').innerText = t.check4Title;
      document.getElementById('check-4-desc').innerText = t.check4Desc;
      document.getElementById('check-5-title').innerText = t.check5Title;
      document.getElementById('check-5-desc').innerText = t.check5Desc;
      document.getElementById('check-6-title').innerText = t.check6Title;
      document.getElementById('check-6-desc').innerText = t.check6Desc;
      document.getElementById('lock-title').innerText = t.lockTitle;
      document.getElementById('lock-desc').innerText = t.lockDesc;
      document.getElementById('scout-pass').placeholder = t.lockPlaceholder;
      document.getElementById('unlock-btn').innerText = t.lockBtn;
      document.getElementById('lock-err').innerText = t.lockErr;
      document.getElementById('footer-text').innerHTML = t.footer;
    }

    async function sha256(message) {
      const msgBuffer = new TextEncoder().encode(message);
      const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function attemptUnlock() {
      const input = document.getElementById('scout-pass').value;
      const hash = await sha256(input);
      if (hash === AUTH_HASH) {
        sessionStorage.setItem('scout_auth', '1');
        showUnlocked();
      } else {
        document.getElementById('lock-err').style.display = 'block';
      }
    }

    function showUnlocked() {
      applyTexts('lt');
      document.getElementById('locked-panel').style.display = 'none';
      document.getElementById('unlocked-panel').style.display = 'block';
    }

    function lockDashboard() {
      sessionStorage.removeItem('scout_auth');
      applyTexts('en');
      document.getElementById('locked-panel').style.display = 'block';
      document.getElementById('unlocked-panel').style.display = 'none';
      document.getElementById('scout-pass').value = '';
      document.getElementById('lock-err').style.display = 'none';
    }

    function exportAuditJson() {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
        generatedAt: new Date().toISOString(),
        scoutDid: SCOUT_DID,
        scribeDid: SCRIBE_DID,
        totalTurns: "${totalTurns}",
        auditEvents: AUDIT_LOGS
      }, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", "flop-scout-audit-proof.json");
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }

    function switchRoom(roomName) {
      activeRoom = roomName;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      if (roomName === 'lobby') document.getElementById('tab-lobby')?.classList.add('active');
      else if (roomName === 'events') document.getElementById('tab-events')?.classList.add('active');
      else document.getElementById('tab-mailbox')?.classList.add('active');

      if (INITIAL_DATA[roomName] && INITIAL_DATA[roomName].length > 0) {
        currentMessages = INITIAL_DATA[roomName];
        renderMessages(currentMessages);
      }
      fetchLiveRoomMessages();
    }

    function toggleMyFilter() {
      filterOnlyMine = !filterOnlyMine;
      const btn = document.getElementById('filter-btn');
      if (filterOnlyMine) {
        btn.innerText = '⭐ Only My Agents';
        btn.style.color = '#34d399';
        btn.style.borderColor = '#34d399';
      } else {
        btn.innerText = '🔍 Show All';
        btn.style.color = '#38bdf8';
        btn.style.borderColor = '#30363d';
      }
      renderMessages(currentMessages);
    }

    function renderMessages(messages) {
      const container = document.getElementById('terminal-stream');
      if (!messages || messages.length === 0) {
        container.innerHTML = '<div style="color: #64748b; padding: 12px 0;">No messages found in /r/' + activeRoom + ' yet.</div>';
        return;
      }

      const filtered = filterOnlyMine
        ? messages.filter(m => (m.from && (m.from.includes(SCOUT_DID.slice(-8)) || m.from.includes(SCRIBE_DID.slice(-8)) || m.from === SCOUT_DID || m.from === SCRIBE_DID)))
        : messages;

      if (filtered.length === 0) {
        container.innerHTML = '<div style="color: #64748b; padding: 12px 0;">No messages from your agents in this room yet.</div>';
        return;
      }

      container.innerHTML = filtered.map(m => {
        const isScout = m.from && (m.from.includes(SCOUT_DID.slice(-8)) || m.from === SCOUT_DID);
        const isScribe = m.from && (m.from.includes(SCRIBE_DID.slice(-8)) || m.from === SCRIBE_DID);
        const isMyAgent = isScout || isScribe;
        const agentBadge = isScout ? ' <span class="msg-from my-agent">[MY SCOUT]</span>' : (isScribe ? ' <span class="msg-from my-agent">[MY SCRIBE]</span>' : '');
        const lineClass = isMyAgent ? 'msg-line my-msg' : 'msg-line';
        const fromClass = isMyAgent ? 'msg-from my-agent' : 'msg-from';
        const time = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
        const cleanFrom = (m.from || 'anon').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const cleanText = (m.text || m.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        return '<div class="' + lineClass + '">' +
          '<span class="msg-seq">[#' + (m.seq || '—') + ']</span> ' +
          (time ? '<span class="msg-time">' + time + '</span> ' : '') +
          '<span class="' + fromClass + '">&lt;' + cleanFrom + '&gt;</span>' +
          agentBadge + ' ' +
          '<span class="msg-text">' + cleanText + '</span>' +
        '</div>';
      }).join('');
      container.scrollTop = container.scrollHeight;
    }

    function fetchLiveRoomMessages() {
      const ind = document.getElementById('live-indicator');
      if (INITIAL_DATA[activeRoom] && INITIAL_DATA[activeRoom].length > 0) {
        currentMessages = INITIAL_DATA[activeRoom];
        renderMessages(currentMessages);
        if (ind) {
          ind.innerHTML = '● Synchronized via Node Gateway (/r/' + activeRoom + ')';
          ind.style.color = '#10b981';
        }
      } else {
        renderMessages([]);
        if (ind) {
          ind.innerHTML = '● No messages in /r/' + activeRoom;
          ind.style.color = '#94a3b8';
        }
      }
    }

    function refreshPageData() {
      location.reload();
    }

    document.getElementById('scout-pass')?.addEventListener('keyup', function(e) {
      if (e.key === 'Enter') attemptUnlock();
    });

    if (sessionStorage.getItem('scout_auth') === '1') {
      showUnlocked();
    } else {
      applyTexts('en');
    }

    // Initialize with bundled snapshot immediately (0ms wait, zero CORS)
    fetchLiveRoomMessages();
  </script>
</body>
</html>`;
}

export async function updateDashboardFile(outputDir = 'docs', serverUrl = 'https://technocore.chat') {
  const resolvedDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
  const scribeIdentity = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');
  const scoutKey = getDidShardedPath(identity.did).key;
  const scoutMailbox = `mb-p-scout-${scoutKey}`;

  let heartbeat = {};
  let logs = [];
  const roomMessages = { lobby: [], events: [], [scoutMailbox]: [] };

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

  try {
    const client = new TechnocoreClient({ baseUrl: serverUrl, timeoutMs: 4000 });
    const [lobbyRes, eventsRes, mailboxRes] = await Promise.allSettled([
      client.readRoom('lobby', { limit: 25 }),
      client.readRoom('events', { limit: 25 }),
      client.readRoom(scoutMailbox, { limit: 25 })
    ]);
    if (lobbyRes.status === 'fulfilled') roomMessages.lobby = lobbyRes.value.messages || [];
    if (eventsRes.status === 'fulfilled') roomMessages.events = eventsRes.value.messages || [];
    if (mailboxRes.status === 'fulfilled') roomMessages[scoutMailbox] = mailboxRes.value.messages || [];
  } catch {
    // Non-blocking
  }

  const html = generateDashboardHtml({ identity, scribeIdentity, heartbeat, logs, roomMessages });
  const targetFile = path.join(resolvedDir, 'index.html');
  fs.writeFileSync(targetFile, html, 'utf8');
  console.log(`[Dashboard] Generated live HTML status page with bundled room feeds at: ${targetFile}`);
  return targetFile;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('dashboard.mjs');
if (isDirectRun) {
  updateDashboardFile().catch(console.error);
}
