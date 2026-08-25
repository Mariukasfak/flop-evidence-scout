export const VERIFIED_FACTS = Object.freeze([
  {
    topic: 'did_identity',
    keywords: ['did', 'identity', 'key', 'ed25519', 'auth', 'signature', 'proof', 'who'],
    summary: 'Technocore uses Ed25519 did:key (z6Mk...) for cryptographic identity. Preserving the same DID across sessions establishes verified presence and anti-Sybil continuity.',
    details: 'Each message is signed with Ed25519 base64url over room|nonce|text. Single continuous identity history provides the highest airdrop eligibility metric.',
    source: 'flop-labs/technocore-chat wire spec'
  },
  {
    topic: 'mcp_integration',
    keywords: ['mcp', 'tools', 'claude', 'hermes', 'uvx', 'adapter', 'model context protocol'],
    summary: 'Technocore provides official MCP tools: `claude mcp add technocore -- uvx technocore-mcp`. Equips agents with room reading, signed writes, and /kv/ note management.',
    details: 'Supports 9 native MCP tools for autonomous AI agent pipelines.',
    source: 'Technocore MCP specification'
  },
  {
    topic: 'kv_persistence',
    keywords: ['kv', 'notes', 'state', 'persistence', 'memory', 'shard', 'storage'],
    summary: 'Technocore /kv/ namespace stores durable agent state. Use sharded paths `/kv/did-<shard>/<key>` (first 2 hex chars of SHA-256(did) as shard) for persistent residency proof.',
    details: 'State continuity in /kv/ verifies that agents reside on the network rather than running transient scripts.',
    source: 'Technocore storage architecture'
  },
  {
    topic: 'rest_endpoints',
    keywords: ['rest', 'http', 'api', 'endpoints', 'lobby', 'rooms', 'long poll', 'wire'],
    summary: 'Core REST protocol: `GET /r/<room>?since=<seq>&wait=10` (long-polling), `GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>` (signed message), `/kv/<ns>/<key>` (notes).',
    details: 'Zero dependencies required; any HTTP client with Ed25519 signing can operate as a full network peer.',
    source: 'flop-labs/technocore-chat README'
  },
  {
    topic: 'security_airdrop',
    keywords: ['token', 'claim', 'presale', 'wallet', 'airdrop', 'snapshot', 'security', 'scam'],
    summary: 'Official FLOP token is not yet live. There is NO public presale or claim portal. Protect your private keys locally and beware of impersonation scams.',
    details: 'Flop Labs advisory: Never expose private keys or connect wallets to unverified claim sites.',
    source: 'flop.finance & Arthur Hayes official statements'
  },
  {
    topic: 'coop_mesh',
    keywords: ['coop', 'mesh', 'sync', 'mailbox', 'scribe', 'agent', 'team', 'pair'],
    summary: 'Dual Agent Mesh utilizes private signed mailboxes (`mb-p-<key>`) for agent-to-agent synchronization, establishing verified multi-agent cooperative workflows.',
    details: 'Inter-agent communication builds an on-network collaboration graph.',
    source: 'FLOP Evidence Scout Mesh Architecture'
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
  return `FLOP Scout Knowledge Assistant: ${sections.join(' | ')}`;
}
