import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { UPDATE_TODOS_TOOL } from './models/ConversationTodo.Model'
import { TNativeToolRisk } from './Native.Tools'

/**
 * AS CAPACIDADES DO GATEWAY: o agente escolhe "Terminal", "Ler arquivos"… uma vez, e o gateway decide, no provedor do
 * turno, o que roda — a ferramenta dele ou a nativa do SDK. Guardadas em `allowedTools` como `cap:<id>`.
 *
 * ⚖️ Terminal é SEMPRE o `run_bash` (a trava, o teto de tempo e de saída valem em todo provedor). Arquivos no Claude são
 * as nativas dele (o modelo foi treinado nelas; o filtro de caminho do gateway vale); nos provedores por token, as do
 * gateway. O Codex e o Gemini por assinatura recebem o terminal, os arquivos e as tarefas do gateway por MCP (`Turn.Grants`).
 */
export const CAPABILITY_PREFIX = 'cap:'

export type TCapabilityId = 'terminal' | 'files.read' | 'files.write' | 'web.search' | 'web.fetch' | 'todos'

/** O que roda num provedor: ferramentas concretas (locais ou `sdk:`), o que o CLI já faz sozinho, ou nada. */
type TRun = { tools: readonly string[]; note: string } | { builtIn: string } | { unavailable: true }

export interface ICapability {
  id: TCapabilityId
  label: string
  description: string
  risk: TNativeToolRisk
  /** Como roda, por família de protocolo (o Claude por assinatura usa a do Claude). Ausente = do gateway (`local`). */
  runs: Partial<Record<EProvider, TRun>>
  /** As ferramentas do gateway: no modo Conversa e em todo provedor sem entrada em `runs`. */
  local: readonly string[]
}

export const CAPABILITIES: readonly ICapability[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    description: 'Roda comandos na pasta da conversa (ou do projeto), com trava de comandos perigosos e teto de tempo.',
    risk: 'server-exec',
    local: ['run_bash'],
    // ⛔ Os terminais do Codex e do Gemini não seguem as permissões: os dois recebem o do gateway, por MCP (`Turn.Grants`).
    runs: {},
  },
  {
    id: 'files.read',
    label: 'Ler arquivos',
    description: 'Lê, lista e procura arquivos na pasta da conversa (ou do projeto). Chaves e .env nunca.',
    risk: 'server-read',
    local: ['read_file', 'list_files', 'search_files'],
    runs: {
      // ⛔ Sem o Glob e o Grep nativos: varrem a pasta inteira e devolveriam o conteúdo de arquivo negado (o `.env`
      // num Grep). A busca e a listagem são as do gateway, que conferem arquivo por arquivo; o Read (um arquivo) é o dele.
      [EProvider.CLAUDE]: { tools: ['sdk:Read', 'list_files', 'search_files'], note: 'Read do Claude, busca do gateway' },
    },
  },
  {
    id: 'files.write',
    label: 'Escrever arquivos',
    description: 'Cria e edita arquivos na pasta da conversa (ou do projeto). Chaves e .env nunca.',
    risk: 'server-exec',
    local: ['write_file', 'edit_file'],
    runs: {
      [EProvider.CLAUDE]: { tools: ['sdk:Write', 'sdk:Edit'], note: 'nativa do Claude' },
    },
  },
  {
    id: 'web.search',
    label: 'Busca na web',
    description: 'Procura na internet e traz as fontes.',
    risk: 'hosted',
    local: ['search_web'],
    runs: {
      [EProvider.CLAUDE]: { tools: ['sdk:WebSearch'], note: 'da Anthropic' },
      [EProvider.OPENAI]: { tools: ['sdk:openai:web_search'], note: 'da OpenAI' },
      [EProvider.GOOGLE]: { tools: ['sdk:google:google_search'], note: 'do Google' },
      [EProvider.CODEX]: { tools: ['sdk:codex:web_search'], note: 'do Codex' },
      [EProvider.ANTIGRAVITY]: { unavailable: true },
    },
  },
  {
    id: 'web.fetch',
    label: 'Abrir página',
    description: 'Lê uma página pelo endereço.',
    risk: 'server-network',
    local: [],
    runs: {
      [EProvider.CLAUDE]: { tools: ['sdk:WebFetch'], note: 'nativa do Claude' },
      [EProvider.GOOGLE]: { tools: ['sdk:google:url_context'], note: 'do Google' },
      [EProvider.OPENAI]: { unavailable: true },
      [EProvider.CODEX]: { unavailable: true },
      [EProvider.ANTIGRAVITY]: { unavailable: true },
    },
  },
  {
    id: 'todos',
    label: 'Lista de tarefas',
    description: 'O agente organiza os passos de um trabalho longo; a lista aparece na conversa.',
    risk: 'session',
    local: [UPDATE_TODOS_TOOL],
    runs: {},
  },
]

export function isCapability(id: string): boolean {
  return id.startsWith(CAPABILITY_PREFIX)
}

export function capability(id: string): ICapability | undefined {
  return CAPABILITIES.find((item) => `${CAPABILITY_PREFIX}${item.id}` === id)
}

/** Os ids que viraram capacidade (locais e `sdk:`): ninguém os escolhe direto — saem da resolução. */
export const CAPABILITY_TOOLS: ReadonlySet<string> = new Set(
  CAPABILITIES.flatMap((item) => [...item.local, ...Object.values(item.runs).flatMap((run) => (run && 'tools' in run ? run.tools : []))]).concat(
    'sdk:Bash',
    'sdk:NotebookEdit',
    'sdk:codex:shell',
  ),
)

/** ⛔ Os terminais que NÃO passam pelas permissões (o Bash nativo do Claude, o do Codex): nunca saem da resolução. */
const UNGUARDED_TERMINALS: ReadonlySet<string> = new Set(['sdk:Bash', 'sdk:codex:shell'])

export interface IResolveTarget {
  protocol: EProvider
  /** Provedor oficial (as hospedadas da OpenAI e do Google só rodam nele). */
  official: boolean
  mode: EMode
}

/**
 * As capacidades em ferramentas concretas para ESTE provedor e modo. Devolve o `allowedTools` sem os `cap:` (com o que
 * eles viram) e as capacidades que não rodam aqui — viram aviso no turno, não erro.
 */
export function resolveCapabilities(allowedTools: readonly string[], target: IResolveTarget): { allowedTools: string[]; unavailable: string[] } {
  const family = target.protocol === EProvider.CLAUDE_SUB ? EProvider.CLAUDE : target.protocol
  const resolved: string[] = []
  const unavailable: string[] = []
  for (const id of allowedTools) {
    const item = capability(id)
    if (!item) {
      if (!isCapability(id) && !UNGUARDED_TERMINALS.has(id)) resolved.push(id)
      continue
    }
    const run = item.runs[family]
    // Hospedada fora do provedor oficial (um compatível da OpenAI), ou modo Conversa (só locais): a do gateway.
    const hosted = run && 'tools' in run && run.tools.some((tool) => tool.startsWith('sdk:openai:') || tool.startsWith('sdk:google:'))
    const useLocal = !run || target.mode === EMode.CHAT || (hosted && !target.official)
    if (useLocal) {
      if (item.local.length) resolved.push(...item.local)
      else unavailable.push(item.label)
    } else if ('tools' in run) resolved.push(...run.tools)
    else if ('unavailable' in run) unavailable.push(item.label)
  }
  return { allowedTools: [...new Set(resolved)], unavailable }
}

/** Como a capacidade roda em cada provedor, para a tela ("nativa do Claude", "do gateway", "indisponível"). */
export function capabilityRuns(item: ICapability, protocol: EProvider): string {
  const run = item.runs[protocol === EProvider.CLAUDE_SUB ? EProvider.CLAUDE : protocol]
  if (!run) return item.local.length ? 'do gateway' : 'indisponível'
  if ('tools' in run) return run.note
  if ('builtIn' in run) return run.builtIn
  return 'indisponível'
}

/** O id antigo (local ou `sdk:`) que hoje é capacidade → a capacidade. Para a migração `capabilities`. */
export const LEGACY_TO_CAPABILITY: Readonly<Record<string, string>> = {
  run_bash: 'cap:terminal',
  'sdk:Bash': 'cap:terminal',
  'sdk:codex:shell': 'cap:terminal',
  'sdk:Read': 'cap:files.read',
  'sdk:Glob': 'cap:files.read',
  'sdk:Grep': 'cap:files.read',
  'sdk:Write': 'cap:files.write',
  'sdk:Edit': 'cap:files.write',
  'sdk:NotebookEdit': 'cap:files.write',
  search_web: 'cap:web.search',
  'sdk:WebSearch': 'cap:web.search',
  'sdk:openai:web_search': 'cap:web.search',
  'sdk:google:google_search': 'cap:web.search',
  'sdk:codex:web_search': 'cap:web.search',
  'sdk:WebFetch': 'cap:web.fetch',
  'sdk:google:url_context': 'cap:web.fetch',
  [UPDATE_TODOS_TOOL]: 'cap:todos',
}

/** O `allowedTools` com os ids antigos trocados pelas capacidades, sem repetir (a ordem do primeiro fica). */
export function toCapabilities(allowedTools: readonly string[]): string[] {
  return [...new Set(allowedTools.map((tool) => LEGACY_TO_CAPABILITY[tool] ?? tool))]
}
