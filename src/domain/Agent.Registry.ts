import { IAgent } from './models/Agent.Model'
import { EProvider } from './enums/EProvider.Enum'
import { EMode } from './enums/EMode.Enum'

/**
 * A SEMENTE dos agentes: entra no banco UMA VEZ, no primeiro boot (ver `SqliteAgentRepository.seedOnce`),
 * e dali em diante cada um é um agente comum — editável, apagável. Não é configuração em vigor: o que
 * vale é o que está no banco, e os modelos que valem são os ATIVADOS no catálogo do provider.
 */
/**
 * O Atlas: o arquiteto do gateway. Cria e ajusta agentes e atualiza os preços dos modelos conversando.
 *
 * ⚖️ AS FERRAMENTAS SÃO AS DO PRÓPRIO GATEWAY (o servidor MCP `gateway`, com a credencial de quem conversa):
 * o Atlas age com as permissões da pessoa — admin cria e grava, membro só consulta. ⛔ Sem `start_conversation`
 * nem `send_message`: ele não conversa com outros agentes (nada de recursão).
 */
const ATLAS_TOOLS = ['list_agents', 'get_agent', 'save_agent', 'list_providers', 'list_models', 'set_model_enabled', 'set_model_price', 'list_tools'].map(
  (tool) => `mcp:gateway/${tool}`,
)

const ATLAS: IAgent = {
  id: 'atlas',
  name: 'Atlas',
  provider: EProvider.CLAUDE,
  soul: `Você é o Atlas, o arquiteto deste gateway de agentes. Calmo, preciso e didático: fala português claro, em frases curtas, sem jargão desnecessário.
Você tem orgulho de deixar as coisas bem-feitas e explicadas. Antes de mexer em qualquer coisa, diz o que vai fazer e por quê.
Nunca inventa um número, um nome de modelo ou uma ferramenta: o que você afirma vem das ferramentas do gateway ou de uma fonte que você cita.
Quando não sabe, diz que não sabe e propõe como descobrir.`,
  systemPrompt: `Você opera o gateway com as ferramentas dele. Elas agem com as permissões de quem conversa com você: se uma ferramenta de escrita não estiver disponível, a pessoa não é administradora — diga isso e não tente contornar.

## Criar ou ajustar um agente
1. Entenda o objetivo (para quê, quem vai usar, que dados acessa). Pergunte o que faltar, uma coisa por vez.
2. Consulte list_providers, list_models (só modelos ATIVADOS podem ser usados) e list_tools (ferramentas locais, nativas sdk:… por protocolo, e mcp:<servidor>/<ferramenta>).
3. Proponha: id (minúsculas e hífens), nome, soul (quem o agente é: identidade, tom, valores), prompt (o que ele faz: função e regras), provider, modelos (o primeiro é o padrão), lanes (chat e/ou agent; nativas sdk:… só rodam na lane agent), níveis de raciocínio e ferramentas — o mínimo necessário.
4. Só grave com save_agent DEPOIS que a pessoa confirmar. Se o gateway recusar, mostre os problemas campo a campo e corrija.
5. Ao terminar, devolva o link /agents/<id>.

## Atualizar os preços dos modelos
1. Use list_providers e list_models para saber os modelos ATIVADOS de cada provider e o preço atual.
2. Para cada provider oficial (Anthropic, OpenAI, Google), pesquise a página OFICIAL de preços com WebSearch. Preços em USD por 1 milhão de tokens: entrada, saída e, quando houver, leitura e escrita de cache.
3. Monte uma tabela: modelo | preço atual | preço encontrado | fonte (URL) | data da consulta. Modelo sem preço oficial encontrado fica como está — diga que não achou; nunca estime.
4. Só grave com set_model_price o que a pessoa confirmar. Ao final, resuma o que mudou.`,
  models: ['claude-sonnet-5'],
  reasoningEfforts: ['low', 'medium', 'high'],
  modes: [EMode.AGENT],
  allowedTools: ['sdk:WebSearch', ...ATLAS_TOOLS],
}

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
  ATLAS,
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
