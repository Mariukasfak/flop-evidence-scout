import { createHash } from 'node:crypto';

import {
  aggregateScores,
  buildCodeReviewPrompt,
  buildCritiquePrompt,
  buildDelegationPrompt,
  buildExecutionPrompt,
  buildProposalPrompt,
  extractCodePrompt,
  isCodeTask,
  validateCodeReview,
  validateDelegation,
  validateExecution
} from './core/council.mjs';
import { classifyProviderError, EVENT_TYPES, isValidAgent } from './core/contracts.mjs';
import { classifyTask } from './core/learning-registry.mjs';

function checkpoint(value) {
  const content = JSON.stringify(value);
  return {
    id: createHash('sha256').update(content).digest('hex').slice(0, 16),
    content
  };
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConversationHistory(history) {
  if (!Array.isArray(history)) throw new Error('conversationHistory must be an array');
  const valid = history
    .filter((message) => (
      message && typeof message === 'object'
      && ['user', 'assistant'].includes(message.role)
      && typeof message.content === 'string'
      && message.content.trim()
    ))
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 4_000)
    }));

  const bounded = [];
  let characters = 0;
  for (const message of valid.toReversed()) {
    if (characters + message.content.length > 12_000) break;
    bounded.push(message);
    characters += message.content.length;
  }
  return bounded.toReversed();
}

class ProposalQualityError extends Error {
  constructor(providerId, detail) {
    super(`${providerId} returned a low-quality proposal: ${detail}`);
    this.name = 'ProposalQualityError';
  }
}

function validateProposal(providerId, proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new ProposalQualityError(providerId, 'not an object');
  }
  if (typeof proposal.summary !== 'string' || proposal.summary.trim().length < 20) {
    throw new ProposalQualityError(providerId, 'summary is missing, placeholder-like, or too short');
  }
  if (typeof proposal.bestFit !== 'string' || proposal.bestFit.trim().length < 10) {
    throw new ProposalQualityError(providerId, 'bestFit is missing or too short');
  }
  for (const field of ['approach', 'skills', 'verification']) {
    if (!Array.isArray(proposal[field]) || proposal[field].length === 0
      || proposal[field].some((item) => typeof item !== 'string' || !item.trim())) {
      throw new ProposalQualityError(providerId, `${field} must contain concrete non-empty items`);
    }
  }
  if (!Array.isArray(proposal.risks)
    || proposal.risks.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ProposalQualityError(providerId, 'risks must be an array of non-empty strings');
  }
  return proposal;
}

export class CouncilOrchestrator {
  constructor({ store, providers, capabilityProfiles = {}, conductorId = 'gemini', learningRegistry = null }) {
    this.store = store;
    this.providers = providers;
    this.capabilityProfiles = capabilityProfiles;
    this.conductorId = conductorId;
    this.learningRegistry = learningRegistry;
    for (const provider of providers) {
      if (!isValidAgent(provider.id)) throw new Error(`Unsupported provider id: ${provider.id}`);
    }
  }

  async run({ runId, prompt, mode = 'live', conversationHistory = [], onFinal = null }) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is required');
    if (mode !== 'live') throw new Error('TriAgent supports live mode only');
    if (onFinal !== null && typeof onFinal !== 'function') throw new Error('onFinal must be a function');
    const boundedConversationHistory = normalizeConversationHistory(conversationHistory);
    const isCode = isCodeTask(prompt);
    const cleanedPrompt = isCode ? extractCodePrompt(prompt) : prompt.trim();
    const taskClass = classifyTask(cleanedPrompt, isCode);
    const learnedPriors = this.learningRegistry
      ? await this.learningRegistry.priors(taskClass)
      : Object.fromEntries(this.providers.map((provider) => [provider.id, 0.5]));
    this.store.createRun(runId, { prompt: prompt.trim(), mode, isCodeTask: isCode });
    const degradedReasons = [];
    const performance = new Map(this.providers.map((provider) => [provider.id, {
      latencyMs: 0,
      proposalSucceeded: false,
      critiqueSucceeded: false
    }]));
    const callProvider = async (provider, request) => {
      const startedAt = Date.now();
      try {
        return await provider.generate(request);
      } finally {
        performance.get(provider.id).latencyMs += Math.max(0, Date.now() - startedAt);
      }
    };
    const persistLearning = async ({ proposals = [], ranking = [], owner = null, reviewer = null, degraded }) => {
      const learning = {
        source: 'triagent-runs-only',
        taskClass,
        priors: learnedPriors,
        persisted: false
      };
      if (!this.learningRegistry) return learning;

      const proposalsByAgent = new Map(proposals.map((proposal) => [proposal.agentId, proposal]));
      const rankingByProposal = new Map(ranking.map((entry) => [entry.id, entry]));
      const agents = this.providers.map((provider) => {
        const stats = performance.get(provider.id);
        const proposal = proposalsByAgent.get(provider.id);
        const rankingEntry = proposal ? rankingByProposal.get(proposal.id) : null;
        return {
          agentId: provider.id,
          proposalSucceeded: stats.proposalSucceeded,
          critiqueSucceeded: stats.critiqueSucceeded,
          peerScore: Number.isFinite(rankingEntry?.peerAverage) ? rankingEntry.peerAverage : null,
          latencyMs: stats.latencyMs,
          owner: provider.id === owner,
          reviewer: provider.id === reviewer
        };
      });

      try {
        const recorded = await this.learningRegistry.recordRun({
          runId,
          taskClass,
          completedAt: new Date().toISOString(),
          degraded,
          agents
        });
        return { ...learning, persisted: true, newEvidence: recorded };
      } catch (error) {
        degradedReasons.push('learning_persist_failed');
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.ERROR,
          payload: { phase: 'learning', message: publicError(error) }
        });
        return { ...learning, error: publicError(error) };
      }
    };

    const proposalCheckpoint = checkpoint({
      schemaVersion: 1,
      task: cleanedPrompt,
      isCodeTask: isCode,
      capabilityProfiles: this.capabilityProfiles,
      learning: { source: 'triagent-runs-only', taskClass, learnedPriors },
      conversationHistory: boundedConversationHistory,
      constraints: ['Council opinions do not authorize tool execution.']
    });

    const proposalResults = await Promise.all(this.providers.map(async (provider) => {
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.AGENT_STATUS,
        agentId: provider.id,
        payload: { phase: 'proposal', status: 'running', checkpointId: proposalCheckpoint.id }
      });
      try {
        const basePrompt = buildProposalPrompt(proposalCheckpoint.content, provider.id);
        const proposalRequest = {
          phase: 'proposal',
          prompt: basePrompt,
          contextCheckpoint: proposalCheckpoint.content,
          runId
        };
        let content;
        try {
          content = validateProposal(provider.id, await callProvider(provider, proposalRequest));
        } catch (error) {
          if (!(error instanceof ProposalQualityError)) throw error;
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.AGENT_STATUS,
            agentId: provider.id,
            payload: { phase: 'proposal', status: 'retrying', attempt: 2, reason: error.message }
          });
          content = validateProposal(provider.id, await callProvider(provider, {
            ...proposalRequest,
            prompt: `${basePrompt}\nRepair attempt: the previous object was schema-valid but too generic. Return a task-specific, evidence-based proposal with concrete steps and checks.`
          }));
        }
        const proposal = { id: `${provider.id}-proposal`, agentId: provider.id, content };
        performance.get(provider.id).proposalSucceeded = true;
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.PROPOSAL,
          agentId: provider.id,
          payload: { ...proposal, checkpointId: proposalCheckpoint.id }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: provider.id,
          payload: { phase: 'proposal', status: 'completed' }
        });
        return proposal;
      } catch (error) {
        degradedReasons.push(`proposal_${provider.id}_failed`);
        const errMessage = publicError(error);
        const classified = classifyProviderError(errMessage);
        if (classified.isQuotaOrAuth) {
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.QUOTA_STATUS,
            agentId: provider.id,
            payload: { phase: 'proposal', ...classified, detail: errMessage }
          });
        }
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.ERROR,
          agentId: provider.id,
          payload: { phase: 'proposal', message: errMessage }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: provider.id,
          payload: { phase: 'proposal', status: 'failed' }
        });
        return null;
      }
    }));

    const proposals = proposalResults.filter(Boolean);
    if (proposals.length === 0) {
      await persistLearning({ degraded: true });
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.ERROR,
        payload: { phase: 'proposal', message: 'No provider produced a proposal' }
      });
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.RUN_FAILED,
        payload: { phase: 'proposal', message: 'No provider produced a proposal' }
      });
      throw new Error('No provider produced a proposal');
    }

    const successfulIds = new Set(proposals.map((proposal) => proposal.agentId));
    const critiqueCheckpoint = checkpoint({
      schemaVersion: 1,
      task: cleanedPrompt,
      isCodeTask: isCode,
      proposals,
      instruction: 'Review every proposal except your own.'
    });

    const critiqueResults = await Promise.all(this.providers.map(async (provider) => {
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.AGENT_STATUS,
        agentId: provider.id,
        payload: { phase: 'critique', status: 'running', checkpointId: critiqueCheckpoint.id }
      });
      try {
        const critique = await callProvider(provider, {
          phase: 'critique',
          prompt: buildCritiquePrompt(critiqueCheckpoint.content, provider.id),
          contextCheckpoint: critiqueCheckpoint.content,
          runId
        });
        const reviews = Array.isArray(critique?.reviews) ? critique.reviews : [];
        performance.get(provider.id).critiqueSucceeded = true;
        const expectedReviews = proposals.length - (successfulIds.has(provider.id) ? 1 : 0);
        if (reviews.length < expectedReviews) degradedReasons.push(`critique_${provider.id}_incomplete`);
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.CRITIQUE,
          agentId: provider.id,
          payload: { reviews, checkpointId: critiqueCheckpoint.id }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: provider.id,
          payload: { phase: 'critique', status: 'completed' }
        });
        return {
          agentId: provider.id,
          success: true,
          reviews: reviews.map((review) => ({ ...review, agentId: provider.id }))
        };
      } catch (error) {
        degradedReasons.push(`critique_${provider.id}_failed`);
        const errMessage = publicError(error);
        const classified = classifyProviderError(errMessage);
        if (classified.isQuotaOrAuth) {
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.QUOTA_STATUS,
            agentId: provider.id,
            payload: { phase: 'critique', ...classified, detail: errMessage }
          });
        }
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.ERROR,
          agentId: provider.id,
          payload: { phase: 'critique', message: errMessage }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: provider.id,
          payload: { phase: 'critique', status: 'failed' }
        });
        return { agentId: provider.id, success: false, reviews: [] };
      }
    }));

    const peerScores = critiqueResults.flatMap((result) => result.reviews);
    let ranking;
    try {
      ranking = aggregateScores(proposals, peerScores, {
        learnedPriors,
        priorWeight: this.learningRegistry ? 0.15 : 0
      });
    } catch (error) {
      degradedReasons.push('peer_ranking_invalid');
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.ERROR,
        payload: { phase: 'decision', message: publicError(error) }
      });
      ranking = proposals
        .map((proposal) => ({ id: proposal.id, average: 0 }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    const winningProposal = proposals.find((proposal) => proposal.id === ranking[0].id);
    const owner = winningProposal.agentId;
    const reviewerProposal = ranking
      .slice(1)
      .map((entry) => proposals.find((proposal) => proposal.id === entry.id))
      .find(Boolean);
    const reviewer = reviewerProposal?.agentId ?? null;
    const eligibleAgentIds = proposals.map((proposal) => proposal.agentId);
    const conductorProvider = this.providers.find((provider) => provider.id === this.conductorId);
    const delegationCheckpoint = checkpoint({
      schemaVersion: 1,
      task: cleanedPrompt,
      isCodeTask: isCode,
      proposals,
      peerReviews: peerScores,
      ranking,
      fixedDecision: { owner, reviewer },
      eligibleAgentIds,
      instruction: 'Synthesize the discussion and assign bounded, objectively verifiable work. Do not change fixedDecision.'
    });

    let decisionSource = 'deterministic-fallback';
    let delegation = null;
    if (!conductorProvider) {
      degradedReasons.push(`${this.conductorId}_conductor_unavailable`);
    } else {
      this.store.appendEvent(runId, {
        type: EVENT_TYPES.AGENT_STATUS,
        agentId: this.conductorId,
        payload: { phase: 'delegation', status: 'running', checkpointId: delegationCheckpoint.id }
      });
      try {
        delegation = validateDelegation(await callProvider(conductorProvider, {
          phase: 'delegation',
          prompt: buildDelegationPrompt(delegationCheckpoint.content, this.conductorId),
          contextCheckpoint: delegationCheckpoint.content,
          runId
        }), {
          eligibleAgentIds,
          expectedOwner: owner,
          expectedReviewer: reviewer
        });
        decisionSource = `${this.conductorId}-conductor`;
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: this.conductorId,
          payload: { phase: 'delegation', status: 'completed' }
        });
      } catch (error) {
        degradedReasons.push(`${this.conductorId}_conductor_failed`);
        const errMessage = publicError(error);
        const classified = classifyProviderError(errMessage);
        if (classified.isQuotaOrAuth) {
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.QUOTA_STATUS,
            agentId: this.conductorId,
            payload: { phase: 'delegation', ...classified, detail: errMessage }
          });
        }
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.ERROR,
          agentId: this.conductorId,
          payload: { phase: 'delegation', message: errMessage }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: this.conductorId,
          payload: { phase: 'delegation', status: 'failed' }
        });
      }
    }

    if (!delegation) {
      delegation = {
        answer: winningProposal.content.summary,
        approach: winningProposal.content.approach ?? [],
        owner,
        reviewer,
        reason: 'Deterministic fallback from the highest valid peer-review score and proposal-id tie-break.',
        assignments: eligibleAgentIds.map((agentId) => ({
          agentId,
          task: agentId === owner
            ? 'Įgyvendinti laimėjusį tarybos sprendimą.'
            : agentId === reviewer
              ? 'Nepriklausomai patikrinti owner rezultatą.'
              : 'Patikrinti kraštinius atvejus ir pateikti papildomus įrodymus.',
          verify: agentId === reviewer ? 'Reikalavimų, testų ir diff review.' : 'Objektyvūs testai arba atsekami įrodymai.'
        })),
        dissent: []
      };
    }

    const uniqueReasons = [...new Set(degradedReasons)].sort();
    const degraded = uniqueReasons.length > 0 || proposals.length !== this.providers.length;
    const participantCoverage = {
      proposals: `${proposals.length}/${this.providers.length}`,
      critiques: `${critiqueResults.filter((result) => result.success).length}/${this.providers.length}`,
      conductor: decisionSource === `${this.conductorId}-conductor`
    };

    this.store.appendEvent(runId, {
      type: EVENT_TYPES.DELEGATION,
      ...(decisionSource === `${this.conductorId}-conductor` ? { agentId: this.conductorId } : {}),
      payload: {
        ...delegation,
        ranking,
        conductorId: this.conductorId,
        decisionSource,
        degraded,
        degradedReasons: uniqueReasons,
        participantCoverage,
        checkpointId: delegationCheckpoint.id
      }
    });

    let executionResult = null;
    let codeReviewResult = null;

    if (isCode) {
      const ownerProvider = this.providers.find((p) => p.id === owner);
      const executionCheckpoint = checkpoint({
        schemaVersion: 1,
        task: cleanedPrompt,
        plan: delegation,
        owner
      });

      if (ownerProvider) {
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.AGENT_STATUS,
          agentId: owner,
          payload: { phase: 'execution', status: 'running', checkpointId: executionCheckpoint.id }
        });
        try {
          const rawExecution = await callProvider(ownerProvider, {
            phase: 'execution',
            prompt: buildExecutionPrompt(executionCheckpoint.content, owner),
            contextCheckpoint: executionCheckpoint.content,
            runId
          });
          executionResult = validateExecution(rawExecution);
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.EXECUTION,
            agentId: owner,
            payload: { ...executionResult, owner, checkpointId: executionCheckpoint.id }
          });
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.AGENT_STATUS,
            agentId: owner,
            payload: { phase: 'execution', status: 'completed' }
          });
        } catch (error) {
          degradedReasons.push(`execution_${owner}_failed`);
          const errMessage = publicError(error);
          const classified = classifyProviderError(errMessage);
          if (classified.isQuotaOrAuth) {
            this.store.appendEvent(runId, {
              type: EVENT_TYPES.QUOTA_STATUS,
              agentId: owner,
              payload: { phase: 'execution', ...classified, detail: errMessage }
            });
          }
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.ERROR,
            agentId: owner,
            payload: { phase: 'execution', message: errMessage }
          });
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.AGENT_STATUS,
            agentId: owner,
            payload: { phase: 'execution', status: 'failed' }
          });
        }
      }

      if (reviewer && executionResult) {
        const reviewerProvider = this.providers.find((p) => p.id === reviewer);
        const reviewCheckpoint = checkpoint({
          schemaVersion: 1,
          task: cleanedPrompt,
          execution: executionResult,
          reviewer
        });

        if (reviewerProvider) {
          this.store.appendEvent(runId, {
            type: EVENT_TYPES.AGENT_STATUS,
            agentId: reviewer,
            payload: { phase: 'codeReview', status: 'running', checkpointId: reviewCheckpoint.id }
          });
          try {
            const rawReview = await callProvider(reviewerProvider, {
              phase: 'codeReview',
              prompt: buildCodeReviewPrompt(reviewCheckpoint.content, reviewer),
              contextCheckpoint: reviewCheckpoint.content,
              runId
            });
            codeReviewResult = validateCodeReview(rawReview);
            this.store.appendEvent(runId, {
              type: EVENT_TYPES.CODE_REVIEW,
              agentId: reviewer,
              payload: { ...codeReviewResult, reviewer, checkpointId: reviewCheckpoint.id }
            });
            this.store.appendEvent(runId, {
              type: EVENT_TYPES.AGENT_STATUS,
              agentId: reviewer,
              payload: { phase: 'codeReview', status: 'completed' }
            });
          } catch (error) {
            degradedReasons.push(`code_review_${reviewer}_failed`);
            const errMessage = publicError(error);
            const classified = classifyProviderError(errMessage);
            if (classified.isQuotaOrAuth) {
              this.store.appendEvent(runId, {
                type: EVENT_TYPES.QUOTA_STATUS,
                agentId: reviewer,
                payload: { phase: 'codeReview', ...classified, detail: errMessage }
              });
            }
            this.store.appendEvent(runId, {
              type: EVENT_TYPES.ERROR,
              agentId: reviewer,
              payload: { phase: 'codeReview', message: errMessage }
            });
            this.store.appendEvent(runId, {
              type: EVENT_TYPES.AGENT_STATUS,
              agentId: reviewer,
              payload: { phase: 'codeReview', status: 'failed' }
            });
          }
        }
      }
    }

    const learning = await persistLearning({
      proposals,
      ranking,
      owner,
      reviewer,
      degraded: degraded || degradedReasons.length > 0
    });
    const finalDegradedReasons = [...new Set(degradedReasons)].sort();
    const finalDegraded = finalDegradedReasons.length > 0 || proposals.length !== this.providers.length;
    const finalPayload = {
      answer: delegation.answer,
      approach: delegation.approach,
      owner,
      reviewer,
      assignments: delegation.assignments,
      dissent: delegation.dissent,
      reason: delegation.reason,
      conductorId: this.conductorId,
      decisionSource,
      ranking,
      degraded: finalDegraded,
      degradedReasons: finalDegradedReasons,
      participantCoverage,
      learning,
      isCodeTask: isCode,
      execution: executionResult,
      codeReview: codeReviewResult,
      files: executionResult?.files ?? [],
      proposals: proposals.map(({ id, agentId, content }) => ({ id, agentId, summary: content.summary })),
      note: isCode
        ? 'Kodo sprendimas parengtas ir patikrintas tarybos; pritaikykite failų pakeitimus ir patikrinkite testais.'
        : 'Tarybos sprendimas ir darbų paskyrimas yra planas; kompiuterio veiksmai reikalauja atskiro vykdymo ir leidimų.'
    };

    if (onFinal) {
      try {
        await onFinal(finalPayload);
      } catch (error) {
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.ERROR,
          payload: { phase: 'chat_persistence', message: publicError(error) }
        });
        this.store.appendEvent(runId, {
          type: EVENT_TYPES.RUN_FAILED,
          payload: { phase: 'chat_persistence', message: 'Final chat response could not be persisted' }
        });
        throw error;
      }
    }

    this.store.appendEvent(runId, {
      type: EVENT_TYPES.FINAL,
      agentId: decisionSource === `${this.conductorId}-conductor` ? this.conductorId : owner,
      payload: finalPayload
    });
    this.store.appendEvent(runId, {
      type: EVENT_TYPES.RUN_COMPLETED,
      payload: {
        owner,
        reviewer,
        conductorId: this.conductorId,
        decisionSource,
        degraded: finalDegraded,
        degradedReasons: finalDegradedReasons,
        learning,
        isCodeTask: isCode
      }
    });

    return finalPayload;
  }
}
