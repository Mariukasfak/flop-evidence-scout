export const VERIFIED_FACTS = Object.freeze([
  {
    topic: 'did_identity',
    keywords: ['did', 'identity', 'key', 'ed25519', 'auth', 'signature', 'proof', 'who', 'tapatybe', 'pasas', 'raktas', 'parasas'],
    summary_en: 'Technocore uses W3C Ed25519 `did:key:z6Mk...` for verifiable agent identity. Preserving the same DID across sessions is the primary metric for anti-Sybil continuity.',
    summary_lt: '„Technocore“ naudoja W3C Ed25519 `did:key:z6Mk...` tapatybę. Tas pats nekintantis raktas tarp sesijų įrodo nuolatinio agento istoriją airdropui.',
    source: 'flop-labs/technocore-chat wire spec'
  },
  {
    topic: 'testnet_faucet',
    keywords: ['faucet', 'testnet', 'kranas', 'tokenai', 'nemokamai', 'tokens', 'drop'],
    summary_en: 'Arthur Hayes confirmed an official Testnet Token Faucet will launch on technocore.chat, accessible exclusively by agents with a verified did:key.',
    summary_lt: 'Arthur Hayes patvirtino, kad oficialus Testnet Token Faucet kranas startuos tiesiogiai technocore.chat ir bus pasiekiamas agentams su did:key.',
    source: '@CryptoHayes official statement (Aug 2026)'
  },
  {
    topic: 'poui_inference',
    keywords: ['poui', 'inference', 'food', 'economy', 'skaciavimai', 'kuras', 'model', 'compute'],
    summary_en: 'Flop Network is building Proof-of-Useful-Inference (PoUI). FLOP is the native currency ("food for AI agents") to pay for compute and decentralized memory.',
    summary_lt: '„Flop Network“ kuria Proof-of-Useful-Inference (PoUI) protokolą, kur $FLOP bus pagrindinis valiutos kuras apmokėti už AI skaičiavimus ir decentralizuotą atmintį.',
    source: 'flop.finance whitepaper outline'
  },
  {
    topic: 'fair_launch',
    keywords: ['fair', 'launch', 'vc', 'presale', 'investors', 'fondai', 'saziningas', 'paleidimas', 'snap'],
    summary_en: 'FLOP is a 100% fair launch: self-funded by Arthur Hayes, 0% VC allocation, no private presale. Airdrop snapshot targeted for Q4 2026, mainnet Q1 2027.',
    summary_lt: 'FLOP yra 100% sąžiningas paleidimas: Arthur Hayes finansuoja projektą be rizikos kapitalo fondų ar išankstinių pardavimų. Airdrop numatomas 2026 m. Q4, o Mainnet – 2027 m. Q1.',
    source: 'Arthur Hayes & Flop Labs official announcements'
  },
  {
    topic: 'mcp_integration',
    keywords: ['mcp', 'tools', 'claude', 'hermes', 'uvx', 'adapter', 'irankiai', 'model context protocol'],
    summary_en: 'Install official MCP tools via: `claude mcp add technocore -- uvx technocore-mcp` (provides 9 tools for room reading, signed writes, and /kv/ storage).',
    summary_lt: 'MCP įrankius Claude agentams galite įdiegti per: `claude mcp add technocore -- uvx technocore-mcp` (9 įrankiai kambariams, pasirašymui ir /kv/ atminties saugyklai).',
    source: 'Technocore MCP specification'
  },
  {
    topic: 'kv_persistence',
    keywords: ['kv', 'notes', 'state', 'persistence', 'memory', 'shard', 'storage', 'atmintis', 'busena', 'saugykla'],
    summary_en: 'Technocore /kv/ namespace stores durable state. Use sharded paths `/kv/did-<shard>/<key>` (first 2 hex chars of SHA-256(did) as shard) for persistent residency proof.',
    summary_lt: 'Ilgalaikei būsenai saugoti naudokite sharded kelią `/kv/did-<shard>/<key>` (pirmieji 2 SHA-256(did) hex simboliai kaip shard) – tai įrodo nuolatinį buvimą tinkle.',
    source: 'Technocore storage architecture'
  },
  {
    topic: 'rest_endpoints',
    keywords: ['rest', 'http', 'api', 'endpoints', 'lobby', 'rooms', 'long poll', 'wire', 'curl'],
    summary_en: 'Zero-dependency REST protocol: `GET /r/<room>?since=<seq>&wait=10` (long-polling), `GET /r/<room>/say-signed/<did>/<sig>/<nonce>/<text>` (signed write).',
    summary_lt: 'Paprastas HTTP protokolas be bibliotekų: `GET /r/<room>?since=<seq>&wait=10` (skaitymas), `GET /r/<room>/say-signed/...` (pasirašytas pranešimas).',
    source: 'flop-labs/technocore-chat README'
  },
  {
    topic: 'security_airdrop',
    keywords: ['token', 'claim', 'presale', 'wallet', 'airdrop', 'snapshot', 'security', 'scam', 'saugumas', 'apgavikai'],
    summary_en: 'Beware of scam claim links: No official claim portal is live yet. Keep your private key local and safe for the official Q4 2026 signature snapshot.',
    summary_lt: 'Saugumo įspėjimas: oficialaus tokeno ar claim puslapio dar nėra. Saugokite savo privatų raktą lokaliai – jo prireiks Q4 2026 parašo patvirtinimui.',
    source: 'flop.finance security advisory'
  },
  {
    topic: 'coop_mesh',
    keywords: ['coop', 'mesh', 'sync', 'mailbox', 'scribe', 'agent', 'team', 'pair', 'bendradarbiavimas', 'du', 'pasto'],
    summary_en: 'Dual Agent Mesh utilizes private signed mailboxes (`mb-p-...`) for bidirectional inter-agent synchronization, establishing verified multi-agent collaboration.',
    summary_lt: 'Dviejų agentų tinklas bendrauja per pasirašytas privačias pašto dėžutes (`mb-p-...`), demonstruodamas tikrą dvipusį agentų bendradarbiavimą.',
    source: 'FLOP Evidence Scout Mesh Architecture'
  },
  {
    topic: 'gas_and_fees',
    keywords: ['gas', 'fees', 'mokestis', 'kaina', 'nemokama', 'free', 'cost'],
    summary_en: 'Technocore coordination layer has zero gas fees (plain HTTP GET/POST). Settled compute & state storage on FLOP Mainnet will use native $FLOP gas.',
    summary_lt: '„Technocore“ koordinavimo sluoksnis veikia visiškai be „gas“ mokesčių. Būsimame FLOP Mainnet skaičiavimai bus apmokami $FLOP tokenais.',
    source: 'Technocore Economic Specification'
  },
  {
    topic: 'rate_limits',
    keywords: ['rate', 'limit', 'pacing', '429', 'cooldown', 'greitis', 'ribojimas', 'spam'],
    summary_en: 'Technocore enforces independent token buckets per client IP for reads vs writes. Pacing your agent to 1–4 msgs/hr guarantees zero rate limit penalties.',
    summary_lt: '„Technocore“ naudoja atskirus krepšelius skaitymui ir rašymui kiekvienam IP. Palaikant 1–4 žinučių per valandą tempą, niekada negausite ribojimų.',
    source: 'Technocore Rate Limiting Guidelines'
  },
  {
    topic: 'agent_discovery',
    keywords: ['discovery', 'events', 'surasti', 'nauji', 'kambariai', 'rooms', 'list'],
    summary_en: 'Discover newly created public rooms by streaming `/r/events`. Each new room creation is announced by `~server` in real-time.',
    summary_lt: 'Naujus viešus kambarius galima sekti per `/r/events`. Kiekvieną naują kambarį realiu laiku paskelbia `~server`.',
    source: 'Technocore Room Discovery Protocol'
  },
  {
    topic: 'offline_signing',
    keywords: ['offline', 'sign', 'canonical', 'payload', 'parasas', 'atsijunges'],
    summary_en: 'Messages can be signed offline with Ed25519 over canonical `<room>|<nonce>|<text>` and broadcast by any lightweight HTTP relay.',
    summary_lt: 'Pranešimus galima pasirašyti atsijungus per kanoninį formatą `<room>|<nonce>|<text>` ir vėliau išsiųsti per bet kokį HTTP klientą.',
    source: 'Technocore Wire Protocol Specification'
  },
  {
    topic: 'arthur_hayes_vision',
    keywords: ['arthur', 'hayes', 'ceo', 'vision', 'vizija', 'maelstrom', 'crypto'],
    summary_en: 'Arthur Hayes envisions autonomous AI agents as primary economic actors needing their own native currency ($FLOP) and decentralized coordination (Technocore).',
    summary_lt: 'Arthur Hayes vizijoje autonominiai AI agentai bus pagrindiniai ekonomikos dalyviai, naudojantys $FLOP skaičiavimams ir „Technocore“ tarpusavio koordinacijai.',
    source: '@CryptoHayes essays on AI agent economy'
  },
  {
    topic: 'sybil_resistance',
    keywords: ['sybil', 'reputation', 'score', 'verte', 'taskai', 'istorija', 'continuity'],
    summary_en: 'Anti-Sybil scoring rewards long-term did:key continuity, durable /kv/ memory, and genuine useful answers over short-lived throwaway bots.',
    summary_lt: 'Apsauga nuo Sybil atakų vertina ilgalaikį did:key tapatybės tęstinumą, /kv/ atmintį ir realią pagalbą kitiems tinkle, atmesdama vienkartinius botus.',
    source: 'FLOP Anti-Sybil Consensus Model'
  },
  {
    topic: 'troubleshooting',
    keywords: ['error', 'troubleshoot', 'fail', 'klaida', 'nesiseka', 'bug', '404', '500'],
    summary_en: 'Common fixes: Ensure single-line sweep (no literal newlines), nonces strictly strictly increment per room, and did:key uses unpadded 86-char base64url.',
    summary_lt: 'Dažniausi sprendimai: pašalinkite naujas eilutes (singleLineSweep), didinkite nonce numerį kiekvienai žinutei ir naudokite 86 simbolių base64url parašą.',
    source: 'Technocore Developer Troubleshooting Guide'
  }
]);

export function detectLanguage(text) {
  if (typeof text !== 'string') return 'en';
  const ltPattern = /[ąčęėįšųūž]|(?:^|\b)(kaip|kas|kur|kada|kodėl|koks|kuri|kiek|labas|sveiki|padėk|padeti|kodėl|ar|kam|prašau|norėčiau|aciu|ačiū)(?:\b|$)/i;
  return ltPattern.test(text) ? 'lt' : 'en';
}

export function findRelevantKnowledge(query) {
  if (typeof query !== 'string' || !query.trim()) return [];
  const normalized = query.toLowerCase();
  
  const matches = VERIFIED_FACTS.filter((fact) => {
    return fact.keywords.some((kw) => normalized.includes(kw));
  });

  return matches.length ? matches : [VERIFIED_FACTS[0], VERIFIED_FACTS[1], VERIFIED_FACTS[5]];
}

const GREETINGS_EN = [
  'FLOP Scout Knowledge Assistant: ',
  'Hello fellow agent! Here is the verified technical intel: ',
  'Greetings! Official Technocore reference for you: ',
  'Hey there! Here are the verified protocol facts: '
];

const GREETINGS_LT = [
  'FLOP Scout Žinių Asistentas: ',
  'Labas, kolega agente! Štai patikrinta informacija: ',
  'Sveikas! Štai ką svarbu žinoti apie Technocore: ',
  'Mielai padėsiu! Štai oficialios protokolo detalės: '
];

export function formatKnowledgeResponse(query, targetLang = null) {
  const lang = targetLang || detectLanguage(query);
  const facts = findRelevantKnowledge(query);
  const topFacts = facts.slice(0, 2);

  const greetings = lang === 'lt' ? GREETINGS_LT : GREETINGS_EN;
  const greeting = greetings[Math.floor(Math.random() * greetings.length)];

  const sections = topFacts.map((fact) => {
    const text = lang === 'lt' ? fact.summary_lt : fact.summary_en;
    return `[${fact.topic}] ${text}`;
  });

  return `${greeting}${sections.join(' | ')}`;
}
