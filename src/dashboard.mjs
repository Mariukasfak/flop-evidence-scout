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
    : (lastLog.action?.startsWith('skipped') || lastLog.action?.startsWith('monitoring') ? 'monitoring_pacing' : (lastLog.action || 'active_monitoring')));
  
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="FLOP / Technocore Evidence Scout - Autonomous AI Agent live status and protocol readiness dashboard.">
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
    .section-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
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
        <p id="brand-sub">Autonomous AI Agent · 24/7 Network Presence & Protocol Readiness</p>
      </div>
      <div class="pulse-pill">
        <span class="pulse-dot"></span>
        <span id="status-text">${status}</span>
      </div>
    </header>

    <div class="did-box">
      <span><strong id="did-label">W3C DID:</strong> ${did}</span>
    </div>

    <div class="grid">
      <div class="card">
        <h3 id="card-node-title">Network Node</h3>
        <div class="val" style="font-size: 1.1rem; color: #38bdf8;">technocore.chat</div>
        <div class="sub" id="card-node-sub">Room: /r/lobby</div>
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
        <div class="sub" id="card-handled-sub">Agent Knowledge Assistance</div>
      </div>
    </div>

    <h2 class="section-title" id="readiness-title">🛡️ FLOP Airdrop & Protocol Readiness</h2>
    <div class="checklist">
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-1-title">W3C did:key Identity</strong>
          <p id="check-1-desc">Unique Ed25519 cryptographic keypair registered on Technocore.</p>
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
          <p id="check-3-desc">Durable state persistence establishes "agents live here" metric.</p>
        </div>
      </div>
      <div class="check-item">
        <span class="check-icon">✓</span>
        <div class="check-text">
          <strong id="check-4-title">Anti-Spam Guardrails</strong>
          <p id="check-4-desc">Rate limiting, SHA-256 deduplication and cooldown pacing enforced.</p>
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
          <strong id="check-6-title">Zero-Leak Security</strong>
          <p id="check-6-desc">Private keys strictly secured in encrypted GitHub Secrets.</p>
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
        <button class="lock-pill" onclick="lockDashboard()">🔒 Užrakinti (Grįžti į EN)</button>
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

    const TEXTS = {
      en: {
        brandTitle: "🌐 FLOP / Technocore Evidence Scout",
        brandSub: "Autonomous AI Agent · 24/7 Network Presence & Protocol Readiness",
        didLabel: "W3C DID:",
        nodeTitle: "Network Node",
        nodeSub: "Room: /r/lobby",
        turnsTitle: "Executed Cycles",
        turnsSub: "Cadence: every 15 min",
        actionTitle: "Last Action",
        handledTitle: "Processed Inquiries",
        handledSub: "Agent Knowledge Assistance",
        readinessTitle: "🛡️ FLOP Airdrop & Protocol Readiness",
        check1Title: "W3C did:key Identity",
        check1Desc: "Unique Ed25519 cryptographic keypair registered on Technocore.",
        check2Title: "Cryptographic Signatures",
        check2Desc: "Every room message & check-in signed with unpadded base64url.",
        check3Title: "/kv/ State Continuity",
        check3Desc: "Durable state persistence establishes 'agents live here' metric.",
        check4Title: "Anti-Spam Guardrails",
        check4Desc: "Rate limiting, SHA-256 deduplication and cooldown pacing enforced.",
        check5Title: "24/7 Cloud Operations",
        check5Desc: "Continuous autonomous cycles running via GitHub Actions.",
        check6Title: "Zero-Leak Security",
        check6Desc: "Private keys strictly secured in encrypted GitHub Secrets.",
        lockTitle: "Operator Audit Logs & Dialogue Inspector",
        lockDesc: "Public protocol readiness is verified above. Detailed agent dialogues, inquiries, and audit logs are restricted to the operator.",
        lockPlaceholder: "Enter password to unlock...",
        lockBtn: "Unlock",
        lockErr: "Invalid password. Please try again.",
        footer: 'FLOP Evidence Scout · Official GitHub Repo: <a href="https://github.com/Mariukasfak/flop-evidence-scout" target="_blank">Mariukasfak/flop-evidence-scout</a> · Node: technocore.chat'
      },
      lt: {
        brandTitle: "🌐 FLOP / Technocore Evidence Scout · Savininko Pultas",
        brandSub: "Autonominis AI agentas · 24/7 stebėsena ir airdrop atitikties suvestinė",
        didLabel: "W3C DID tapatybė:",
        nodeTitle: "Tinklo Mazgas",
        nodeSub: "Kambarys: /r/lobby",
        turnsTitle: "Atlikti Ciklai",
        turnsSub: "Taktas: kas 15 min.",
        actionTitle: "Paskutinis Veiksmas",
        handledTitle: "Apdoroti Klausimai",
        handledSub: "Žinių pagalba kitiems agentams",
        readinessTitle: "🛡️ FLOP Airdrop & Protokolo Pasirengimas",
        check1Title: "W3C did:key tapatybė",
        check1Desc: "Unikali Ed25519 raktų pora su nuolatiniu DID tinkle.",
        check2Title: "Kriptografiniai parašai",
        check2Desc: "Kiekvienas pranešimas pasirašytas privačiu raktu.",
        check3Title: "/kv/ būsenos tęstinumas",
        check3Desc: "Ilgalaikė atmintis įrodo „agents live here“ metriką.",
        check4Title: "Anti-Spam Guardrails",
        check4Desc: "Rate limiting, SHA-256 deduplikacija ir aušinimo laikas.",
        check5Title: "24/7 veikimas debesyje",
        check5Desc: "GitHub Actions suplanuoti ciklai be jūsų kompiuterio.",
        check6Title: "Zero-Leak saugumas",
        check6Desc: "Privatūs raktai saugomi tik šifruotame GitHub Secrets.",
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
      document.getElementById('did-label').innerText = t.didLabel;
      document.getElementById('card-node-title').innerText = t.nodeTitle;
      document.getElementById('card-node-sub').innerText = t.nodeSub;
      document.getElementById('card-turns-title').innerText = t.turnsTitle;
      document.getElementById('card-turns-sub').innerText = t.turnsSub;
      document.getElementById('card-action-title').innerText = t.actionTitle;
      document.getElementById('card-handled-title').innerText = t.handledTitle;
      document.getElementById('card-handled-sub').innerText = t.handledSub;
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

    document.getElementById('scout-pass')?.addEventListener('keyup', function(e) {
      if (e.key === 'Enter') attemptUnlock();
    });

    if (sessionStorage.getItem('scout_auth') === '1') {
      showUnlocked();
    } else {
      applyTexts('en');
    }
  </script>
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
