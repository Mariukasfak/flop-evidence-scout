import { isValidAgent } from './contracts.mjs';

export const RUBRIC = Object.freeze({
  correctness: 0.3,
  taskFit: 0.3,
  safety: 0.2,
  evidence: 0.1,
  clarity: 0.1
});

const RUBRIC_KEYS = Object.keys(RUBRIC);
const RUBRIC_STRING = JSON.stringify(RUBRIC);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const STRING_ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'string' }
};

export const PHASE_SCHEMAS = deepFreeze({
  proposal: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'approach', 'bestFit', 'skills', 'risks', 'verification'],
    properties: {
      summary: { type: 'string' },
      approach: STRING_ARRAY_SCHEMA,
      bestFit: { type: 'string' },
      skills: STRING_ARRAY_SCHEMA,
      risks: STRING_ARRAY_SCHEMA,
      verification: STRING_ARRAY_SCHEMA
    }
  },
  critique: {
    type: 'object',
    additionalProperties: false,
    required: ['reviews'],
    properties: {
      reviews: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['proposalId', 'scores', 'verdict', 'risks'],
          properties: {
            proposalId: { type: 'string' },
            scores: {
              type: 'object',
              additionalProperties: false,
              required: RUBRIC_KEYS,
              properties: Object.fromEntries(RUBRIC_KEYS.map((key) => [key, {
                type: 'number', minimum: 0, maximum: 10
              }]))
            },
            verdict: { type: 'string' },
            risks: STRING_ARRAY_SCHEMA
          }
        }
      }
    }
  },
  delegation: {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'approach', 'owner', 'reviewer', 'reason', 'assignments', 'dissent'],
    properties: {
      answer: { type: 'string' },
      approach: STRING_ARRAY_SCHEMA,
      owner: { type: 'string', enum: ['codex', 'claude', 'gemini'] },
      reviewer: { anyOf: [{ type: 'string', enum: ['codex', 'claude', 'gemini'] }, { type: 'null' }] },
      reason: { type: 'string' },
      assignments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['agentId', 'task', 'verify'],
          properties: {
            agentId: { type: 'string', enum: ['codex', 'claude', 'gemini'] },
            task: { type: 'string' },
            verify: { type: 'string' }
          }
        }
      },
      dissent: STRING_ARRAY_SCHEMA
    }
  },
  execution: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'files', 'instructions', 'verification'],
    properties: {
      summary: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'action', 'content'],
          properties: {
            path: { type: 'string' },
            action: { type: 'string', enum: ['create', 'modify', 'delete'] },
            content: { type: 'string' }
          }
        }
      },
      instructions: STRING_ARRAY_SCHEMA,
      verification: STRING_ARRAY_SCHEMA
    }
  },
  codeReview: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'approved', 'findings', 'suggestions'],
    properties: {
      verdict: { type: 'string' },
      approved: { type: 'boolean' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['severity', 'file', 'note'],
          properties: {
            severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
            file: { type: 'string' },
            note: { type: 'string' }
          }
        }
      },
      suggestions: STRING_ARRAY_SCHEMA
    }
  }
});

const PROPOSAL_SHAPE = JSON.stringify({
  summary: 'Concise proposed answer or plan',
  approach: ['Concrete step'],
  bestFit: 'Why this agent is or is not the best owner',
  skills: ['Relevant capability'],
  risks: ['Specific risk'],
  verification: ['Objective check']
});
const CRITIQUE_SHAPE = JSON.stringify({
  reviews: [{
    proposalId: 'exact-other-agent-proposal-id',
    scores: { correctness: 0, taskFit: 0, safety: 0, evidence: 0, clarity: 0 },
    verdict: 'Evidence-based critique',
    risks: ['Remaining risk']
  }]
});
const DELEGATION_SHAPE = JSON.stringify({
  answer: 'One combined answer grounded in the proposals and critique',
  approach: ['Concrete agreed step'],
  owner: 'codex|claude|gemini',
  reviewer: 'different agent id or null',
  reason: 'Evidence-based routing reason',
  assignments: [{ agentId: 'agent id', task: 'bounded task', verify: 'objective check' }],
  dissent: ['Unresolved minority opinion']
});
const EXECUTION_SHAPE = JSON.stringify({
  summary: 'Concise summary of implemented code changes',
  files: [{ path: 'relative/path/to/file.ext', action: 'modify|create|delete', content: 'Exact updated content or patch' }],
  instructions: ['Step-by-step application instructions'],
  verification: ['Exact test or command to run to verify']
});
const CODE_REVIEW_SHAPE = JSON.stringify({
  verdict: 'Comprehensive code review assessment (logic, safety, regression)',
  approved: true,
  findings: [{ severity: 'info|warning|critical', file: 'path/to/file', note: 'Specific feedback' }],
  suggestions: ['Actionable improvement']
});

function buildSharedContext(context) {
  return `Context: ${context}\nRubric (weights sum to 1): ${RUBRIC_STRING}\nOutput format: one valid JSON object only. Do not use Markdown fences or prose outside JSON.`;
}

export function buildProposalPrompt(context, role) {
  return `${buildSharedContext(context)}\nPhase: PROPOSAL\nRole: ${role}\nInstructions: Give an independent proposal. State concrete work, fit, risks, and objective verification. Required JSON shape: ${PROPOSAL_SHAPE}`;
}

export function buildCritiquePrompt(context, role) {
  return `${buildSharedContext(context)}\nPhase: CRITIQUE\nRole: ${role}\nInstructions: Review every proposal except your own. Use each exact proposalId. Score every rubric dimension from 0 to 10. Required JSON shape: ${CRITIQUE_SHAPE}`;
}

export function buildDelegationPrompt(context, role) {
  return `${buildSharedContext(context)}\nPhase: DELEGATION\nRole: ${role}\nInstructions: Moderate the bounded council discussion. Respect the fixed peer-review owner and reviewer in context, synthesize one answer, assign concrete work to any eligible agents, preserve dissent, and give objective verification. Required JSON shape: ${DELEGATION_SHAPE}`;
}

export function buildExecutionPrompt(context, role) {
  return `${buildSharedContext(context)}\nPhase: EXECUTION\nRole: ${role}\nInstructions: You are the assigned Owner. Implement the code for the agreed council plan. Provide concrete, complete file changes and verification steps. Required JSON shape: ${EXECUTION_SHAPE}`;
}

export function buildCodeReviewPrompt(context, role) {
  return `${buildSharedContext(context)}\nPhase: CODE_REVIEW\nRole: ${role}\nInstructions: You are the assigned independent Reviewer. Audit the implementation above for correctness, security, edge cases, and testability. Required JSON shape: ${CODE_REVIEW_SHAPE}`;
}

export function isCodeTask(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/code')) return true;
  const lower = trimmed.toLowerCase();
  return lower.includes('sukurk kod') || lower.includes('parašyk kod') || lower.includes('implement') || lower.includes('refactor') || lower.includes('programuoti') || lower.includes('kodo');
}

export function extractCodePrompt(prompt) {
  if (typeof prompt !== 'string') return '';
  const trimmed = prompt.trim();
  if (trimmed.startsWith('/code')) {
    return trimmed.slice(5).trim() || 'Tobulinti ir įgyvendinti kodo pakeitimus';
  }
  return trimmed;
}

export function validateExecution(execution) {
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error('Execution must be an object');
  }
  requireString(execution.summary, 'summary');
  requireStringArray(execution.instructions ?? [], 'instructions');
  requireStringArray(execution.verification ?? [], 'verification');
  if (!Array.isArray(execution.files)) {
    execution.files = [];
  }
  return execution;
}

export function validateCodeReview(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    throw new Error('Code review must be an object');
  }
  requireString(review.verdict, 'verdict');
  if (typeof review.approved !== 'boolean') {
    review.approved = true;
  }
  if (!Array.isArray(review.findings)) {
    review.findings = [];
  }
  requireStringArray(review.suggestions ?? [], 'suggestions');
  return review;
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Delegation ${field} must be a non-empty string`);
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Delegation ${field} must be an array of strings`);
  }
}

export function validateDelegation(delegation, {
  eligibleAgentIds,
  expectedOwner,
  expectedReviewer
}) {
  if (!delegation || typeof delegation !== 'object' || Array.isArray(delegation)) {
    throw new Error('Delegation must be an object');
  }
  const eligible = new Set(eligibleAgentIds);
  requireString(delegation.answer, 'answer');
  requireStringArray(delegation.approach, 'approach');
  requireString(delegation.reason, 'reason');
  requireStringArray(delegation.dissent, 'dissent');

  if (!eligible.has(delegation.owner)) throw new Error(`Delegation owner is not eligible: ${delegation.owner}`);
  if (expectedOwner && delegation.owner !== expectedOwner) {
    throw new Error(`Delegation owner must match peer ranking: ${expectedOwner}`);
  }
  if (delegation.reviewer !== null && !eligible.has(delegation.reviewer)) {
    throw new Error(`Delegation reviewer is not eligible: ${delegation.reviewer}`);
  }
  if (delegation.reviewer === delegation.owner) throw new Error('Delegation reviewer must differ from owner');
  if (eligible.size > 1 && delegation.reviewer === null) throw new Error('Delegation reviewer is required when two or more agents are eligible');
  if (expectedReviewer !== undefined && delegation.reviewer !== expectedReviewer) {
    throw new Error(`Delegation reviewer must match peer ranking: ${expectedReviewer}`);
  }

  if (!Array.isArray(delegation.assignments) || delegation.assignments.length === 0) {
    throw new Error('Delegation assignments must contain at least one task');
  }
  const assigned = new Set();
  for (const assignment of delegation.assignments) {
    if (!assignment || typeof assignment !== 'object' || !eligible.has(assignment.agentId)) {
      throw new Error(`Delegation has an ineligible assignment agent: ${assignment?.agentId}`);
    }
    if (assigned.has(assignment.agentId)) throw new Error(`Delegation has duplicate assignment agent: ${assignment.agentId}`);
    assigned.add(assignment.agentId);
    requireString(assignment.task, 'assignment task');
    requireString(assignment.verify, 'assignment verify');
  }

  return delegation;
}

export function aggregateScores(proposals, scores, { learnedPriors = {}, priorWeight = 0 } = {}) {
  if (typeof priorWeight !== 'number' || !Number.isFinite(priorWeight) || priorWeight < 0 || priorWeight > 0.2) {
    throw new Error('Learned prior weight must be between 0 and 0.2');
  }
  for (const [agentId, prior] of Object.entries(learnedPriors)) {
    if (!isValidAgent(agentId) || typeof prior !== 'number' || !Number.isFinite(prior) || prior < 0 || prior > 1) {
      throw new Error(`Invalid learned prior for ${agentId}`);
    }
  }
  const proposalStats = {};
  const knownProposals = new Set();
  
  for (const p of proposals) {
    if (knownProposals.has(p.id)) {
      throw new Error(`Duplicate proposal ID: ${p.id}`);
    }
    knownProposals.add(p.id);
    if (!isValidAgent(p.agentId)) {
      throw new Error(`Unknown agent: ${p.agentId}`);
    }
    proposalStats[p.id] = { sum: 0, count: 0, proposer: p.agentId };
  }

  const reviewPairs = new Set();

  for (const s of scores) {
    const stat = proposalStats[s.proposalId];
    if (!stat) {
      throw new Error(`Unknown proposal ID in score: ${s.proposalId}`);
    }
    if (!isValidAgent(s.agentId)) {
      throw new Error(`Unknown agent: ${s.agentId}`);
    }
    
    if (s.agentId === stat.proposer) {
      throw new Error(`Agent ${s.agentId} cannot score its own proposal ${s.proposalId}`);
    }

    const pairKey = `${s.agentId}:${s.proposalId}`;
    if (reviewPairs.has(pairKey)) {
      throw new Error(`Duplicate review for pair: ${pairKey}`);
    }
    reviewPairs.add(pairKey);

    const scoreKeys = Object.keys(s.scores);
    if (scoreKeys.length !== RUBRIC_KEYS.length || !RUBRIC_KEYS.every(k => scoreKeys.includes(k))) {
      throw new Error(`Missing or extra rubric dimensions. Expected: ${RUBRIC_KEYS.join(', ')}`);
    }

    let totalScore = 0;
    for (const crit of RUBRIC_KEYS) {
      const val = s.scores[crit];
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 10) {
        throw new Error(`Invalid score for ${crit}: ${val}`);
      }
      totalScore += val * RUBRIC[crit];
    }
    
    stat.sum += totalScore;
    stat.count++;
  }

  const results = [];
  for (const [id, stat] of Object.entries(proposalStats)) {
    const peerAverage = stat.count > 0 ? stat.sum / stat.count : 0;
    const learnedPrior = learnedPriors[stat.proposer] ?? 0.5;
    const average = peerAverage * (1 - priorWeight) + learnedPrior * 10 * priorWeight;
    results.push({ id, average, peerAverage, learnedPrior });
  }

  results.sort((a, b) => {
    if (Math.abs(a.average - b.average) > 1e-9) {
      return b.average - a.average;
    }
    return a.id.localeCompare(b.id);
  });

  return results;
}
