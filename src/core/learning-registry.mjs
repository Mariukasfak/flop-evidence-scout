import fs from 'node:fs/promises';
import path from 'node:path';

const TASK_CLASSES = new Set(['code', 'research', 'writing', 'planning', 'general']);
const SAFE_RUN_ID = /^[a-zA-Z0-9_-]+$/;

export function classifyTask(prompt, isCodeTask = false) {
  if (isCodeTask) return 'code';
  const value = String(prompt ?? '').toLocaleLowerCase('lt-LT');
  if (/\b(code|coding|program|kodas|test|bug|build|api|repo)/u.test(value)) return 'code';
  if (/\b(research|ištirk|tyrim|šaltin|rinkos analiz)/u.test(value)) return 'research';
  if (/\b(write|essay|paraš|tekst|straipsn|turin)/u.test(value)) return 'writing';
  if (/\b(plan|planu|strateg|roadmap|architektūr)|suplanu/u.test(value)) return 'planning';
  return 'general';
}

function validateCompletedAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function validateEvidence(evidence, agentIds) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Invalid input: evidence');
  }
  if (typeof evidence.runId !== 'string' || !SAFE_RUN_ID.test(evidence.runId)) {
    throw new Error('Invalid input: runId');
  }
  if (!TASK_CLASSES.has(evidence.taskClass)) throw new Error('Invalid input: taskClass');
  if (!validateCompletedAt(evidence.completedAt)) throw new Error('Invalid input: completedAt');
  if (typeof evidence.degraded !== 'boolean') throw new Error('Invalid input: degraded');
  if (!Array.isArray(evidence.agents) || evidence.agents.length === 0) {
    throw new Error('Invalid input: agents');
  }

  const seenAgents = new Set();
  for (const agent of evidence.agents) {
    if (!agent || typeof agent !== 'object' || !agentIds.has(agent.agentId)) {
      throw new Error(`Invalid input: unknown agentId ${agent?.agentId}`);
    }
    if (seenAgents.has(agent.agentId)) throw new Error(`Invalid input: duplicate agentId ${agent.agentId}`);
    seenAgents.add(agent.agentId);
    if (typeof agent.proposalSucceeded !== 'boolean') throw new Error('Invalid input: proposalSucceeded');
    if (typeof agent.critiqueSucceeded !== 'boolean') throw new Error('Invalid input: critiqueSucceeded');
    if (agent.peerScore !== null
      && (typeof agent.peerScore !== 'number' || !Number.isFinite(agent.peerScore)
        || agent.peerScore < 0 || agent.peerScore > 10)) {
      throw new Error('Invalid input: peerScore');
    }
    if (agent.latencyMs !== null
      && (typeof agent.latencyMs !== 'number' || !Number.isFinite(agent.latencyMs) || agent.latencyMs < 0)) {
      throw new Error('Invalid input: latencyMs');
    }
    if (typeof agent.owner !== 'boolean') throw new Error('Invalid input: owner');
    if (typeof agent.reviewer !== 'boolean') throw new Error('Invalid input: reviewer');
  }
  return evidence;
}

export class LearningRegistry {
  constructor({ root, agentIds = ['codex', 'claude', 'gemini'] }) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('Learning root is required');
    if (!Array.isArray(agentIds) || agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) {
      throw new Error('Learning agentIds must be unique');
    }
    this.root = root;
    this.agentIds = new Set(agentIds);
    this.logFile = path.join(root, 'learning.jsonl');
    this.recordedRuns = new Set();
    this.initialized = false;
    this.writeQueue = Promise.resolve();
  }

  async _parseLog() {
    let content = '';
    try {
      content = await fs.readFile(this.logFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const records = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt JSONL line: ${line}`);
      }
      try {
        records.push(validateEvidence(parsed, this.agentIds));
      } catch (error) {
        throw new Error(`Corrupt learning evidence: ${error.message}`);
      }
    }
    return records;
  }

  async _ensureInit() {
    if (this.initialized) return;
    await fs.mkdir(this.root, { recursive: true });
    const records = await this._parseLog();
    for (const record of records) {
      if (this.recordedRuns.has(record.runId)) {
        throw new Error(`Corrupt learning evidence: duplicate runId ${record.runId}`);
      }
      this.recordedRuns.add(record.runId);
    }
    this.initialized = true;
  }

  async recordRun(evidence) {
    validateEvidence(evidence, this.agentIds);
    const operation = this.writeQueue.then(async () => {
      await this._ensureInit();
      if (this.recordedRuns.has(evidence.runId)) return false;
      await fs.appendFile(this.logFile, `${JSON.stringify(evidence)}\n`, 'utf8');
      this.recordedRuns.add(evidence.runId);
      return true;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async snapshot(taskClass = 'general') {
    if (!TASK_CLASSES.has(taskClass)) throw new Error('Invalid input: taskClass');
    await this.writeQueue;
    await this._ensureInit();
    const allRecords = await this._parseLog();
    const records = taskClass === 'general'
      ? allRecords
      : allRecords.filter((record) => record.taskClass === taskClass);

    const metrics = Object.fromEntries([...this.agentIds].map((agentId) => [agentId, {
      runs: 0,
      proposalSuccesses: 0,
      critiqueSuccesses: 0,
      peerScoreSum: 0,
      peerScoreCount: 0,
      latencySum: 0,
      latencyCount: 0,
      ownerSelections: 0,
      reviewerSelections: 0,
      scoreSum: 0
    }]));

    for (const record of records) {
      for (const agent of record.agents) {
        const metric = metrics[agent.agentId];
        metric.runs += 1;
        if (agent.proposalSucceeded) metric.proposalSuccesses += 1;
        if (agent.critiqueSucceeded) metric.critiqueSuccesses += 1;
        if (agent.peerScore !== null) {
          metric.peerScoreSum += agent.peerScore;
          metric.peerScoreCount += 1;
        }
        if (agent.latencyMs !== null) {
          metric.latencySum += agent.latencyMs;
          metric.latencyCount += 1;
        }
        if (agent.owner) metric.ownerSelections += 1;
        if (agent.reviewer) metric.reviewerSelections += 1;

        const competenceParts = [agent.proposalSucceeded ? 1 : 0, agent.critiqueSucceeded ? 1 : 0];
        if (agent.peerScore !== null) competenceParts.push(agent.peerScore / 10);
        metric.scoreSum += competenceParts.reduce((sum, part) => sum + part, 0) / competenceParts.length;
      }
    }

    const agents = {};
    for (const [agentId, metric] of Object.entries(metrics)) {
      agents[agentId] = {
        runs: metric.runs,
        proposalReliability: metric.runs ? metric.proposalSuccesses / metric.runs : 0,
        critiqueReliability: metric.runs ? metric.critiqueSuccesses / metric.runs : 0,
        peerReviewScore: metric.peerScoreCount ? metric.peerScoreSum / metric.peerScoreCount : 0,
        averageLatencyMs: metric.latencyCount ? metric.latencySum / metric.latencyCount : 0,
        ownerSelections: metric.ownerSelections,
        reviewerSelections: metric.reviewerSelections,
        localPrior: (1 + metric.scoreSum) / (2 + metric.runs)
      };
    }

    return { taskClass, totalRuns: new Set(records.map((record) => record.runId)).size, agents };
  }

  async priors(taskClass = 'general') {
    let snapshot = await this.snapshot(taskClass);
    if (snapshot.totalRuns === 0 && taskClass !== 'general') snapshot = await this.snapshot('general');
    return Object.fromEntries(
      Object.entries(snapshot.agents).map(([agentId, metrics]) => [agentId, metrics.localPrior])
    );
  }
}
