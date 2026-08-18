const API_BASE = window.location.origin;

// State
let currentAgentId = 'researcher-agent';
let currentSessionId = null;
let isGenerating = false;

// DOM Elements
const form = document.getElementById('chat-form');
const input = document.getElementById('message-input');
const messagesContainer = document.getElementById('chat-messages');
const providerButtons = document.querySelectorAll('#provider-selector button');
const currentAgentName = document.getElementById('current-agent-name');

let agentsData = [];
let pendingFiles = [];

// DOM Elements - Attachments
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const filePreviewContainer = document.getElementById('file-preview-container');

// Fetch agents on load
async function loadAgents() {
  try {
    const res = await fetch(`${API_BASE}/agents`);
    const data = await res.json();
    if (data.ok) {
      agentsData = data.result;
      updateModelSelector();
    }
  } catch (err) {
    console.error('Failed to load agents', err);
  }
}

function updateModelSelector() {
  const modelSelect = document.getElementById('model-selector');
  const reasoningSelect = document.getElementById('reasoning-selector');
  if (!modelSelect || !reasoningSelect) return;
  
  const agent = agentsData.find(a => a.id === currentAgentId);
  if (!agent) return;

  // Populate Models
  if (!agent.models || agent.models.length === 0) {
    modelSelect.innerHTML = '<option value="">Nenhum modelo disponível</option>';
  } else {
    modelSelect.innerHTML = agent.models.map(m => `<option value="${m}">${m}</option>`).join('');
  }

  // Populate Reasoning
  if (!agent.reasoningEfforts || agent.reasoningEfforts.length === 0) {
    reasoningSelect.innerHTML = '<option value="">Nenhum</option>';
  } else {
    reasoningSelect.innerHTML = agent.reasoningEfforts.map(r => `<option value="${r}">${r}</option>`).join('');
  }
}

// Switch Agent
providerButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    const target = e.currentTarget;
    currentAgentId = target.dataset.provider;
    
    // Update active state
    providerButtons.forEach(b => {
      b.className = 'w-full text-left px-4 py-3 rounded-xl transition-all duration-200 border border-transparent hover:bg-slate-800 text-slate-300';
    });
    target.className = 'w-full text-left px-4 py-3 rounded-xl transition-all duration-200 border border-transparent bg-blue-500/10 text-blue-400 border-blue-500/30';
    
    currentAgentName.textContent = target.textContent.trim() || currentAgentId;
    currentSessionId = null; // Reset session when switching
    
    // Clear chat messages (except welcome section)
    Array.from(messagesContainer.children).forEach(child => {
      if (child.id !== 'welcome-section') {
        child.remove();
      }
    });

    const welcomeSection = document.getElementById('welcome-section');
    if (welcomeSection) welcomeSection.style.display = 'flex';
    
    renderPrompts();
    updateModelSelector();
    addMessage('system', `Switched to ${target.textContent.trim()}. New session started.`);
  });
});

loadAgents();

// UI Helpers
function addMessage(role, content, id) {
  const div = document.createElement('div');
  div.className = `flex flex-col max-w-[85%] chat-bubble ${role === 'user' ? 'ml-auto items-end' : ''}`;
  if (id) div.id = id;

  const innerClass = role === 'user' 
    ? 'bg-blue-600 text-white p-4 rounded-2xl rounded-tr-sm shadow-md'
    : role === 'system'
      ? 'bg-slate-800/80 text-slate-400 p-4 rounded-2xl border border-slate-700/50 text-sm italic'
      : 'bg-slate-800 border border-slate-700 p-4 rounded-2xl rounded-tl-sm text-slate-200 shadow-sm backdrop-blur-sm';

  const labelClass = role === 'user'
    ? 'text-xs text-slate-500 mt-2 mr-1'
    : 'text-xs text-slate-500 mt-2 ml-1';

  div.innerHTML = `
    <div class="tools-container flex flex-col gap-1 mb-1 empty:hidden"></div>
    <div class="${innerClass} content-box" style="white-space: pre-wrap;">${content}</div>
    <span class="${labelClass}">${role === 'user' ? 'You' : role === 'system' ? 'System' : 'Agent'}</span>
  `;

  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function updateMessage(id, content) {
  const el = document.getElementById(id);
  if (el) {
    const contentBox = el.querySelector('.content-box');
    if (contentBox) contentBox.textContent = content;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// File Handling
attachBtn?.addEventListener('click', () => fileInput.click());

fileInput?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target.result;
      const base64Data = result.split(',')[1];
      pendingFiles.push({
        name: file.name,
        mimeType: file.type,
        data: base64Data,
        previewUrl: result // keeping full url just for preview
      });
      renderFilePreviews();
    };
    reader.readAsDataURL(file);
  }
  fileInput.value = ''; // reset
});

function renderFilePreviews() {
  if (pendingFiles.length === 0) {
    filePreviewContainer.classList.add('hidden');
    filePreviewContainer.innerHTML = '';
    return;
  }
  
  filePreviewContainer.classList.remove('hidden');
  filePreviewContainer.innerHTML = pendingFiles.map((f, i) => `
    <div class="relative bg-slate-800 rounded flex items-center p-1 px-2 gap-2 text-xs border border-slate-700 w-max shrink-0">
      ${f.mimeType.startsWith('image/') ? `<img src="${f.previewUrl}" class="h-6 w-6 object-cover rounded-sm">` : '📄'}
      <span class="truncate max-w-[100px]">${f.name}</span>
      <button type="button" class="text-slate-400 hover:text-red-400 ml-1" onclick="removePendingFile(${i})">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
  `).join('');
}

window.removePendingFile = function(index) {
  pendingFiles.splice(index, 1);
  renderFilePreviews();
};

// API Calls
async function ensureSession() {
  if (currentSessionId) return currentSessionId;
  
  const selectedModel = document.getElementById('model-selector')?.value;
  const selectedReasoning = document.getElementById('reasoning-selector')?.value;
  const selectedLanguage = document.getElementById('language-selector')?.value;
  
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      agentId: currentAgentId, 
      model: selectedModel,
      reasoning: selectedReasoning,
      language: selectedLanguage
    })
  });
  
  if (!res.ok) throw new Error('Failed to create session');
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || 'Failed to create session');
  currentSessionId = data.result.id;
  return currentSessionId;
}

// Submit handler
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0 || isGenerating) return;

  const welcomeSection = document.getElementById('welcome-section');
  if (welcomeSection) welcomeSection.style.display = 'none';

  input.value = '';
  
  // Clone files to send and clear state
  const filesToSend = [...pendingFiles].map(({ name, mimeType, data }) => ({ name, mimeType, data }));
  pendingFiles = [];
  renderFilePreviews();

  addMessage('user', text + (filesToSend.length > 0 ? `\n[${filesToSend.length} anexo(s)]` : ''));
  isGenerating = true;

  try {
    const sessionId = await ensureSession();
    
    // Create placeholder for agent response
    const msgId = `msg-${Date.now()}`;
    const loadingHtml = `<div class="flex space-x-1.5 h-6 items-center px-1 opacity-70">
      <div class="w-2 h-2 bg-slate-300 rounded-full animate-bounce" style="animation-delay: -0.3s"></div>
      <div class="w-2 h-2 bg-slate-300 rounded-full animate-bounce" style="animation-delay: -0.15s"></div>
      <div class="w-2 h-2 bg-slate-300 rounded-full animate-bounce"></div>
    </div>`;
    
    addMessage('agent', loadingHtml, msgId);
    let fullText = '';

    const res = await fetch(`${API_BASE}/sessions/${currentAgentId}/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, files: filesToSend })
    });

    if (!res.body) throw new Error('No response body');
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const movePlaceholderToBottom = () => {
      const el = document.getElementById(msgId);
      if (el) {
        messagesContainer.appendChild(el);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    };
    
    let activeToolId = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text.delta' && data.payload?.text) {
              fullText += data.payload.text;
              updateMessage(msgId, fullText);
              movePlaceholderToBottom();
            } else if (data.type === 'tool.started') {
              activeToolId = `tool-${Date.now()}`;
              const el = document.getElementById(msgId);
              if (el) {
                const toolsContainer = el.querySelector('.tools-container');
                const badge = document.createElement('div');
                badge.id = activeToolId;
                badge.className = 'text-xs text-slate-400 bg-slate-800/80 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-slate-700/50 w-fit';
                badge.innerHTML = `<svg class="animate-spin h-3 w-3 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> <span>Using <b>${data.payload.tool}</b>...</span>`;
                toolsContainer.appendChild(badge);
              }
              movePlaceholderToBottom();
            } else if (data.type === 'tool.result') {
              if (activeToolId) {
                const badge = document.getElementById(activeToolId);
                if (badge) {
                  badge.className = 'text-xs text-slate-500 bg-slate-800/40 px-3 py-1.5 rounded-lg inline-flex items-center gap-2 border border-slate-700/30 w-fit';
                  badge.innerHTML = `<svg class="h-3 w-3 text-emerald-500" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> <span><b>${data.payload.tool}</b> completed</span>`;
                }
              }
              movePlaceholderToBottom();
            } else if (data.type === 'error') {
               addMessage('system', `❌ Error: ${data.payload.error || data.payload}`);
               movePlaceholderToBottom();
            }
          } catch (e) {
            console.error('SSE Parse error', e);
          }
        }
      }
    }
  } catch (err) {
    addMessage('system', `Error: ${err.message}`);
  } finally {
    isGenerating = false;
  }
});

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

  container.innerHTML = prompts.map(p => `
    <button class="prompt-btn text-left p-4 rounded-2xl bg-slate-800/50 border border-slate-700 hover:bg-slate-800 hover:border-slate-600 hover:shadow-lg transition-all group" data-prompt="${p.prompt}">
      <div class="text-sm font-medium text-slate-200 group-hover:text-blue-400 mb-1 flex items-center gap-2">
        <span>${p.icon}</span> ${p.title}
      </div>
      <div class="text-xs text-slate-400">${p.desc}</div>
    </button>
  `).join('');
  
  document.querySelectorAll('.prompt-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      input.value = e.currentTarget.dataset.prompt;
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
  });
}

// Re-render when language changes
document.getElementById('language-selector')?.addEventListener('change', () => {
  renderPrompts();
});

// Initial render
renderPrompts();
