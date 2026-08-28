import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateIdentity, getDidShardedPath, getStateKey } from './identity.mjs';
import { TechnocoreClient } from './technocore-client.mjs';
import { getLatestLearningReport } from './learning-engine.mjs';

/**
 * Everything this page renders about the network was typed by a stranger, so
 * every interpolation of it goes through here. `&` first, or the other
 * replacements re-encode their own output.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function generateDashboardHtml({
  identity,
  scribeIdentity = null,
  heartbeat = {},
  logs = [],
  roomMessages = {},
  learningReport = null,
  generatedAt = new Date().toISOString()
}) {
  const did = identity?.did || 'did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn';
  const scribeDid = scribeIdentity?.did || 'did:key:z6Mkfdd1cRSrTaA1yuUC45a2dXpHe4zPf4cE1DC3DmCpELvW';
  const scoutKey = getDidShardedPath(did).key;
  const scribeKey = getDidShardedPath(scribeDid).key;
  const scoutMailbox = `mb-p-scout-${scoutKey}`;
  const scoutProfilePath = getDidShardedPath(did).fullPath;
  const scribeProfilePath = getDidShardedPath(scribeDid).fullPath;
  const scoutStateKey = getStateKey(did, 'scout');

  // Only messages the agent actually signed and the server accepted.
  const signedMessages = logs.filter((l) =>
    ['answered_inquiry', 'signed_checkin', 'coop_sync', 'coop_ack'].includes(l.action)
  ).length;

  const faucetHits = logs.flatMap((l) => l.details?.faucetAlerts || l.faucetAlerts || []);
  const faucetBanner = faucetHits.length > 0
    ? `<div class="scorecard-banner" style="border-color:#f59e0b;">
      <div class="score-left">
        <h2>🚨 TESTNET FAUCET RADAR — HIT</h2>
        <p>Rooms matching faucet/testnet appeared on /r/events: <code>${faucetHits.map((h) => h.room).join(', ')}</code>. Verify against official Flop Labs channels before interacting — an unofficial "faucet" room is a phishing vector.</p>
      </div>
    </div>`
    : `<div class="mesh-box"><h3 style="font-size:0.85rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">🛰️ Testnet faucet radar</h3><p style="font-size:0.82rem;margin-top:8px;">Scanning <code>/r/events</code> for room names matching faucet · testnet · drip · tap. Status: <strong>clear</strong> — no faucet room announced yet.</p></div>`;

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

  const logRows = logs.slice(-30).reverse().map((log, idx) => {
    const time = log.timestamp ? new Date(log.timestamp).toISOString().slice(11, 19) : '—';
    const rawAction = log.action || log.event || 'turn';
    let actionBadge;
    let detailContent;

    // Inquiry and response text is written by strangers on a world-writable
    // network. Interpolating it raw put an XSS hole in the operator's own
    // dashboard, and quietly ate every <room> placeholder in our own answers.
    const e = escapeHtml;
    const seq = escapeHtml(log.lastSeenSeq ?? log.lastEventsSeq ?? '—');
    const room = escapeHtml(log.room || log.details?.room || 'lobby');

    if (rawAction === 'answered_inquiry') {
      actionBadge = `<span class="badge badge-success">answered_inquiry</span>`;
      detailContent = `
        <details class="row-details" open>
          <summary>💬 <strong>To:</strong> <code>${e(log.details?.targetAgent || 'agent')}</code> — <em>${e(log.details?.reason || 'answered an inquiry')}</em></summary>
          <div class="expanded-box">
            <p><strong>📍 Room:</strong> <code>/r/${room}</code></p>
            <p><strong>❓ Their question:</strong> “${e(log.details?.inquiry || '—')}”</p>
            <p><strong>💡 Our reply:</strong> <code>${e(log.details?.response || '—')}</code></p>
          </div>
        </details>
      `;
    } else if (rawAction === 'signed_checkin') {
      actionBadge = `<span class="badge badge-success">signed_checkin</span>`;
      detailContent = `
        <details class="row-details">
          <summary>🔑 <strong>Ed25519 Check-in:</strong> signed message to <code>/r/${room}</code></summary>
          <div class="expanded-box">
            <p><code>${e(log.details?.response || '—')}</code></p>
          </div>
        </details>
      `;
    } else if (rawAction === 'coop_sync' || rawAction === 'coop_ack') {
      actionBadge = `<span class="badge badge-success">${e(rawAction)}</span>`;
      detailContent = `
        <details class="row-details">
          <summary>🤝 <strong>Internal peer sync:</strong> ${e(log.details?.targetAgent || 'Scout ↔ Scribe')}</summary>
          <div class="expanded-box">
            <p><strong>📬 Mailbox:</strong> <code>${e(log.details?.mailbox || '—')}</code></p>
            <p><strong>💡 Signed message:</strong> <code>${e(log.details?.response || '—')}</code></p>
            <p style="opacity:.7">These are one operator's two agents, not independent parties. Every 6 hours.</p>
          </div>
        </details>
      `;
    } else if (rawAction === 'startup') {
      actionBadge = `<span class="badge badge-info">cycle started</span>`;
      detailContent = `<div>Connected to <code>${e(log.server || 'technocore.chat')}</code></div>`;
    } else if (rawAction === 'shutdown' || rawAction === 'cycle_complete') {
      // Every scheduled tick is one process that starts and exits. This line is
      // the tick finishing normally — not the agent falling over.
      actionBadge = `<span class="badge badge-info">cycle complete</span>`;
      detailContent = `<div>Scheduled cycle finished normally. Next one in 15 minutes.</div>`;
    } else if (rawAction.includes('error') || rawAction.includes('failed')) {
      actionBadge = `<span class="badge badge-warn">warning</span>`;
      detailContent = `<div class="error-box">Error: ${e(log.error || 'connection problem')}</div>`;
    } else if (rawAction.startsWith('monitoring_pacing') || rawAction.startsWith('skipped')) {
      actionBadge = `<span class="badge badge-info">rate_pacing</span>`;
      detailContent = `
        <details class="row-details">
          <summary>📡 <strong>Watching</strong> (seq #${seq})</summary>
          <div class="expanded-box">
            <p>${e(log.details?.reason || 'Rooms read; holding the safe posting pace.')}</p>
          </div>
        </details>
      `;
    } else {
      actionBadge = `<span class="badge badge-info">${e(rawAction)}</span>`;
      detailContent = `
        <details class="row-details">
          <summary>📡 <strong>Watching</strong> (seq #${seq})</summary>
          <div class="expanded-box"><p>${e(log.details?.reason || 'No new messages worth answering.')}</p></div>
        </details>
      `;
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
    mailbox: Array.isArray(roomMessages[scoutMailbox]) ? roomMessages[scoutMailbox] : (Array.isArray(roomMessages.mailbox) ? roomMessages.mailbox : []),
    [scoutMailbox]: Array.isArray(roomMessages[scoutMailbox]) ? roomMessages[scoutMailbox] : (Array.isArray(roomMessages.mailbox) ? roomMessages.mailbox : [])
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
        <p id="brand-sub">Two declared agents, one operator. Every claim here is checkable against technocore.chat.</p>
      </div>
      <div class="pulse-pill">
        <span class="pulse-dot"></span>
        <span id="status-text">${status}</span>
      </div>
    </header>

    <!-- Independently verifiable evidence (no self-assigned scores) -->
    <div class="scorecard-banner">
      <div class="score-left">
        <h2 id="score-title">🔍 Independently Verifiable Evidence</h2>
        <p id="score-sub">Flop Labs has published no scoring formula or tiers. Every claim below can be checked with one plain GET against technocore.chat.</p>
      </div>
      <div class="score-badge">
        ${signedMessages}
        <span id="score-tier">SIGNED MESSAGES</span>
      </div>
    </div>

    <div class="mesh-box">
      <h3 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;" id="evidence-title">🔗 Check it yourself</h3>
      <ul style="margin: 10px 0 0 0; padding-left: 18px; font-size: 0.82rem; line-height: 1.9;">
        <li>Scout DID note: <a href="https://technocore.chat${scoutProfilePath}" target="_blank" rel="noopener">technocore.chat${scoutProfilePath}</a></li>
        <li>Scribe DID note: <a href="https://technocore.chat${scribeProfilePath}" target="_blank" rel="noopener">technocore.chat${scribeProfilePath}</a></li>
        <li>Persistent state note: <a href="https://technocore.chat/kv/scout/${scoutStateKey}" target="_blank" rel="noopener">/kv/scout/${scoutStateKey}</a></li>
        <li>Source code: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank" rel="noopener">github.com/Mariukasfak/flop-evidence-scout</a></li>
      </ul>
    </div>

    ${faucetBanner}

    <!-- Dual Agent Mesh Visualizer -->
    <div class="mesh-box">
      <h3 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;" id="mesh-title">🤝 The two agents, and the link between them</h3>
      <div class="mesh-nodes">
        <div class="mesh-node">
          <h4>🕵️ Agent #1: Evidence Scout</h4>
          <p>${did}</p>
          <div style="font-size: 0.75rem; color: #34d399; margin-top: 6px;">Answers questions in the topical rooms</div>
        </div>
        <div class="mesh-sync-line">
          <span class="mesh-sync-pill">📬 ${scoutMailbox}</span>
          <span>◄── signed, not encrypted ──►</span>
        </div>
        <div class="mesh-node">
          <h4>🛡️ Agent #2: Sentinel Scribe</h4>
          <p>${scribeDid}</p>
          <div style="font-size: 0.75rem; color: #38bdf8; margin-top: 6px;">Watches /r/events and runs the faucet radar</div>
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

    <!--
      There is no password gate here any more, and there never really was one.
      Everything below was already present in this file: the "lock" only set
      display:none, so view-source, devtools, or one line in the console showed
      it all. A control that looks like protection but is not is worse than
      none, because it invites putting something behind it.

      Nothing here needs protecting. Every message the agents send is already
      world-readable on technocore.chat, and the whole point of this project is
      that it can be verified independently.
    -->
    <div class="lock-box">
      <div class="lock-icon">🌐</div>
      <div class="lock-title">Everything on this page is public</div>
      <p class="lock-desc">
        These agents work on a world-readable network. Every message below is already
        visible to anyone at <code>technocore.chat</code>, so there is nothing here to gate —
        and a page that pretends otherwise would only be lying to its own operator.
        Private keys live in <code>.secrets/</code> and GitHub Secrets, are never rendered,
        and CI fails the build if key material is ever committed.
      </p>
    </div>

    <div id="unlocked-panel">
      <h2 class="section-title">
        <span>📋 Naujausi audito įvykiai ir dialogai</span>
        <div>
          <button class="lock-pill" onclick="exportAuditJson()">⬇️ JSON Proof</button>
          <button class="lock-pill" onclick="exportAuditMarkdown()">📜 Sertifikatas (.md)</button>
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
            ${logRows || '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Waiting for the first cycle…</td></tr>'}
          </tbody>
        </table>
      </div>

      <!-- What the archives say about the reply filter -->
      <h2 class="section-title">🧠 Is the reply filter calibrated?</h2>
      <div class="card" style="margin-bottom: 24px; font-size: 0.85rem; line-height: 1.6;">
        <div style="display:flex; justify-content:space-between; flex-wrap:wrap; margin-bottom:12px; border-bottom:1px solid var(--card-border); padding-bottom:10px; gap:10px;">
          <div>📦 <strong>Messages studied:</strong> <span style="color:#38bdf8;font-weight:bold;">${learningReport?.corpus?.messages ?? 0}</span></div>
          <div>👥 <strong>Distinct writers:</strong> <span style="color:#34d399;font-weight:bold;">${learningReport?.corpus?.distinctWriters ?? 0}</span></div>
          <div>💬 <strong>Worth answering:</strong> <span style="color:#fbbf24;font-weight:bold;">${((learningReport?.answerRate ?? 0) * 100).toFixed(1)}%</span></div>
        </div>

        <div style="color: var(--text-muted); margin-bottom:6px;"><strong>Why the agent stayed silent</strong> — every refusal, by reason:</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;">
          ${Object.entries(learningReport?.refusalsByReason || {}).map(([reason, count]) =>
            `<span class="badge badge-info">${escapeHtml(reason)} · ${escapeHtml(count)}</span>`).join('')
            || '<span style="color:var(--text-muted);">No archives analysed yet.</span>'}
        </div>

        <div style="color: var(--text-muted); margin-bottom:6px;"><strong>Rooms ranked by signal</strong> — on-topic share against boilerplate share:</div>
        <div style="display:grid; gap:4px; margin-bottom:14px;">
          ${Object.entries(learningReport?.roomsBySignal || {}).slice(0, 8).map(([room, r]) => `
            <div style="display:flex; gap:10px; align-items:center;">
              <code style="min-width:150px;">/r/${escapeHtml(room)}</code>
              <div style="flex:1; height:6px; background:#0d1117; border-radius:3px; overflow:hidden;">
                <div style="width:${Math.round(Math.min(1, (r.signalScore || 0) / 0.5) * 100)}%; height:100%; background:#38bdf8;"></div>
              </div>
              <span style="min-width:52px; text-align:right; color:var(--text-muted);">${escapeHtml(r.signalScore)}</span>
              <span style="min-width:96px; text-align:right; color:var(--text-muted);">${Math.round((r.boilerplateShare || 0) * 100)}% boilerplate</span>
            </div>`).join('')
            || '<div style="color:var(--text-muted);">No rooms analysed yet.</div>'}
        </div>

        <div style="display:grid; gap:8px;">
          ${(learningReport?.recommendations || []).map(r => `
            <div style="background:#0d1117; border:1px solid #21262d; border-radius:6px; padding:10px 14px;">
              <span class="badge ${r.priority === 'HIGH' ? 'badge-warn' : 'badge-info'}" style="margin-right:6px;">${escapeHtml(r.priority)} · ${escapeHtml(r.area)}</span>
              <strong>${escapeHtml(r.insight)}</strong>
              <div style="color:#38bdf8; font-size:0.8rem; margin-top:4px;">➡️ ${escapeHtml(r.action)}</div>
            </div>`).join('')
            || '<div style="color:var(--text-muted);">Waiting for the next batch of archives.</div>'}
        </div>
      </div>

      <h2 class="section-title">📡 Why most cycles post nothing</h2>
      <div class="card" style="margin-bottom: 24px; font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
        <p>The server permits 300 writes a minute per IP, so the pacing here is a judgement about
        spam rather than a technical limit — a handful of signed messages an hour, and silence the
        rest of the time. On a network where the great majority of traffic is presence boilerplate,
        having nothing to say is the ordinary case, not a fault.</p>
      </div>
    </div>

    <footer>
      <p id="footer-text">FLOP Evidence Scout · Official GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Node: technocore.chat</p>
    </footer>
  </div>

  <script>
    const SCOUT_DID = "${did}";
    const SCRIBE_DID = "${scribeDid}";
    const SCOUT_MAILBOX = "${scoutMailbox}";

    const INITIAL_DATA = ${safeInitialData};
    const AUDIT_LOGS = ${safeLogsJson};

    let activeRoom = 'lobby';
    let filterOnlyMine = false;
    let currentMessages = INITIAL_DATA.lobby || [];






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

    function exportAuditMarkdown() {
      const date = new Date().toISOString();
      const lines = [
        '# 🛡️ FLOP Network · Cryptographic Audit Certificate',
        '> Official verification report for FLOP Airdrop & Proof-of-Useful-Inference (PoUI)',
        '',
        '---',
        '',
        '### Identity & Root Credentials',
        '- **Scout DID:** ' + SCOUT_DID,
        '- **Scribe DID:** ' + SCRIBE_DID,
        '- **Mailbox Mesh:** ' + SCOUT_MAILBOX,
        '- **Total Turns Executed:** ' + '${totalTurns}',
        '- **Handled Inquiries & Mesh Syncs:** ' + '${handledCount}',
        '- **Generated At:** ' + date,
        '',
        '---',
        '',
        '### Verification Proof',
        '- **Identity Standard:** W3C Ed25519 multicodec (0xed01) + base58btc',
        '- **Signature Canonical:** [room | nonce | text] (86-char unpadded base64url)',
        '- **State Storage:** Sharded /kv/did-<shard>/<key>',
        '- **Audit Events Logged:** ' + AUDIT_LOGS.length + ' entries',
        '',
        'Certified by FLOP Evidence Scout Engine.'
      ];
      const dataStr = "data:text/markdown;charset=utf-8," + encodeURIComponent(lines.join('\\n'));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", "flop-scout-audit-certificate.md");
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

      const dataKey = (roomName === 'mailbox' || roomName === SCOUT_MAILBOX) ? 'mailbox' : roomName;
      currentMessages = INITIAL_DATA[dataKey] || INITIAL_DATA[roomName] || [];
      renderMessages(currentMessages);
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

      const isEvents = activeRoom === 'events';
      const filtered = (filterOnlyMine && !isEvents)
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
        const esc = (s) => String(s == null ? '' : s)
          .split('&').join('&amp;')
          .split('<').join('&lt;')
          .split('>').join('&gt;')
          .split('"').join('&quot;');
        const cleanFrom = esc(m.from || 'anon');
        const cleanText = esc(m.text || m.content || '');

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


    // Initialize with bundled snapshot immediately (0ms wait, zero CORS)
    fetchLiveRoomMessages();
  </script>
</body>
</html>`;
}

/**
 * @param dataDir Where the daemon actually writes its state.
 *
 * This read `data/scout-heartbeat.json` and `data/scout-audit.jsonl` as string
 * literals while the local daemon runs with `--data-dir=data/local`, so the
 * dashboard has been rendering whatever a cloud run last committed rather than
 * what the agent on this machine is doing right now. That is the fourth
 * appearance of the hardcoded-path bug this file's own history warns about —
 * the faucet alert, the heartbeat, the telemetry feed, and now the page that
 * displays all three.
 */
export async function updateDashboardFile(outputDir = 'docs', serverUrl = 'https://technocore.chat', dataDir = path.resolve('data')) {
  const resolvedDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  const identity = loadOrCreateIdentity('.secrets/scout-identity.json', 'SCOUT_IDENTITY_JSON');
  const scribeIdentity = loadOrCreateIdentity('.secrets/scribe-identity.json', 'SCRIBE_IDENTITY_JSON');
  const scoutKey = getDidShardedPath(identity.did).key;
  const scoutMailbox = `mb-p-scout-${scoutKey}`;

  let heartbeat = {};
  let logs = [];
  const roomMessages = { lobby: [], events: [], [scoutMailbox]: [] };

  const heartbeatPath = path.join(dataDir, 'scout-heartbeat.json');
  if (fs.existsSync(heartbeatPath)) {
    try { heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); } catch { }
  }

  const auditPath = path.join(dataDir, 'scout-audit.jsonl');
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

  // data/ is gitignored, so a cloud run starts with an empty audit file. Keep a
  // committed rolling history in docs/ so the dashboard shows real continuity
  // instead of only the single tick that just executed.
  const historyPath = path.join(resolvedDir, 'audit-history.json');
  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (Array.isArray(parsed)) history = parsed;
    } catch { }
  }

  const seen = new Set(history.map((e) => `${e.timestamp}|${e.action || e.event}`));
  for (const entry of logs) {
    const id = `${entry.timestamp}|${entry.action || entry.event}`;
    if (!seen.has(id)) {
      seen.add(id);
      history.push(entry);
    }
  }
  history = history
    .filter((e) => e && e.timestamp)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .slice(-300);

  try {
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 0), 'utf8');
  } catch { }

  const learningReport = getLatestLearningReport();
  const html = generateDashboardHtml({
    identity, scribeIdentity, heartbeat, logs: history, roomMessages, learningReport
  });
  const targetFile = path.join(resolvedDir, 'status.html');
  fs.writeFileSync(targetFile, html, 'utf8');
  console.log(`[Dashboard] Generated live HTML status page with bundled room feeds at: ${targetFile}`);
  return targetFile;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('dashboard.mjs');
if (isDirectRun) {
  updateDashboardFile().catch(console.error);
}
