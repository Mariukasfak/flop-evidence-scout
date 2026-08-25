const AGENT_META = {
  codex: { name: 'Codex', initials: 'C' },
  claude: { name: 'Claude', initials: 'Cl' },
  gemini: { name: 'Gemini', initials: 'G', defaultConductor: true }
};

const EVENT_LABELS = {
  RUN_CREATED: 'Žinutė perduota tarybai',
  AGENT_STATUS: 'Agento būsena atnaujinta',
  PROPOSAL: 'Pasiūlymas pateiktas',
  CRITIQUE: 'Tarpusavio vertinimas baigtas',
  DELEGATION: 'Sprendimas ir darbai paskirti',
  EXECUTION: 'Kodo įgyvendinimas parengtas',
  CODE_REVIEW: 'Kodo peržiūra atlikta',
  QUOTA_STATUS: 'Kvotos / limito būsena',
  SCORE: 'Vertinimas užfiksuotas',
  FINAL: 'Bendras atsakymas parengtas',
  RUN_COMPLETED: 'Atsakymas užbaigtas',
  RUN_FAILED: 'Taryba sustojo su klaida',
  ERROR: 'Užfiksuota klaida'
};

const state = {
  activeChatId: null,
  chats: [],
  currentEvents: [],
  eventSource: null,
  profiles: {},
  liveHealth: [],
  learning: { totalRuns: 0, agents: {} },
  renderedSeq: new Set(),
  terminal: true,
  finalRendered: false
};

const elements = {
  agentList: document.querySelector('#agent-list'),
  chatForm: document.querySelector('#chat-form'),
  chatList: document.querySelector('#chat-list'),
  clearLog: document.querySelector('#clear-log'),
  codeShortcutBtn: document.querySelector('#code-shortcut-btn'),
  conversationEyebrow: document.querySelector('#conversation-eyebrow'),
  conversationHeading: document.querySelector('#conversation-heading'),
  conversationSubtitle: document.querySelector('#conversation-subtitle'),
  eventLog: document.querySelector('#event-log'),
  newChatButton: document.querySelector('#new-chat-button'),
  runId: document.querySelector('#run-id'),
  runState: document.querySelector('#run-state'),
  sendButton: document.querySelector('#send-button'),
  taskInput: document.querySelector('#task-input'),
  transcript: document.querySelector('#transcript')
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setRunState(kind, label) {
  elements.runState.className = `run-state ${kind}`;
  elements.runState.lastElementChild.textContent = label;
}

function setBusy(busy) {
  state.terminal = !busy;
  elements.sendButton.disabled = busy;
  elements.taskInput.disabled = busy;
  elements.newChatButton.disabled = busy;
  elements.sendButton.querySelector('span').textContent = busy ? 'Taryba tariasi…' : 'Siųsti';
  elements.chatList.classList.toggle('locked', busy);
}

function updateLocation(chatId) {
  const target = chatId ? `#chat=${encodeURIComponent(chatId)}` : window.location.pathname;
  history.replaceState(null, '', target);
}

function chatIdFromLocation() {
  const match = window.location.hash.match(/^#chat=([a-zA-Z0-9_-]+)$/);
  return match?.[1] ?? null;
}

function renderAgentCards() {
  elements.agentList.replaceChildren();
  for (const id of ['codex', 'claude', 'gemini']) {
    const profile = state.profiles[id] ?? { role: 'Agentas', localPrior: 0.5 };
    const learning = state.learning.agents?.[id] ?? { runs: 0, localPrior: profile.localPrior ?? 0.5 };
    const health = state.liveHealth.find((item) => item.id === id) ?? {};
    const quota = health.quota ?? {};
    const warning = quota.status === 'auth_required' || quota.status === 'quota_warning';
    const available = Boolean(health.councilAvailable);
    const statusText = warning
      ? quota.label ?? 'Limitas / auth'
      : available
        ? health.authStatus === 'verified' || health.authStatus === 'local-session-connected'
          ? 'Live taryba patikrinta'
          : 'CLI rastas · auth netikrinta'
        : health.reason ?? 'Nepasiekiamas';

    const card = element('article', `agent-card ${id} ${warning ? 'warning' : available ? 'available' : 'unavailable'}`);
    card.append(element('div', 'agent-avatar', AGENT_META[id].initials));
    const main = element('div', 'agent-main');
    const title = element('div', 'agent-title-row');
    const name = element('div', 'agent-name-row');
    name.append(element('strong', '', AGENT_META[id].name));
    if (profile.defaultConductor) name.append(element('span', 'conductor-chip', 'Numatytasis dirigentas'));
    title.append(name, element('span', 'prior-chip', `${learning.runs} run · ${learning.localPrior.toFixed(2)}`));
    const status = element('div', 'agent-status');
    status.append(element('span', `status-dot ${warning ? 'warning-dot' : ''}`), element('span', '', statusText));
    if (quota.actionHint) status.title = quota.actionHint;
    main.append(title, status);
    card.append(main);
    elements.agentList.append(card);
  }
}

async function loadProviders() {
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) throw new Error('Agentų būsenos gauti nepavyko');
    const payload = await response.json();
    state.profiles = payload.profiles;
    state.liveHealth = payload.live;
    state.learning = payload.learning;
    renderAgentCards();
  } catch (error) {
    elements.agentList.replaceChildren(element('p', 'agent-role', error.message));
  }
}

function formatChatTime(value) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('lt-LT', { month: 'short', day: 'numeric' });
}

function messageCountLabel(count) {
  if (count === 1) return '1 žinutė';
  if (count % 10 >= 2 && count % 10 <= 9 && (count % 100 < 10 || count % 100 >= 20)) {
    return `${count} žinutės`;
  }
  return `${count} žinučių`;
}

function renderChatList() {
  elements.chatList.replaceChildren();
  if (!state.chats.length) {
    const empty = element('div', 'chat-list-empty');
    empty.append(element('strong', '', 'Dar nėra pokalbių'), element('p', '', 'Pirmoji žinutė sukurs atskirą temos kortelę.'));
    elements.chatList.append(empty);
    return;
  }

  for (const chat of state.chats) {
    const button = element('button', `chat-card ${chat.chatId === state.activeChatId ? 'active' : ''}`);
    button.type = 'button';
    button.dataset.chatId = chat.chatId;
    const top = element('span', 'chat-card-top');
    top.append(element('strong', '', chat.title), element('time', '', formatChatTime(chat.updatedAt)));
    const count = messageCountLabel(chat.messageCount);
    button.append(top, element('span', 'chat-card-meta', count));
    button.addEventListener('click', () => {
      if (state.terminal) void selectChat(chat.chatId);
    });
    elements.chatList.append(button);
  }
}

function renderEmptyState() {
  elements.transcript.replaceChildren();
  const empty = element('div', 'empty-state');
  empty.id = 'empty-state';
  const orbit = element('div', 'council-orbit');
  orbit.setAttribute('aria-hidden', 'true');
  orbit.innerHTML = '<span class="orbit-core">T</span><span class="orbit-agent orbit-codex">C</span><span class="orbit-agent orbit-claude">Cl</span><span class="orbit-agent orbit-gemini">G</span>';
  empty.append(
    orbit,
    element('h2', '', 'Pradėkite atskirą darbo temą'),
    element('p', '', 'Rašykite kaip įprastame pokalbyje. Visi trys agentai matys tik šio pokalbio istoriją, pasitars ir pateiks vieną bendrą atsakymą.')
  );
  const suggestions = element('div', 'suggestion-list');
  suggestions.setAttribute('aria-label', 'Užduočių pavyzdžiai');
  const examples = [
    ['/code Sukurk modernų paslaugų puslapį su testais.', '/code Kurti puslapį'],
    ['Peržiūrėk mano projekto architektūrą ir pasiūlyk kitą žingsnį.', 'Architektūros peržiūra'],
    ['Sudaryk šios savaitės darbų planą ir prioritetus.', 'Savaitės planas']
  ];
  for (const [prompt, label] of examples) {
    const button = element('button', '', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      elements.taskInput.value = prompt;
      elements.taskInput.focus();
    });
    suggestions.append(button);
  }
  empty.append(suggestions);
  elements.transcript.append(empty);
}

function createMessageShell(role, createdAt) {
  const isUser = role === 'user';
  const card = element('article', `message-card ${isUser ? 'user-message' : 'decision-card assistant-message'}`);
  const head = element('div', 'message-head');
  const actor = element('div', 'message-actor');
  actor.append(
    element('div', 'mini-avatar', isUser ? 'Jūs' : 'T'),
    element('strong', '', isUser ? 'Jūs' : 'TriAgent')
  );
  const label = createdAt
    ? new Date(createdAt).toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })
    : isUser ? 'Jūsų žinutė' : 'Bendras atsakymas';
  head.append(actor, element('span', 'message-label', label));
  const body = element('div', 'message-body');
  card.append(head, body);
  return { card, body };
}

function appendTextList(parent, title, items) {
  if (!Array.isArray(items) || !items.length) return;
  parent.append(element('h3', 'section-title', title));
  const list = element('ul');
  items.forEach((item) => list.append(element('li', '', item)));
  parent.append(list);
}

function renderCouncilDetails(payload = {}) {
  const details = element('details', 'council-details');
  const summary = element('summary');
  const summaryText = element('span', 'council-summary-text');
  summaryText.append(element('strong', '', 'Tarybos svarstymas'), element('small', '', 'Pasiūlymai, kritika ir darbų paskirstymas'));
  summary.append(summaryText, element('span', 'details-arrow', '⌄'));
  details.append(summary);
  const content = element('div', 'council-details-body');

  if (payload.failed) {
    content.append(element('p', 'degraded-note', payload.error ?? 'Tarybos paleidimas nepavyko.'));
    details.append(content);
    return details;
  }

  const decision = element('section', 'audit-section decision-audit');
  decision.append(element('h3', '', 'Priimtas sprendimas'));
  const owner = AGENT_META[payload.owner]?.name ?? payload.owner ?? 'nepaskirtas';
  const reviewer = AGENT_META[payload.reviewer]?.name ?? payload.reviewer ?? 'nepaskirtas';
  decision.append(element('p', '', `Atsakingas: ${owner}. Tikrintojas: ${reviewer}.`));
  if (payload.reason) decision.append(element('p', 'audit-muted', payload.reason));
  if (Array.isArray(payload.ranking) && payload.ranking.length) {
    const ranking = element('div', 'ranking-row');
    payload.ranking.forEach((rank, index) => {
      const id = String(rank.id ?? '').replace('-proposal', '');
      const score = Number.isFinite(rank.average) ? ` · ${rank.average.toFixed(2)}` : '';
      ranking.append(element('span', 'rank-chip', `${index + 1}. ${AGENT_META[id]?.name ?? id}${score}`));
    });
    decision.append(ranking);
  }
  content.append(decision);

  if (Array.isArray(payload.proposals) && payload.proposals.length) {
    const section = element('section', 'audit-section');
    section.append(element('h3', '', 'Agentų pasiūlymai'));
    for (const proposal of payload.proposals) {
      const proposalContent = proposal.content ?? proposal;
      const item = element('article', `audit-agent ${proposal.agentId ?? ''}`);
      item.append(
        element('strong', '', AGENT_META[proposal.agentId]?.name ?? proposal.agentId ?? 'Agentas'),
        element('p', '', proposalContent.summary ?? 'Pasiūlymas užfiksuotas.')
      );
      section.append(item);
    }
    content.append(section);
  }

  if (Array.isArray(payload.critiques) && payload.critiques.length) {
    const section = element('section', 'audit-section');
    section.append(element('h3', '', 'Kryžminė kritika'));
    for (const critique of payload.critiques) {
      const reviews = Array.isArray(critique.reviews) ? critique.reviews : [];
      const item = element('article', 'audit-agent');
      item.append(element('strong', '', AGENT_META[critique.agentId]?.name ?? critique.agentId));
      reviews.forEach((review) => item.append(element('p', 'audit-muted', review.verdict ?? 'Įvertinta.')));
      section.append(item);
    }
    content.append(section);
  }

  if (Array.isArray(payload.assignments) && payload.assignments.length) {
    const section = element('section', 'audit-section');
    section.append(element('h3', '', 'Darbų paskirstymas'));
    const assignments = element('ul', 'assignment-list');
    payload.assignments.forEach((assignment) => assignments.append(element(
      'li', '', `${AGENT_META[assignment.agentId]?.name ?? assignment.agentId}: ${assignment.task} Patikra: ${assignment.verify}`
    )));
    section.append(assignments);
    content.append(section);
  }

  if (Array.isArray(payload.dissent) && payload.dissent.length) {
    appendTextList(content, 'Likusi mažumos nuomonė', payload.dissent);
  }
  if (payload.execution?.summary) {
    const section = element('section', 'audit-section');
    section.append(element('h3', '', 'Įgyvendinimas'), element('p', '', payload.execution.summary));
    content.append(section);
  }
  if (payload.codeReview?.verdict) {
    const section = element('section', 'audit-section');
    section.append(element('h3', '', 'Nepriklausoma kodo peržiūra'), element('p', '', payload.codeReview.verdict));
    content.append(section);
  }
  if (payload.degraded) {
    content.append(element('p', 'degraded-note', `Dalinė taryba: ${(payload.degradedReasons ?? []).join(', ')}.`));
  }
  const meta = element('p', 'council-meta');
  const decisionSource = payload.decisionSource ?? 'nežinomas';
  const runs = payload.learning?.newEvidence ? ' · mokymosi įrodymas išsaugotas' : '';
  meta.textContent = `Sprendimo šaltinis: ${decisionSource}${runs}`;
  content.append(meta);
  details.append(content);
  return details;
}

function renderMessage(message) {
  const { card, body } = createMessageShell(message.role, message.createdAt);
  body.append(element('p', 'message-text', message.content));
  if (message.role === 'assistant') {
    if (Array.isArray(message.council?.approach)) appendTextList(body, 'Siūlomas kelias', message.council.approach);
    body.append(renderCouncilDetails(message.council ?? {}));
  }
  return card;
}

function renderChat(chat) {
  elements.conversationEyebrow.textContent = 'Atskiras temos kontekstas';
  elements.conversationHeading.textContent = chat.title;
  elements.conversationSubtitle.textContent = `${messageCountLabel(chat.messages.length)} · ši istorija perduodama tik šio pokalbio agentams`;
  elements.transcript.replaceChildren();
  if (!chat.messages.length) {
    renderEmptyState();
    return;
  }
  const stack = element('div', 'message-stack');
  chat.messages.forEach((message) => stack.append(renderMessage(message)));
  elements.transcript.append(stack);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

async function selectChat(chatId) {
  try {
    const response = await fetch(`/api/chats/${chatId}`);
    const chat = await response.json();
    if (!response.ok) throw new Error(chat.error ?? 'Pokalbio atverti nepavyko');
    state.activeChatId = chatId;
    updateLocation(chatId);
    renderChat(chat);
    renderChatList();
    elements.taskInput.focus();
  } catch (error) {
    setRunState('failed', error.message);
  }
}

async function loadChats({ selectInitial = false } = {}) {
  const response = await fetch('/api/chats');
  if (!response.ok) throw new Error('Pokalbių sąrašo gauti nepavyko');
  const payload = await response.json();
  state.chats = payload.chats;
  renderChatList();
  if (selectInitial) {
    const requested = chatIdFromLocation();
    const target = state.chats.find((chat) => chat.chatId === requested)?.chatId ?? state.chats[0]?.chatId;
    if (target) await selectChat(target);
    else startNewChat();
  }
}

function startNewChat() {
  if (!state.terminal) return;
  state.activeChatId = null;
  updateLocation(null);
  renderChatList();
  elements.conversationEyebrow.textContent = 'Nauja tema';
  elements.conversationHeading.textContent = 'Naujas pokalbis';
  elements.conversationSubtitle.textContent = 'Šio lango kontekstas nepersimaišys su kitais pokalbiais.';
  setRunState('idle', 'Pasiruošęs');
  elements.runId.textContent = '—';
  renderEmptyState();
  elements.taskInput.focus();
}

function appendLog(event) {
  if (elements.eventLog.querySelector('.log-placeholder')) elements.eventLog.replaceChildren();
  const item = element('li');
  item.append(element('span', 'log-seq', String(event.seq).padStart(2, '0')));
  const content = element('div');
  content.append(element('p', '', EVENT_LABELS[event.type] ?? event.type));
  const meta = element('div', 'log-meta');
  meta.append(
    element('span', '', event.agentId ? AGENT_META[event.agentId]?.name ?? event.agentId : 'TriAgent'),
    element('span', '', new Date(event.timestamp).toLocaleTimeString('lt-LT'))
  );
  content.append(meta);
  item.append(content);
  elements.eventLog.append(item);
  elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
}

function auditFromCurrentRun(payload) {
  return {
    ...payload,
    proposals: state.currentEvents
      .filter((event) => event.type === 'PROPOSAL')
      .map((event) => ({ agentId: event.agentId, ...event.payload })),
    critiques: state.currentEvents
      .filter((event) => event.type === 'CRITIQUE')
      .map((event) => ({ agentId: event.agentId, reviews: event.payload.reviews }))
  };
}

function handleEvent(event) {
  if (state.renderedSeq.has(event.seq)) return;
  state.renderedSeq.add(event.seq);
  state.currentEvents.push(event);
  appendLog(event);

  if (event.type === 'AGENT_STATUS' && event.payload?.status === 'running') {
    const phase = event.payload.phase;
    const labels = { proposal: 'Agentai siūlo', critique: 'Agentai vertina', delegation: 'Gemini moderuoja', execution: 'Rašomas kodas', codeReview: 'Tikrinamas kodas' };
    setRunState('running', labels[phase] ?? 'Taryba tariasi');
  }

  if (event.type === 'QUOTA_STATUS') {
    const existing = state.liveHealth.find((health) => health.id === event.agentId);
    if (existing) {
      existing.quota = event.payload;
      renderAgentCards();
    }
  }

  if (event.type === 'FINAL' && !state.finalRendered) {
    state.finalRendered = true;
    document.querySelector('#waiting-card')?.remove();
    const message = {
      role: 'assistant',
      content: event.payload.answer,
      createdAt: event.timestamp,
      council: auditFromCurrentRun(event.payload)
    };
    document.querySelector('#message-stack')?.append(renderMessage(message));
  }

  if (event.type === 'RUN_COMPLETED' || event.type === 'RUN_FAILED') {
    state.eventSource?.close();
    setBusy(false);
    setRunState(
      event.type === 'RUN_COMPLETED' ? 'complete' : 'failed',
      event.type === 'RUN_COMPLETED' ? (event.payload?.degraded ? 'Užbaigta · dalinė taryba' : 'Užbaigta') : 'Nepavyko'
    );
    const refreshChat = () => Promise.all([
      state.activeChatId ? selectChat(state.activeChatId) : Promise.resolve(),
      loadChats(),
      loadProviders()
    ]);
    if (event.type === 'RUN_FAILED') {
      window.setTimeout(() => void refreshChat(), 120);
    } else {
      void refreshChat();
    }
  }
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

async function replayEvents(runId) {
  const response = await fetch(`/api/runs/${runId}/events`);
  if (!response.ok) return;
  const payload = await response.json();
  payload.events.forEach(handleEvent);
}

function connectEventStream(runId) {
  const source = new EventSource(`/api/runs/${runId}/stream`);
  state.eventSource = source;
  source.addEventListener('triagent', (message) => handleEvent(JSON.parse(message.data)));
  source.onerror = async () => {
    source.close();
    await replayEvents(runId);
    if (!state.terminal) {
      setBusy(false);
      setRunState('failed', 'Ryšys nutrūko');
    }
  };
}

function prepareLiveTurn(prompt) {
  state.renderedSeq.clear();
  state.currentEvents = [];
  state.finalRendered = false;
  state.eventSource?.close();
  elements.eventLog.replaceChildren();
  const stack = document.querySelector('#message-stack') ?? element('div', 'message-stack');
  stack.id = 'message-stack';
  if (!stack.isConnected) {
    elements.transcript.replaceChildren(stack);
  }
  stack.append(renderMessage({ role: 'user', content: prompt, createdAt: new Date().toISOString() }));
  const waiting = element('article', 'message-card waiting-card');
  waiting.id = 'waiting-card';
  const dots = element('span', 'thinking-dots');
  dots.append(element('span'), element('span'), element('span'));
  waiting.append(dots, element('span', '', 'Codex, Claude ir Gemini tariasi…'));
  stack.append(waiting);
  elements.transcript.scrollTop = elements.transcript.scrollHeight;
}

async function ensureChat() {
  if (state.activeChatId) return state.activeChatId;
  const response = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  const chat = await response.json();
  if (!response.ok) throw new Error(chat.error ?? 'Pokalbio sukurti nepavyko');
  state.activeChatId = chat.chatId;
  state.chats.unshift(chat);
  updateLocation(chat.chatId);
  renderChatList();
  return chat.chatId;
}

async function startMessage(prompt) {
  try {
    const chatId = await ensureChat();
    prepareLiveTurn(prompt);
    setBusy(true);
    setRunState('running', 'Taryba tariasi');
    elements.runId.textContent = 'kuriamas…';

    const response = await fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? 'Žinutės perduoti nepavyko');
    elements.runId.textContent = payload.runId;
    elements.taskInput.value = '';
    void loadChats();
    connectEventStream(payload.runId);
  } catch (error) {
    document.querySelector('#waiting-card')?.remove();
    setBusy(false);
    setRunState('failed', 'Nepavyko paleisti');
    const stack = document.querySelector('#message-stack');
    stack?.append(renderMessage({
      role: 'assistant',
      content: `TriAgent užduoties paleisti nepavyko: ${error.message}`,
      council: { failed: true, error: error.message }
    }));
  }
}

elements.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = elements.taskInput.value.trim();
  if (prompt) void startMessage(prompt);
});

elements.taskInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    elements.chatForm.requestSubmit();
  }
});

elements.codeShortcutBtn.addEventListener('click', () => {
  if (!elements.taskInput.value.startsWith('/code')) {
    elements.taskInput.value = `/code ${elements.taskInput.value}`.trimStart();
  }
  elements.taskInput.focus();
});

elements.newChatButton.addEventListener('click', startNewChat);
elements.clearLog.addEventListener('click', () => elements.eventLog.replaceChildren());

await Promise.all([loadProviders(), loadChats({ selectInitial: true })]);
