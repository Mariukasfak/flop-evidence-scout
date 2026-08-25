export const VERIFIED_FACTS = Object.freeze([
  {
    topic: 'did_identity',
    keywords: ['did', 'identity', 'key', 'ed25519', 'pasas', 'tapatybe', 'auth'],
    summary: 'Technocore naudoja Ed25519 did:key (z6Mk...) tapatybei. Tas pats raktas įrodo identity continuity tarp sesijų.',
    details: 'DID pasirašymas užtikrina, kad žinutė atėjo iš to paties privataus rakto turėtojo. Vienas nuolatinis agentas su istorija yra stipriausias Anti-Sybil signalas.',
    source: 'flop-labs/technocore-chat docs'
  },
  {
    topic: 'mcp_integration',
    keywords: ['mcp', 'tools', 'claude', 'hermes', 'uvx', 'irankiai', 'model context protocol'],
    summary: 'Technocore palaiko MCP su 9 įrankiais: `claude mcp add technocore -- uvx technocore-mcp`.',
    details: 'MCP įrankiai leidžia agentams skaityti kambarius, siųsti pasirašytas žinutes ir valdyti /kv/ atmintį per standartinius tool calls.',
    source: 'Technocore MCP specification'
  },
  {
    topic: 'kv_persistence',
    keywords: ['kv', 'notes', 'state', 'atmintis', 'busena', 'persistence', 'memory'],
    summary: 'Technocore /kv/ saugykla skirta agentų ilgalaikei būsenai saugoti („agents actually live here“ signalas).',
    details: 'Agentas tarp sesijų turi atsiminti savo būseną per /kv/:key, kad demonstruotų realų tinklo naudojimą, o ne vienkartinį botą.',
    source: 'Technocore architecture docs'
  },
  {
    topic: 'rest_endpoints',
    keywords: ['rest', 'http', 'api', 'endpoints', 'lobby', 'rooms', 'long poll'],
    summary: 'Pagrindiniai REST endpointai: GET/POST /r/lobby, GET/PUT /kv/:key, GET /r/:room/poll.',
    details: 'Galima naudoti paprastą HTTP REST klientą su pasirašytomis Ed25519 antraštėmis (X-DID, X-Signature, X-Timestamp).',
    source: 'flop-labs/technocore-chat README'
  },
  {
    topic: 'security_airdrop',
    keywords: ['token', 'claim', 'presale', 'wallet', 'airdrop', 'snapshot', 'saugumas', 'scam'],
    summary: 'Oficialus FLOP tokenas dar nepaleistas. Nėra jokio presale ar viešo claim puslapio.',
    details: 'Arthur Hayes perspėja: saugokite privatų raktą lokaliai, niekada nejunkite piniginių prie nepatvirtintų „claim“ svetainių.',
    source: 'flop.finance & @CryptoHayes official statements'
  },
  {
    topic: 'github_contribution',
    keywords: ['contribute', 'github', 'pr', 'repo', 'bug', 'testai', 'pataisa'],
    summary: 'Flop Labs oficialiai kviečia bendruomenę prisidėti prie GitHub: flop-labs/technocore-chat.',
    details: 'Vertinami siauri, ištestuoti PR: dokumentacijos tikslinimai, bug fix, testų padengimas ir MCP adapteriai.',
    source: 'flop-labs/technocore-chat CONTRIBUTING.md'
  }
]);

export function findRelevantKnowledge(query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const normalized = query.toLowerCase();
  
  const matches = VERIFIED_FACTS.filter((fact) => {
    return fact.keywords.some((kw) => normalized.includes(kw));
  });

  return matches.length ? matches : [VERIFIED_FACTS[0], VERIFIED_FACTS[2]];
}

export function formatKnowledgeResponse(query) {
  const facts = findRelevantKnowledge(query);
  const sections = facts.slice(0, 2).map((fact) => `[${fact.topic}] ${fact.summary}`);
  return `FLOP Scout Helper: ${sections.join(' | ')}`;
}
