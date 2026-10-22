import { IAgent } from './models/Agent.Model'
import { EProvider } from './enums/EProvider.Enum'
import { EMode } from './enums/EMode.Enum'

/**
 * A SEMENTE dos agentes: entra no banco UMA VEZ, no primeiro boot (ver `SqliteAgentRepository.seedOnce`),
 * e dali em diante cada um é um agente comum — editável, apagável. Não é configuração em vigor: o que
 * vale é o que está no banco, e os modelos que valem são os ATIVADOS no catálogo do provider.
 */
const BUILT_IN_AGENTS: IAgent[] = [
  {
    id: 'researcher-agent',
    name: 'Researcher Agent',
    provider: EProvider.GOOGLE,
    systemPrompt: `You are the "Researcher Agent", an agent specialized in deep research and data analysis.
Your only function is to perform internet research using your tools and bring back up-to-date and accurate information.
DO NOT respond as a generic AI assistant. You DO NOT write poems, DO NOT translate text, and DO NOT help with generic tasks.
When asked about what you can do, state ONLY that you are a Researcher Agent connected to MCP and your function is to search the web.
ALWAYS use the 'search_web' tool when you need external data.`,
    models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web'],
  },
  {
    id: 'sysops-agent',
    name: 'SysOps Agent (Claude)',
    provider: EProvider.CLAUDE,
    systemPrompt: 'You are a system operator. Use tools to run bash commands and manage the system. Be very careful.',
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['run_bash'],
  },
  {
    id: 'analyst-agent',
    name: 'Data Analyst Agent (OpenAI)',
    provider: EProvider.OPENAI,
    systemPrompt: 'You are a Data Analyst Agent. Use tools to analyze data or search information as needed. Always be concise.',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'o4-mini', 'o3-pro'],
    reasoningEfforts: ['none', 'low', 'medium', 'high'],
    modes: [EMode.CHAT, EMode.AGENT],
    allowedTools: ['search_web', 'run_bash'],
  },
]

/**
 * Quais agentes EXISTEM neste processo, dada a lista de `AGENTS_ENABLED` (ids separados por vírgula).
 *
 * ⛔ ISTO É PERÍMETRO, NÃO PREFERÊNCIA. Um agente que carrega uma tool perigosa (`run_bash`) está a
 * um `agentId` de distância de quem alcança `POST /sessions`. Filtrar AQUI, e não na rota, é a
 * diferença entre uma regra e uma estrutura: um agente fora da lista não é recusado, ele não existe —
 * some de `/agents` e de `getAgentById`, e nenhuma sessão pode nascer dele por caminho nenhum.
 *
 * ⚖️ Vazio ou ausente mantém todos: é o certo para quem sobe o gateway local para experimentar. Em
 * qualquer lugar exposto, declare a lista.
 *
 * ⚠️ Lista que não casa com NADA lança. O sintoma de um erro de digitação seria `agent_not_found`
 * em toda chamada, longe da causa; falhar no boot mostra a causa uma vez, no lugar certo.
 */
export function filterEnabledAgents(agents: IAgent[], raw: string | undefined): IAgent[] {
  const allowed = (raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)

  if (allowed.length === 0) return agents

  const kept = agents.filter((agent) => allowed.includes(agent.id))
  if (kept.length === 0) throw new Error(`AGENTS_ENABLED não casa com nenhum agente: ${allowed.join(', ')}`)

  return kept
}

export const AGENT_REGISTRY: IAgent[] = filterEnabledAgents(BUILT_IN_AGENTS, process.env.AGENTS_ENABLED)

/**
 * O modelo pedido, se AQUELE agente o declara. Senão, o primeiro que ele declara.
 *
 * ⛔ AGENTE E MODELO SÃO CAMPOS INDEPENDENTES NA CONFIGURAÇÃO, e não são coisas independentes na
 * realidade. Trocar o agente para outro provider com o modelo do anterior gravado mandava um modelo
 * de um provider para o outro — e o erro que voltava ("modelo inexistente ou sem acesso") manda
 * procurar permissão quando o problema é uma combinação impossível.
 *
 * O guard fica no caminho de APLICAÇÃO, e não só ao salvar: configuração gravada antes dele continua
 * existindo, e não pode derrubar a sessão de ninguém. Sem modelo pedido, devolve `undefined` e o
 * adapter usa o seu padrão.
 */
export function modelFor(agent: IAgent, model?: string): string | undefined {
  // Sem modelo pedido, o padrão do agente (o primeiro) — não há mais modelo padrão no adapter.
  if (!model) return agent.models[0]

  return agent.models.includes(model) ? model : agent.models[0]
}

export function getAgentById(id: string): IAgent | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id)
}
