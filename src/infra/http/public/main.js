const API_BASE = window.location.origin + '/v1';

/**
 * O gateway só exige token quando GATEWAY_TOKEN está definido no servidor. Guardar em
 * localStorage é suficiente para uso local; não é credencial de usuário.
 */
function authHeaders(extra = {}) {
  const token = localStorage.getItem('gatewayToken');
  return token ? { ...extra, Authorization: 'Bearer ' + token } : extra;
}

const MODE_HINTS = {
  chat: 'SDK normal do provider. Conversa, anexos e reasoning — sem tools.',
  agent: 'Agents SDK oficial. O loop de tools é do SDK, não do gateway.',
};

// State
let currentAgentId = 'researcher-agent';
let currentMode = 'chat';
let currentSessionId = null;
let isGenerating = false;
let inFlight = null;

let agentsData = [];
let pendingFiles = [];

// DOM
const form = document.getElementById('chat-form');
const input = document.getElementById('message-input');
const messagesContainer = document.getElementById('chat-messages');
const providerButtons = document.querySelectorAll('#provider-selector button');
const modeButtons = document.querySelectorAll('#mode-selector .mode-btn');
const modeHint = document.getElementById('mode-hint');
const currentAgentName = document.getElementById('current-agent-name');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const filePreviewContainer = document.getElementById('file-preview-container');
const stopBtn = document.getElementById('stop-btn');
const submitBtn = form.querySelector('button[type="submit"]');

// --- Rendering -------------------------------------------------------------

// Tudo que vem do servidor passa por aqui antes de virar HTML. O escape acontece
// primeiro e só depois a marcação é aplicada, então nenhum texto do modelo ou nome de
// tool consegue injetar markup.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  const fences = [];
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    fences.push('<pre><code data-lang="' + lang + '">' + code.replace(/\n$/, '') + '</code></pre>');
    // Marcador improvável no texto original: um número solto colidiria com "tenho 3 itens".
    return '[[fence:' + (fences.length - 1) + ']]';
  });

  html = html
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');

  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<\/li><br>/g, '</li>');
  html = html.replace(/\[\[fence:(\d+)\]\]/g, (_match, index) => fences[Number(index)]);

  return html;
}

function addMessage(role, content, id) {
  const div = document.createElement('div');
  div.className = 'flex flex-col max-w-[85%] chat-bubble ' + (role === 'user' ? 'ml-auto items-end' : '');
  if (id) div.id = id;

  const innerClass =
    role === 'user'
      ? 'bg-zinc-700 text-zinc-50 p-4 rounded-2xl rounded-tr-sm shadow-md'
      : role === 'system'
        ? 'bg-zinc-900/80 text-zinc-400 p-4 rounded-2xl border border-zinc-800/60 text-sm italic'
        : 'bg-zinc-900 border border-zinc-800 p-4 rounded-2xl rounded-tl-sm text-zinc-200 shadow-sm backdrop-blur-sm md';

  const tools = document.createElement('div');
  tools.className = 'tools-container flex flex-col gap-1 mb-1 empty:hidden';

  const box = document.createElement('div');
  box.className = innerClass + ' content-box';
  box.style.whiteSpace = 'pre-wrap';
  if (role === 'agent' && content instanceof Node) {
    box.appendChild(content);
  } else if (role === 'agent') {
    box.innerHTML = renderMarkdown(content);
  } else {
    box.textContent = content;
  }

  const label = document.createElement('span');
  label.className = role === 'user' ? 'text-xs text-zinc-500 mt-2 mr-1' : 'text-xs text-zinc-500 mt-2 ml-1';
  label.textContent = role === 'user' ? 'You' : role === 'system' ? 'System' : 'Agent · ' + currentMode;

  div.append(tools, box, label);
  messagesContainer.appendChild(div);
  scrollToBottom();
  return div;
}

function scrollToBottom() {
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function badge(el, className, iconSvg, textNodes) {
  el.className = className;
  el.innerHTML = iconSvg;
  const span = document.createElement('span');
  textNodes.forEach((node) => span.appendChild(node));
  el.appendChild(span);
}

function strongText(value) {
  const b = document.createElement('b');
  b.textContent = value;
  return b;
}

const SPINNER =
  '<svg class="animate-spin h-3 w-3 text-zinc-300" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
const CHECK =
  '<svg class="h-3 w-3 text-emerald-500" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
const CROSS =
  '<svg class="h-3 w-3 text-red-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const BADGE_RUNNING =
  'text-xs text-zinc-400 bg-zinc-900/80 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-zinc-800/60 w-fit';
const BADGE_DONE =
  'text-xs text-zinc-500 bg-zinc-900/40 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-zinc-800/40 w-fit';
const BADGE_ERROR =
  'text-xs text-red-300 bg-red-950/40 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-red-900/40 w-fit';
const BADGE_NOTE =
  'text-xs text-amber-300/80 bg-amber-950/20 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-amber-900/30 w-fit';

// --- Agents & lanes --------------------------------------------------------

async function loadAgents() {
  try {
    const res = await fetch(API_BASE + '/agents', { headers: authHeaders() });
    const data = await res.json();
    if (data.ok) {
      agentsData = data.result;
      updateModelSelector();
      updateModeSelector();
    }
  } catch (err) {
    console.error('Failed to load agents', err);
  }
}

function currentAgent() {
  return agentsData.find((a) => a.id === currentAgentId);
}

function updateModelSelector() {
  const modelSelect = document.getElementById('model-selector');
  const reasoningSelect = document.getElementById('reasoning-selector');
  const agent = currentAgent();
  if (!modelSelect || !reasoningSelect || !agent) return;

  const options = (values, empty) =>
    !values || values.length === 0
      ? '<option value="">' + empty + '</option>'
      : values.map((v) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join('');

  modelSelect.innerHTML = options(agent.models, 'Nenhum modelo disponível');
  reasoningSelect.innerHTML = options(agent.reasoningEfforts, 'Nenhum');
}

function updateModeSelector() {
  const supported = currentAgent()?.modes ?? ['chat', 'agent'];
  if (!supported.includes(currentMode)) currentMode = supported[0];

  modeButtons.forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.classList.toggle('is-active', mode === currentMode);
    btn.disabled = !supported.includes(mode);
    btn.classList.toggle('opacity-40', !supported.includes(mode));
  });

  if (modeHint) modeHint.textContent = MODE_HINTS[currentMode] ?? '';
}

function resetConversation(note) {
  // Sem isto a sessão anterior ficava viva no gateway até o TTL, segurando o history do
  // provider e, na lane agent, o runtime da SDK.
  if (currentSessionId) {
    const orphan = currentSessionId;
    fetch(API_BASE + '/sessions/' + orphan, { method: 'DELETE', headers: authHeaders() }).catch(() => undefined);
  }

  currentSessionId = null;
  Array.from(messagesContainer.children).forEach((child) => {
    if (child.id !== 'welcome-section') child.remove();
  });

  const welcome = document.getElementById('welcome-section');
  if (welcome) welcome.style.display = 'flex';

  renderPrompts();
  if (note) addMessage('system', note);
}

providerButtons.forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const target = e.currentTarget;
    currentAgentId = target.dataset.provider;

    providerButtons.forEach((b) => {
      b.className =
        'w-full text-left px-4 py-3 rounded-xl transition-all duration-200 border border-transparent hover:bg-zinc-800/50 text-zinc-400 hover:text-zinc-300';
    });
    target.className =
      'w-full text-left px-4 py-3 rounded-xl transition-all duration-200 border bg-zinc-800 text-zinc-200 border-zinc-600/50';

    currentAgentName.textContent = target.textContent.trim() || currentAgentId;
    updateModelSelector();
    updateModeSelector();
    resetConversation('Switched to ' + target.textContent.trim() + ' on the "' + currentMode + '" lane. New session started.');
  });
});

modeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled || btn.dataset.mode === currentMode) return;
    currentMode = btn.dataset.mode;
    updateModeSelector();
    // A sessão pertence a uma lane: trocar de lane começa outra.
    resetConversation('Lane "' + currentMode + '": ' + MODE_HINTS[currentMode] + ' New session started.');
  });
});

// --- Attachments -----------------------------------------------------------

attachBtn?.addEventListener('click', () => fileInput.click());

fileInput?.addEventListener('change', (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target.result;
      pendingFiles.push({ name: file.name, mimeType: file.type, data: result.split(',')[1], previewUrl: result });
      renderFilePreviews();
    };
    reader.readAsDataURL(file);
  }
  fileInput.value = '';
});

function renderFilePreviews() {
  if (pendingFiles.length === 0) {
    filePreviewContainer.classList.add('hidden');
    filePreviewContainer.replaceChildren();
    return;
  }

  filePreviewContainer.classList.remove('hidden');
  filePreviewContainer.replaceChildren(
    ...pendingFiles.map((f, i) => {
      const chip = document.createElement('div');
      chip.className =
        'relative bg-zinc-900 rounded flex items-center p-1 px-2 gap-2 text-xs border border-zinc-800 w-max shrink-0';

      if (f.mimeType.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = f.previewUrl;
        img.className = 'h-6 w-6 object-cover rounded-sm';
        chip.appendChild(img);
      } else {
        chip.appendChild(document.createTextNode('PDF'));
      }

      const name = document.createElement('span');
      name.className = 'truncate max-w-[100px]';
      name.textContent = f.name;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-zinc-400 hover:text-red-400 ml-1';
      remove.textContent = 'x';
      remove.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderFilePreviews();
      });

      chip.append(name, remove);
      return chip;
    }),
  );
}

// --- Session ---------------------------------------------------------------

async function ensureSession() {
  if (currentSessionId) return currentSessionId;

  const res = await fetch(API_BASE + '/sessions', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      agentId: currentAgentId,
      mode: currentMode,
      model: document.getElementById('model-selector')?.value || undefined,
      reasoning: document.getElementById('reasoning-selector')?.value || undefined,
      language: document.getElementById('language-selector')?.value,
    }),
  });

  const data = await res.json().catch(() => ({ ok: false, message: 'HTTP ' + res.status }));
  if (!data.ok) throw new Error(data.message || 'Failed to create session');

  currentSessionId = data.result.id;
  return currentSessionId;
}

function setGenerating(value) {
  isGenerating = value;
  stopBtn?.classList.toggle('hidden', !value);
  stopBtn?.classList.toggle('flex', value);
  submitBtn?.classList.toggle('hidden', value);
}

stopBtn?.addEventListener('click', async () => {
  if (!currentSessionId) return;
  // Aborta o fetch e avisa o gateway, que por sua vez aborta o stream no provider.
  inFlight?.abort();
  await fetch(API_BASE + '/sessions/' + currentSessionId + '/cancel', {
    method: 'POST',
    headers: authHeaders(),
  }).catch(() => undefined);
});

// --- Turn ------------------------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if ((!text && pendingFiles.length === 0) || isGenerating) return;

  const welcome = document.getElementById('welcome-section');
  if (welcome) welcome.style.display = 'none';

  input.value = '';
  const filesToSend = pendingFiles.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
  pendingFiles = [];
  renderFilePreviews();

  addMessage('user', text + (filesToSend.length > 0 ? '\n[' + filesToSend.length + ' anexo(s)]' : ''));
  setGenerating(true);

  const loading = document.createElement('div');
  loading.className = 'flex space-x-1.5 h-6 items-center px-1 opacity-70';
  loading.innerHTML =
    '<div class="w-2 h-2 bg-zinc-300 rounded-full animate-bounce" style="animation-delay:-0.3s"></div><div class="w-2 h-2 bg-zinc-300 rounded-full animate-bounce" style="animation-delay:-0.15s"></div><div class="w-2 h-2 bg-zinc-300 rounded-full animate-bounce"></div>';

  const bubble = addMessage('agent', loading);
  const box = bubble.querySelector('.content-box');
  const tools = bubble.querySelector('.tools-container');

  let answer = '';
  let reasoning = '';
  let activeTool = null;

  try {
    const sessionId = await ensureSession();
    inFlight = new AbortController();

    const res = await fetch(API_BASE + '/sessions/' + sessionId + '/messages', {
      method: 'POST',
      // O gateway escolhe entre SSE e JSON pelo Accept; aqui queremos os eventos.
      headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify({ message: text, files: filesToSend }),
      signal: inFlight.signal,
    });

    if (!res.body) throw new Error('No response body');

    for await (const event of readSse(res.body)) {
      switch (event.type) {
        case 'text.delta':
          answer += event.payload.text;
          box.innerHTML = renderMarkdown(answer);
          scrollToBottom();
          break;

        case 'reasoning.delta':
          reasoning += event.payload.text;
          renderReasoning(tools, reasoning);
          break;

        case 'tool.started':
          activeTool = document.createElement('div');
          badge(activeTool, BADGE_RUNNING, SPINNER, [
            document.createTextNode('Using '),
            strongText(event.payload.tool),
            document.createTextNode('...'),
          ]);
          tools.appendChild(activeTool);
          scrollToBottom();
          break;

        case 'tool.result':
          if (activeTool) {
            badge(activeTool, BADGE_DONE, CHECK, [
              strongText(event.payload.tool),
              document.createTextNode(' completed'),
            ]);
          }
          break;

        case 'tool.error':
          if (activeTool) {
            badge(activeTool, BADGE_ERROR, CROSS, [
              strongText(event.payload.tool),
              document.createTextNode(': ' + event.payload.message),
            ]);
          }
          break;

        case 'usage':
          renderUsage(bubble, event.payload);
          break;

        case 'warning':
          appendNote(tools, 'Aviso: ' + event.payload.message);
          break;

        case 'message.aborted':
          appendNote(tools, 'Stopped.');
          break;

        case 'error':
          addMessage('system', 'Error: ' + (event.payload?.message ?? 'unknown error'));
          break;
      }
    }

    if (!answer && box.firstChild === loading) box.textContent = '';
  } catch (err) {
    if (err.name !== 'AbortError') addMessage('system', 'Error: ' + err.message);
  } finally {
    inFlight = null;
    setGenerating(false);
  }
});

/** Reconstrói os frames SSE a partir do buffer: um chunk pode cortar uma linha ao meio. */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch (err) {
          console.error('SSE parse error', err, line);
        }
      }
    }
  }
}

function renderReasoning(tools, text) {
  let block = tools.querySelector('.reasoning-block');
  if (!block) {
    block = document.createElement('details');
    block.className =
      'reasoning-block text-xs text-zinc-500 bg-zinc-900/40 px-3 py-1.5 rounded-lg border border-zinc-800/40 w-fit max-w-full';
    const summary = document.createElement('summary');
    summary.className = 'cursor-pointer select-none';
    summary.textContent = 'Reasoning';
    const body = document.createElement('div');
    body.className = 'reasoning-body mt-1 whitespace-pre-wrap text-zinc-400';
    block.append(summary, body);
    tools.prepend(block);
  }
  block.querySelector('.reasoning-body').textContent = text;
}

function renderUsage(bubble, usage) {
  const parts = [];
  if (usage.inputTokens != null) parts.push('in ' + usage.inputTokens);
  if (usage.outputTokens != null) parts.push('out ' + usage.outputTokens);
  if (usage.reasoningTokens != null) parts.push('reasoning ' + usage.reasoningTokens);
  if (parts.length === 0) return;

  let el = bubble.querySelector('.usage-line');
  if (!el) {
    el = document.createElement('span');
    el.className = 'usage-line text-[11px] text-zinc-600 mt-1 ml-1';
    bubble.appendChild(el);
  }
  el.textContent = 'tokens - ' + parts.join(' - ');
}

function appendNote(tools, message) {
  const note = document.createElement('div');
  note.className = BADGE_NOTE;
  note.textContent = message;
  tools.appendChild(note);
  scrollToBottom();
}

// Dynamic Prompts Config
function getPromptsConfig(lang) {
  if (lang === 'Portuguese') {
    return {
      'researcher-agent': [
        { title: 'Notícias do Dia', icon: '📰', desc: 'Pesquisar manchetes do Brasil', prompt: 'Me resuma as principais notícias do Brasil hoje.' },
        { title: 'Mercado Financeiro', icon: '📈', desc: 'Verificar cotações na B3', prompt: 'Qual a cotação atual das ações da Petrobras (PETR4) e Vale (VALE3)?' },
        { title: 'Inovação em IA', icon: '🤖', desc: 'Avanços recentes da semana', prompt: 'Procure sobre os últimos avanços em Inteligência Artificial nesta semana.' },
        { title: 'História', icon: '🏛️', desc: 'Descobrir fatos históricos', prompt: 'Me conte um resumo sobre como foi a Revolução Industrial.' },
      ],
      'sysops-agent': [
        { title: 'Listar Arquivos', icon: '📂', desc: 'Ver arquivos do diretório', prompt: 'Use o comando ls para listar os arquivos do diretório atual.' },
        { title: 'Compactar Pasta', icon: '🗜️', desc: 'Criar um arquivo zip', prompt: 'Qual comando bash cria um arquivo zip desta pasta?' },
        { title: 'Verificar Memória', icon: '🧠', desc: 'Ver uso de recursos', prompt: 'Execute o comando para ver o uso de memória e disco na minha máquina.' },
        { title: 'Processos', icon: '⚙️', desc: 'Monitorar a CPU', prompt: 'Me mostre os 5 processos que mais estão consumindo CPU agora.' },
      ],
      'analyst-agent': [
        { title: 'Análise de Ações', icon: '📊', desc: 'Análise de mercado', prompt: 'Busque a cotação atual do Dólar e me explique o impacto na inflação.' },
        { title: 'Tendências Tech', icon: '💻', desc: 'Pesquisa de tecnologia', prompt: 'Quais as linguagens de programação mais populares deste ano?' },
        { title: 'Dados Macro', icon: '🌍', desc: 'PIB e Juros', prompt: 'Pesquise qual é a taxa Selic atual e como isso afeta os investimentos.' },
        { title: 'Criptomoedas', icon: '₿', desc: 'Valores do Bitcoin', prompt: 'Qual o valor do Bitcoin hoje em dólares e as previsões da semana?' },
      ]
    };
  } else {
    return {
      'researcher-agent': [
        { title: 'Daily News', icon: '📰', desc: 'Search US headlines', prompt: 'Summarize the top US news for today.' },
        { title: 'Stock Market', icon: '📈', desc: 'Check NYSE/NASDAQ', prompt: 'What is the current stock price of Apple (AAPL) and Tesla (TSLA)?' },
        { title: 'AI Innovation', icon: '🤖', desc: 'Recent AI breakthroughs', prompt: 'Search for the latest breakthroughs in Artificial Intelligence this week.' },
        { title: 'History', icon: '🏛️', desc: 'Discover history facts', prompt: 'Give me a summary of the Industrial Revolution.' },
      ],
      'sysops-agent': [
        { title: 'List Files', icon: '📂', desc: 'View current directory', prompt: 'Use the ls command to list the files in the current directory.' },
        { title: 'Zip Folder', icon: '🗜️', desc: 'Create a zip archive', prompt: 'What bash command creates a zip archive of this folder?' },
        { title: 'Check Memory', icon: '🧠', desc: 'View resource usage', prompt: 'Run the command to see memory and disk usage on my machine.' },
        { title: 'Top Processes', icon: '⚙️', desc: 'Monitor CPU', prompt: 'Show me the top 5 processes consuming the most CPU right now.' },
      ],
      'analyst-agent': [
        { title: 'Market Analysis', icon: '📊', desc: 'Analyze US market', prompt: 'Search the current US Federal Reserve interest rate and explain its impact.' },
        { title: 'Tech Trends', icon: '💻', desc: 'Tech research', prompt: 'What are the most popular programming languages this year?' },
        { title: 'Macro Data', icon: '🌍', desc: 'GDP & Rates', prompt: 'Search for the latest US GDP growth and how it affects investments.' },
        { title: 'Crypto', icon: '₿', desc: 'Bitcoin trends', prompt: 'What is the value of Bitcoin today in USD and predictions for the week?' },
      ]
    };
  }
}

function renderPrompts() {
  const container = document.getElementById('prompts-grid');
  if (!container) return;

  const lang = document.getElementById('language-selector')?.value || 'English';
  const config = getPromptsConfig(lang);
  const prompts = config[currentAgentId] || config['researcher-agent'];

  container.replaceChildren(
    ...prompts.map((p) => {
      const btn = document.createElement('button');
      btn.className =
        'prompt-btn text-left p-4 rounded-2xl bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-900 hover:border-zinc-700 hover:shadow-lg transition-all group';

      const title = document.createElement('div');
      title.className = 'text-sm font-medium text-zinc-200 group-hover:text-zinc-50 mb-1 flex items-center gap-2';
      const icon = document.createElement('span');
      icon.textContent = p.icon;
      title.append(icon, document.createTextNode(p.title));

      const desc = document.createElement('div');
      desc.className = 'text-xs text-zinc-400';
      desc.textContent = p.desc;

      btn.append(title, desc);
      btn.addEventListener('click', () => {
        input.value = p.prompt;
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });

      return btn;
    }),
  );
}

document.getElementById('language-selector')?.addEventListener('change', () => renderPrompts());

loadAgents();
updateModeSelector();
renderPrompts();
