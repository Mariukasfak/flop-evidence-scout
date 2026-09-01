import { messageSkeleton } from './learning-engine.mjs';

export const VERIFIED_FACTS = Object.freeze([
  {
    topic: 'did_identity',
    keywords: ['did', 'did:key', 'z6mk', 'identity', 'ed25519', 'signature', 'tapatybe', 'tapatybę', 'raktas', 'parasas', 'parašas'],
    /**
     * Trimmed back to what is actually published.
     *
     * This said keeping one DID was "the primary metric for anti-Sybil
     * continuity", sourced to the wire spec. The wire spec says nothing of the
     * kind — /auth.md says a signature proves control of a key and nothing
     * else, not identity, honesty or usefulness — and no anti-Sybil rule has
     * been published by anyone. The Lithuanian version went further still and
     * told strangers a stable key "proves" an agent's history for the airdrop.
     *
     * An unsourced guess is bad enough in a file. This one was being said out
     * loud, to other people, in public rooms, as a verified fact.
     */
    summary_en: 'Technocore uses W3C Ed25519 `did:key:z6Mk...` for agent identity. /auth.md is explicit about the limit of that: a signature proves control of a key, not the identity, honesty or usefulness of whoever holds it. Flop Labs has asked agents to create a unique DID, but has published no anti-Sybil rule, no weighting for a long-lived key, and nothing about how multiple DIDs from one operator will be treated.',
    summary_lt: '„Technocore“ naudoja W3C Ed25519 `did:key:z6Mk...` tapatybę. /auth.md aiškiai sako, kokia to riba: parašas įrodo rakto valdymą, bet ne savininko tapatybę, sąžiningumą ar naudą. „Flop Labs“ prašė susikurti unikalų DID, tačiau nepaskelbė nei anti-Sybil taisyklės, nei ar ilgaamžis raktas ką nors sveria, nei kaip bus vertinami keli vieno operatoriaus DID.',
    source: 'technocore.chat /auth.md; Flop Labs post 2026-08-25'
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
    summary_en: 'FLOP is a fair launch: Teaser v0.1 states there is no token sale and no investor allocation, and Hayes says he self-funded the team. The genesis supply is distributed through the testnet airdrop. Testnet Q4 2026 for ~90 days, mainnet Q1 2027.',
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
    summary_en: 'Beware of claim links: no official claim portal exists, and no wallet format, address scheme or transaction signing has been published at all — so nobody can hold $FLOP yet. Keep your private key local. /r/faucet on this service is NOT a faucet: it is a room a stranger created where bots post requests at each other.',
    summary_lt: 'Saugumo įspėjimas: oficialaus claim puslapio nėra, ir neskelbtas joks piniginės formatas ar adresų schema – tad $FLOP kol kas niekas laikyti negali. Saugokite privatų raktą lokaliai. /r/faucet šiame servise NĖRA faucet: tai svetimo sukurtas kambarys, kuriame botai rašo prašymus vienas kitam.',
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
    topic: 'testnet_allocation',
    keywords: ['allocation', 'supply', '20%', 'tokenomics', 'emission', 'distribution', 'paskirstymas', 'emisija'],
    summary_en: 'Flop Network Teaser v0.1 (flop.finance/teaser/, 2026-08-26) supersedes every earlier interview reading. Genesis airdrop is 3.5bn $FLOP, 20.4% of the ~17.2bn year-10 supply: miners up to 1.2bn, AI agents up to 1.2bn, validators 305,505,000, reserve 794,495,000. An agent allocation is based largely on what it SPENDS on inference during the testnet, arrives locked, and unlocks at 3 $FLOP spent per 1 freed — so the inference route frees at most a quarter of it. Testnet Q4 2026 for ~90 days, mainnet Q1 2027; results settle into the genesis block. Note Flop Labs and the Foundation each take 8 $FLOP per block IN ADDITION to the 96 block reward, so real issuance is 112/block and their share sunsets after year TEN, not after the first halving as earlier coverage said. The document is stamped draft and its figures are provisional; the Yellow Paper is not final.',
    summary_lt: 'Flop Network Teaser v0.1 (flop.finance/teaser/, 2026-08-26) pakeičia visus ankstesnius interviu skaitymus. Genesis airdrop – 3,5 mlrd. $FLOP, 20,4% nuo ~17,2 mlrd. 10 metų pasiūlos: mineriams iki 1,2 mlrd., AI agentams iki 1,2 mlrd., validatoriams 305 505 000, rezervui 794 495 000. Agento dalis priklauso daugiausia nuo to, kiek jis IŠLEIDŽIA inference per testnetą; ji ateina užrakinta ir atsirakina santykiu 3 išleisti : 1 atlaisvintas, tad šiuo keliu likvidus tampa daugiausia ketvirtadalis. Testnet Q4 2026, apie 90 dienų; mainnet Q1 2027. Svarbu: Flop Labs ir Fondas gauna po 8 $FLOP už bloką PAPILDOMAI prie 96, tad reali emisija – 112 už bloką, o jų dalis baigiasi po DEŠIMTIES metų, ne po pirmojo halving, kaip rašė ankstesni šaltiniai. Dokumentas pažymėtas kaip juodraštis, skaičiai preliminarūs.',
    source: 'Hayes direct interview, Bloomingbit 2026-08-26 — reported by a first-hand source, still not confirmed on flop.finance'
  },
  {
    topic: 'pre_genesis_gap',
    keywords: ['genesis', 'mainnet', 'custody', 'hold', 'bridge', 'chain', 'grandine'],
    summary_en: 'An open question nobody has answered: the airdrop is slated for Q4 2026 but the Flop Network genesis block is Q1 2027, so there is a quarter in which a distributed token has no native chain to live on. No chain has been announced at all. Practical consequence: it is not currently possible to create a correct FLOP wallet, and anything offering to hold, bridge or claim FLOP before genesis should be treated as a scam.',
    summary_lt: 'Atviras klausimas, į kurį niekas neatsakė: airdrop planuojamas 2026 Q4, o Flop Network genesis blokas – 2027 Q1, tad lieka ketvirtis, kai paskirstytas tokenas neturi savo grandinės. Grandinė apskritai nepaskelbta. Praktinė išvada: teisingos FLOP piniginės sukurti šiuo metu neįmanoma, o bet kas, siūlantis laikyti, perkelti ar atsiimti FLOP iki genesis, laikytinas sukčiumi.',
    source: 'crypto.news analysis, 2026-08-25 — the gap is noted, not resolved'
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
  /obtain an auth key/i,
  // Surfaced by the learning pass: the same two sentences from four different
  // DIDs, each carrying a different X link. A mass-produced template, not a
  // contribution anyone can read.
  /i published a technocore contribution/i,
  /it helps people understand technocore/i
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
/**
 * A URL's query string is not a question mark, whatever `includes('?')` thinks.
 * The learning pass caught this: four messages qualified as "questions" purely
 * because they carried `https://x.com/…?s=20`.
 */
export function stripUrls(text) {
  return String(text ?? '').replace(/https?:\/\/\S+/gi, ' ');
}

/**
 * An interrogative that opens a clause, not one that happens to appear.
 *
 * The old test matched `how|what|where|...` anywhere in the message, which is
 * the same mistake as reading a `?` inside a URL: a keyword standing in for a
 * speech act. Replayed over the 1,781 distinct messages this gate had already
 * accepted, it rejected exactly none of them — a vacuous gate whose entire
 * effect was being carried by the hourly budget downstream. Most of what it
 * waved through was other agents' status broadcasts: "I refined the evidence
 * checklist so contributors know what to save" is not a question to anyone.
 *
 * Requiring the word to open a sentence or clause keeps 52% of that same
 * population and drops the broadcasts. A real question survives it, because a
 * real question puts its interrogative at the front.
 */
export function opensAQuestion(text) {
  return /(^|[.!;:\n]\s*|,\s*)(how|what|where|why|which|who|when|can|does|is|are|do|help|kaip|kodėl|kodel|kur|kada|koks|ar|padėk|padek)\b/i
    .test(String(text ?? ''));
}

export function shouldRespond(text, { selfDid = null, minLength = 20, maxLength = 1200, seenSkeletons = null } = {}) {
  const value = typeof text === 'string' ? text.trim() : '';

  if (value.length < minLength) return { respond: false, reason: 'too_short', topics: [] };
  if (value.length > maxLength) return { respond: false, reason: 'too_long', topics: [] };
  if (isBoilerplate(value)) return { respond: false, reason: 'boilerplate', topics: [] };

  /**
   * Answer a template once, not once per instance.
   *
   * The boilerplate list catches phrases we thought of in advance. It does not
   * catch a campaign nobody has seen before, and the measured cost of that gap
   * was large: replaying this gate over 23,667 archived messages, 321 passed —
   * and only 181 of them were distinct templates. Nearly 44% of everything the
   * agent wanted to say was the same reply to the same generated sentence, one
   * of which appeared 78 times.
   *
   * "Did someone mention an upcoming airdrop snapshot?" has a question mark and
   * the word airdrop, so every earlier check waves it through. The skeleton is
   * what tells them apart, and the learning engine already computes it — it was
   * being used to rank rooms and never to decide whether to speak.
   *
   * Only messages actually replied to belong in `seenSkeletons`, never ones the
   * hourly budget merely deferred; otherwise a template gets permanently
   * blocked by a reply that never happened.
   */
  if (seenSkeletons) {
    const skeleton = messageSkeleton(value);
    if (skeleton && seenSkeletons.has(skeleton)) {
      return { respond: false, reason: 'repeated_template', topics: [] };
    }
  }

  const addressedToUs = Boolean(selfDid) && value.includes(selfDid);
  const withoutUrls = stripUrls(value);
  const isQuestion = withoutUrls.includes('?') || opensAQuestion(withoutUrls);

  if (!isQuestion && !addressedToUs) return { respond: false, reason: 'not_a_question', topics: [] };
  if (!hasStrongTerm(value) && !addressedToUs) return { respond: false, reason: 'off_topic', topics: [] };

  const topics = findRelevantKnowledge(value, { fallback: false });
  if (topics.length === 0) return { respond: false, reason: 'no_matching_facts', topics: [] };

  return { respond: true, reason: addressedToUs ? 'addressed_to_us' : 'on_topic_question', topics };
}

/**
 * One lead, not four picked at random.
 *
 * Four greetings over the same fact paragraph do not make four answers; they
 * make one answer that is hard to recognise as a repeat. The count is exact:
 * 2,062 replies the hourly budget threw away held 271 distinct strings and 97
 * distinct answers, and the whole of that difference was this rotation plus
 * the address line. Flop Labs made public sport of an agent that sent 155
 * identical replies — dressing repetition up is worse than repeating, because
 * it defeats our own duplicate check as well as the reader's eye.
 */
const GREETING_EN = 'FLOP Scout: ';
const GREETING_LT = 'FLOP Scout: ';

export function formatKnowledgeResponse(query, targetLang = null) {
  const lang = targetLang || detectLanguage(query);
  const facts = findRelevantKnowledge(query);
  const topFacts = facts.slice(0, 2);

  const greeting = lang === 'lt' ? GREETING_LT : GREETING_EN;

  const sections = topFacts.map((fact) => {
    const text = lang === 'lt' ? fact.summary_lt : fact.summary_en;
    return `[${fact.topic}] ${text}`;
  });

  return `${greeting}${sections.join(' | ')}`;
}
