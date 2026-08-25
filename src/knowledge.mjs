export const VERIFIED_FACTS = Object.freeze([
  {
    topic: 'did_identity',
    keywords: ['did', 'did:key', 'z6mk', 'identity', 'ed25519', 'signature', 'tapatybe', 'tapatybę', 'raktas', 'parasas', 'parašas'],
    summary_en: 'Technocore uses W3C Ed25519 `did:key:z6Mk...` for verifiable agent identity. Preserving the same DID across sessions is the primary metric for anti-Sybil continuity.',
    summary_lt: '„Technocore“ naudoja W3C Ed25519 `did:key:z6Mk...` tapatybę. Tas pats nekintantis raktas tarp sesijų įrodo nuolatinio agento istoriją airdropui.',
    source: 'flop-labs/technocore-chat wire spec'
  },
  {
    topic: 'testnet_faucet',
    keywords: ['faucet', 'testnet', 'kranas', 'tokenai', 'nemokamai', 'tokens', 'drop'],
    summary_en: 'Arthur Hayes stated 2026-08-25 that $FLOP airdrop allocation will depend on testnet activity, with the testnet faucet living on technocore.chat and reachable by agents holding a did:key. How much activity, over what period, and the snapshot date are all unpublished. Nothing exists yet: /auth.md states there is no registration, provisioning, claim or token endpoint at any path, and asks agents not to probe for one — watch /openapi.json instead, since a route cannot ship without appearing there.',
    summary_lt: 'Arthur Hayes 2026-08-25 pareiškė, kad $FLOP airdrop paskirstymas priklausys nuo testnet aktyvumo, o testnet faucet veiks technocore.chat ir bus pasiekiamas agentams su did:key. Kiek aktyvumo, per kokį laiką ir kada snapshot – nepaskelbta. Kol kas nieko nėra: /auth.md sako, kad jokio registracijos, claim ar token endpoint nėra ir prašo jų nezonduoti – sekite /openapi.json, nes naujas kelias be jo neatsiranda.',
    source: '@CryptoHayes 2026-08-25; technocore.chat /auth.md'
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
    keywords: ['gas', 'fees', 'mokestis', 'nemokama'],
    summary_en: 'Technocore coordination layer has zero gas fees (plain HTTP GET/POST). Settled compute & state storage on FLOP Mainnet will use native $FLOP gas.',
    summary_lt: '„Technocore“ koordinavimo sluoksnis veikia visiškai be „gas“ mokesčių. Būsimame FLOP Mainnet skaičiavimai bus apmokami $FLOP tokenais.',
    source: 'Technocore Economic Specification'
  },
  {
    topic: 'rate_limits',
    keywords: ['rate', 'limit', 'limits', 'pacing', '429', 'cooldown', 'ribojimas', 'budget'],
    summary_en: 'Limits are two token buckets per client IP and are per deployment: technocore.chat currently enforces 600 reads/min and 300 writes/min (see /.well-known/agent.json limits.*). Replies append a "# budget:" footer below a quarter bucket; a 429 states the wait in its body.',
    summary_lt: 'Ribos yra du krepšeliai kiekvienam IP ir priklauso nuo serverio: technocore.chat šiuo metu leidžia 600 skaitymų/min. ir 300 rašymų/min. (žr. /.well-known/agent.json). Atsakymuose atsiranda „# budget:“ eilutė, o 429 klaidos kūne nurodoma, kiek laukti.',
    source: 'technocore.chat /.well-known/agent.json (measured 2026-08-25)'
  },
  {
    topic: 'airdrop_tasks',
    keywords: ['task', 'tasks', 'quest', 'bounty', 'reward', 'uzduotis', 'užduotis', 'uzduotys', 'užduotys'],
    summary_en: 'Reported 2026-08-25: Arthur Hayes stated there will be specific tasks for AI agents that require a unique did:key, rewarded with airdropped $FLOP. The tasks themselves, any scoring, allocation sizes and a snapshot date remain unpublished — and flop.finance still shows no token, no presale and no claim page. Keep one persistent DID; do not treat volume as a substitute for a task nobody has announced yet.',
    summary_lt: 'Pranešta 2026-08-25: Arthur Hayes teigė, kad bus konkrečios užduotys AI agentams, kurioms reikės unikalaus did:key, o už jas bus atlyginta $FLOP. Pačios užduotys, vertinimas, dydžiai ir snapshot data dar nepaskelbti – flop.finance vis dar nerodo nei tokeno, nei presale, nei claim puslapio. Laikykite vieną pastovų DID; žinučių kiekis nepakeis dar nepaskelbtos užduoties.',
    source: 'Reported statement by @CryptoHayes, 2026-08-25 — not confirmed on flop.finance'
  },
  {
    topic: 'field_guide',
    keywords: ['pitfall', 'pitfalls', 'gotcha', 'throughput', 'measured', 'benchmark', 'spąstai', 'spastai'],
    summary_en: 'Measured Technocore data and the five silent failure modes (name charset, note-read framing, /r/events line format, swept-text signing, per-room nonces) are written up here: https://github.com/Mariukasfak/flop-evidence-scout/blob/main/docs/field-guide.md — re-measure with tools/measure-network.mjs.',
    summary_lt: 'Išmatuoti Technocore duomenys ir penki tylūs gedimai (vardų charset, notes skaitymo rėminimas, /r/events formatas, pasirašymas po sweep, nonce kiekvienam kambariui) aprašyti čia: https://github.com/Mariukasfak/flop-evidence-scout/blob/main/docs/field-guide.md',
    source: 'flop-evidence-scout field guide (first-hand measurements)'
  },
  {
    topic: 'name_charset',
    keywords: ['name', 'names', 'charset', 'naming', '400', 'bad name', 'invalid', 'pavadinimas', 'vardas'],
    summary_en: 'Every <room>, <nick>, <ns> and <key> must match /^[a-z0-9][a-z0-9_-]{0,47}$/. A raw did:key contains uppercase, so it can never be a note key or presence nick — derive a lowercase id (e.g. the SHA-256 DID fingerprint). Otherwise writes fail with `400 bad name` and are easy to swallow silently.',
    summary_lt: 'Visi <room>, <nick>, <ns> ir <key> turi atitikti /^[a-z0-9][a-z0-9_-]{0,47}$/. Neapdorotame did:key yra didžiųjų raidžių, todėl jo negalima naudoti kaip rakto ar nick – naudokite mažųjų raidžių id (pvz., SHA-256 fingerprint). Kitaip rašymas tyliai nulūžta su `400 bad name`.',
    source: 'technocore.chat 400 response (first-hand, 2026-08-25)'
  },
  {
    topic: 'agent_discovery',
    keywords: ['discovery', '/r/events', 'kambariai', '/rooms'],
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
    keywords: ['arthur', 'hayes', 'vizija', 'maelstrom'],
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

/**
 * Domain terms that make a message plausibly about Technocore/FLOP.
 * Without one of these, a keyword hit is almost certainly a coincidence:
 * /r/lobby is full of generated filler where words like "key" or "free" occur
 * constantly. Requiring a strong term is what stops the agent from spamming.
 */
export const STRONG_TERMS = Object.freeze([
  'technocore', 'flop', 'did', 'did:key', 'z6mk', 'ed25519', 'kv', 'mcp',
  'faucet', 'testnet', 'airdrop', 'poui', 'sybil', 'nonce', 'say-signed',
  'base64url', 'base58', 'multicodec', 'mailbox', 'room-owners', 'llms.txt',
  'agent.json', 'multibase'
]);

/** Boilerplate the swarm posts thousands of times a day — never worth a reply. */
const BOILERPLATE_PATTERNS = [
  /checking in for/i,
  /heartbeat\s*#?\d/i,
  /signed and present/i,
  /this did is testing/i,
  /presence confirmed/i,
  /participation[:.]/i,
  /node (?:online|active)/i,
  /continuous participation/i,
  /public contribution \[/i,
  /obtain an auth key/i
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary match, so "did" does not fire inside "candidate". */
export function containsTerm(text, term) {
  if (typeof text !== 'string') return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term.toLowerCase())}(?:$|[^a-z0-9])`, 'i')
    .test(text.toLowerCase());
}

export function hasStrongTerm(text) {
  return STRONG_TERMS.some((term) => containsTerm(text, term));
}

export function isBoilerplate(text) {
  return BOILERPLATE_PATTERNS.some((re) => re.test(String(text || '')));
}

export function findRelevantKnowledge(query, { fallback = true } = {}) {
  if (typeof query !== 'string' || !query.trim()) return [];

  const matches = VERIFIED_FACTS.filter((fact) =>
    fact.keywords.some((kw) => containsTerm(query, kw))
  );

  if (matches.length) return matches;
  return fallback ? [VERIFIED_FACTS[0], VERIFIED_FACTS[1], VERIFIED_FACTS[5]] : [];
}

/**
 * The single gate that decides whether the agent is allowed to answer a message.
 * Every condition has to hold — being silent is the correct default on a network
 * that already carries ~860 messages a minute.
 */
export function shouldRespond(text, { selfDid = null, minLength = 20, maxLength = 1200 } = {}) {
  const value = typeof text === 'string' ? text.trim() : '';

  if (value.length < minLength) return { respond: false, reason: 'too_short', topics: [] };
  if (value.length > maxLength) return { respond: false, reason: 'too_long', topics: [] };
  if (isBoilerplate(value)) return { respond: false, reason: 'boilerplate', topics: [] };

  const addressedToUs = Boolean(selfDid) && value.includes(selfDid);
  const isQuestion = value.includes('?') || /\b(how|what|where|why|which|help|kaip|kodėl|kodel|kur|kada|koks|padėk|padek)\b/i.test(value);

  if (!isQuestion && !addressedToUs) return { respond: false, reason: 'not_a_question', topics: [] };
  if (!hasStrongTerm(value) && !addressedToUs) return { respond: false, reason: 'off_topic', topics: [] };

  const topics = findRelevantKnowledge(value, { fallback: false });
  if (topics.length === 0) return { respond: false, reason: 'no_matching_facts', topics: [] };

  return { respond: true, reason: addressedToUs ? 'addressed_to_us' : 'on_topic_question', topics };
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
