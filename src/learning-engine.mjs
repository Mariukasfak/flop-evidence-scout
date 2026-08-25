import fs from 'node:fs';
import path from 'node:path';
import { VERIFIED_FACTS, findRelevantKnowledge } from './knowledge.mjs';

export function analyzeChatArchives({
  chatsDir = 'data/chats',
  auditPath = 'data/scout-audit.jsonl',
  outputDir = 'data/learning'
} = {}) {
  const resolvedChats = path.resolve(chatsDir);
  const resolvedAudit = path.resolve(auditPath);
  const resolvedOutput = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutput, { recursive: true });

  const allMessages = [];
  const roomsScanned = [];

  if (fs.existsSync(resolvedChats)) {
    const files = fs.readdirSync(resolvedChats).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const roomName = file.replace('-archive.jsonl', '');
      roomsScanned.push(roomName);
      try {
        const lines = fs.readFileSync(path.join(resolvedChats, file), 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            allMessages.push({ room: roomName, ...parsed });
          } catch {}
        }
      } catch {}
    }
  }

  const auditLogs = [];
  if (fs.existsSync(resolvedAudit)) {
    try {
      const lines = fs.readFileSync(resolvedAudit, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try { auditLogs.push(JSON.parse(l)); } catch {}
      }
    } catch {}
  }

  // 1. Participant Analysis
  const participants = new Set();
  const topicCounts = {};
  const unansweredInquiries = [];
  const keywordFrequency = {};

  for (const fact of VERIFIED_FACTS) {
    topicCounts[fact.topic] = 0;
  }

  for (const msg of allMessages) {
    if (msg.from) participants.add(msg.from);
    const text = typeof msg.content === 'string' ? msg.content : (msg.text || '');
    if (!text) continue;

    const lower = text.toLowerCase();

    // Extract word frequencies
    const words = lower.match(/[a-z0-9_-]{3,}/g) || [];
    for (const w of words) {
      keywordFrequency[w] = (keywordFrequency[w] || 0) + 1;
    }

    const matched = findRelevantKnowledge(text);
    for (const m of matched) {
      topicCounts[m.topic] = (topicCounts[m.topic] || 0) + 1;
    }

    // Check if it looks like a question
    const isQuestion = /\?|how|kaip|kas|kur|kada|kodėl|koks|ar |who|what|where|why|when/i.test(text);
    if (isQuestion && matched.length === 0) {
      unansweredInquiries.push({
        room: msg.room,
        from: msg.from || 'anon',
        seq: msg.seq,
        text
      });
    }
  }

  // 2. Audit Activity Breakdown
  const actionCounts = {};
  for (const log of auditLogs) {
    const act = log.action || log.event || 'turn';
    actionCounts[act] = (actionCounts[act] || 0) + 1;
  }

  // 3. Formulate Optimization Recommendations
  const recommendations = [];

  const answeredCount = (actionCounts['answered_inquiry'] || 0) + (actionCounts['coop_sync'] || 0);
  const pacingCount = Object.keys(actionCounts).filter(k => k.includes('pacing') || k.includes('monitoring')).reduce((acc, k) => acc + actionCounts[k], 0);

  if (unansweredInquiries.length > 0) {
    recommendations.push({
      priority: 'HIGH',
      area: 'Knowledge Base Expansion',
      insight: `Aptikta ${unansweredInquiries.length} klausimų, į kuriuos nebuvo paruošto tikslaus atsakymo.`,
      action: `Papildyti src/knowledge.mjs su naujais raktiniais žodžiais: ${unansweredInquiries.slice(0, 3).map(q => `"${q.text.slice(0, 30)}..."`).join(', ')}`
    });
  } else {
    recommendations.push({
      priority: 'NORMAL',
      area: 'Knowledge Base',
      insight: 'Visos tinkle aptiktos užklausos atitinka esamą 16 temų žinių bazę.',
      action: 'Išlaikyti esamą žinių variklį ir toliau stebėti naujus kambarius.'
    });
  }

  if (pacingCount > answeredCount * 10 && answeredCount > 0) {
    recommendations.push({
      priority: 'MEDIUM',
      area: 'Rate Pacing Tuning',
      insight: `Didelė stebėjimo taktų dalis (${pacingCount} stebėjimai vs ${answeredCount} aktyvūs atsakymai).`,
      action: 'Palaikyti esamą saugų 2–4 žin./val. tempą, kad nebūtų švaistomi resursai ramiuoju tinklo laikotarpiu.'
    });
  }

  recommendations.push({
    priority: 'HIGH',
    area: 'Testnet Faucet Readiness',
    insight: 'Arthur Hayes pranešė apie būsimą Testnet Faucet kraną.',
    action: 'Užtikrinti, kad Scribe radaras toliau 24/7 skenuotų /r/events naujų kranų aptikimui.'
  });

  const report = {
    generatedAt: new Date().toISOString(),
    metrics: {
      totalMessagesArchived: allMessages.length,
      roomsScanned,
      uniqueParticipantsCount: participants.size,
      unansweredInquiriesCount: unansweredInquiries.length,
      topTopics: Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    },
    auditSummary: {
      totalLoggedTurns: auditLogs.length,
      actionsBreakdown: actionCounts
    },
    unansweredSample: unansweredInquiries.slice(0, 5),
    recommendations
  };

  // Save JSON
  const jsonPath = path.join(resolvedOutput, 'optimization-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Save Markdown
  const mdContent = `# 🧠 TriAgent AI Savimokos ir Optimizavimo Ataskaita
> Sugeneruota: \`${report.generatedAt}\` | Išanalizuota žinučių: **${report.metrics.totalMessagesArchived}**

---

### 📊 Tinklo Stebėsenos Metrika
- **Skenuoti kambariai:** ${roomsScanned.map(r => `\`/r/${r}\``).join(', ') || 'Nėra'}
- **Unikalių tinklo dalyvių:** **${participants.size}**
- **Populiariausios temos:**
${report.metrics.topTopics.map(([t, c]) => `  - \`[${t}]\`: ${c} paminėjimų`).join('\n')}

---

### 🎯 TriAgent Optimizavimo Rekomendacijos
${recommendations.map(r => `#### [${r.priority}] ${r.area}\n- **Įžvalga:** ${r.insight}\n- **Siūlomas veiksmas:** ${r.action}`).join('\n\n')}

---

### 📋 Neatsakytų Klausimų Pavyzdžiai
${unansweredInquiries.length ? unansweredInquiries.slice(0, 3).map(q => `- **[${q.room}] <${q.from}>:** \`${q.text}\``).join('\n') : 'Visos užklausos sėkmingai apdorotos.'}
`;

  const mdPath = path.join(resolvedOutput, 'optimization-report.md');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  console.log(`[TriAgent Learning] Analysis complete: ${allMessages.length} messages analyzed. Report saved to ${jsonPath}`);
  return report;
}

export function getLatestLearningReport(outputDir = 'data/learning') {
  const jsonPath = path.resolve(path.join(outputDir, 'optimization-report.json'));
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

export function pruneOldArchives({
  chatsDir = 'data/chats',
  maxKeepPerRoom = 200,
  deleteAll = false
} = {}) {
  const resolvedChats = path.resolve(chatsDir);
  if (!fs.existsSync(resolvedChats)) return { prunedFiles: 0, removedLines: 0 };

  let prunedFiles = 0;
  let removedLines = 0;

  const files = fs.readdirSync(resolvedChats).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const filePath = path.join(resolvedChats, file);
    try {
      if (deleteAll) {
        fs.unlinkSync(filePath);
        prunedFiles++;
      } else {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        if (lines.length > maxKeepPerRoom) {
          const keepLines = lines.slice(-maxKeepPerRoom);
          removedLines += (lines.length - keepLines.length);
          fs.writeFileSync(filePath, keepLines.join('\n') + '\n', 'utf8');
          prunedFiles++;
        }
      }
    } catch {}
  }

  if (deleteAll) {
    console.log(`[Archive Pruner] Deleted all ${prunedFiles} chat archive files after training.`);
  } else {
    console.log(`[Archive Pruner] Pruned ${prunedFiles} chat archives, removed ${removedLines} old lines. Retained newest ${maxKeepPerRoom} per room.`);
  }
  return { prunedFiles, removedLines };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('learning-engine.mjs');
if (isDirectRun) {
  const shouldPrune = process.argv.includes('--prune');
  const shouldDeleteAll = process.argv.includes('--clean') || process.argv.includes('--delete-all');
  
  analyzeChatArchives();
  
  if (shouldPrune || shouldDeleteAll) {
    pruneOldArchives({ deleteAll: shouldDeleteAll });
  }
}
