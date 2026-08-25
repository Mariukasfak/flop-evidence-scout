export const AGENTS = {
  CODEX: 'codex',
  CLAUDE: 'claude',
  GEMINI: 'gemini'
};

export const EVENT_TYPES = {
  RUN_CREATED: 'RUN_CREATED',
  AGENT_STATUS: 'AGENT_STATUS',
  PROPOSAL: 'PROPOSAL',
  CRITIQUE: 'CRITIQUE',
  DELEGATION: 'DELEGATION',
  EXECUTION: 'EXECUTION',
  CODE_REVIEW: 'CODE_REVIEW',
  QUOTA_STATUS: 'QUOTA_STATUS',
  SCORE: 'SCORE',
  FINAL: 'FINAL',
  RUN_COMPLETED: 'RUN_COMPLETED',
  RUN_FAILED: 'RUN_FAILED',
  ERROR: 'ERROR'
};

export function isValidAgent(agentId) {
  return Object.values(AGENTS).includes(agentId);
}

export function isValidEventType(type) {
  return Object.values(EVENT_TYPES).includes(type);
}

export function classifyProviderError(errorMessage) {
  const text = String(errorMessage || '').toLowerCase();
  if (text.includes('oauth') || text.includes('session expired') || text.includes('authenticate') || text.includes('/login') || text.includes('auth')) {
    return {
      status: 'auth_required',
      label: 'Sesija pasibaigusi',
      actionHint: 'Paleiskite terminale atitinkamą CLI ir prisijunkite (/login).',
      isQuotaOrAuth: true
    };
  }
  if (text.includes('quota') || text.includes('rate limit') || text.includes('429') || text.includes('too many requests') || text.includes('usage limit') || text.includes('capacity')) {
    return {
      status: 'quota_warning',
      label: 'Kvota išnaudota / limitas',
      actionHint: 'Pasiektas užklausų limitas; darbai perkeliami kitiems tarybos nariams.',
      isQuotaOrAuth: true
    };
  }
  if (text.includes('timeout') || text.includes('deadline') || text.includes('timed out')) {
    return {
      status: 'timeout',
      label: 'Viršytas laiko limitas',
      actionHint: 'Užklausa užtruko per ilgai ir buvo sustabdyta.',
      isQuotaOrAuth: false
    };
  }
  if (text.includes('not found') || text.includes('enoent') || text.includes('not installed')) {
    return {
      status: 'unavailable',
      label: 'CLI nerastas',
      actionHint: 'Patikrinkite, ar įrankis įdiegtas sistemoje.',
      isQuotaOrAuth: false
    };
  }
  return {
    status: 'error',
    label: 'Klaida',
    actionHint: text.slice(0, 100),
    isQuotaOrAuth: false
  };
}
