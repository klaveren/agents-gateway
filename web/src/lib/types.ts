/** O que a API do gateway devolve — espelho do OpenAPI (`/v1/openapi.json`). */

export type TProvider = 'claude' | 'openai' | 'google' | 'claude-sub' | 'codex' | 'antigravity'
export type TMode = 'chat' | 'agent'
export type TClassification = 'green' | 'blue' | 'amber' | 'red'

export interface IUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface IConversation {
  id: string
  agentId: string
  /** O id do provider configurado (`claude`, `openai`, `google` ou o id de um compatível). */
  provider: string
  mode: TMode
  model: string
  title?: string
  createdAt: string
  updatedAt: string
  turns: number
  usage: IUsage
  metadata?: { owner?: { id?: string; email?: string; account?: string } } & Record<string, unknown>
  shared: boolean
  shareId?: string
  preview?: { at: string; request: string; text: string }
  classification?: TClassification
  costUsd?: number
  /** O custo passou por modelo sem preço: é um piso. */
  costIsFloor?: boolean
}

/** O que a sessão viva usa AGORA — pode trocar no meio da conversa. */
export interface ISessionState {
  /** O provider que responde agora: um dos do agente. */
  provider?: string
  model: string
  reasoning?: string
  status?: string
}

export interface IToolCall {
  tool: string
  args?: unknown
  result?: unknown
  error?: string
}

export interface ITurn {
  sessionId: string
  index: number
  at: string
  request: string
  files?: Array<{ name: string; mimeType: string; size: number }>
  text: string
  reasoning?: string
  /** O modelo que respondeu este turno. Ausente nos antigos: vale o da conversa. */
  model?: string
  /** O provider que respondeu este turno. Ausente nos antigos: vale o da conversa. */
  provider?: string
  /** O nível de raciocínio pedido neste turno. */
  effort?: string
  toolCalls: IToolCall[]
  usage?: IUsage
  durationMs?: number
  firstTextMs?: number
  warnings?: string[]
  aborted?: boolean
  error?: string
  classification?: TClassification
  costUsd?: number
}

export interface IConversationPage {
  sessions: IConversation[]
  total?: number
  page?: number
  pageSize?: number
  facets?: { classification: Record<string, number>; provider: Record<string, number>; agent: Record<string, number> }
}

export interface IModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Um provider do agente, com o que vale NELE: modelos, preços e raciocínio. */
export interface IAgentProvider {
  /** O id do provider configurado (`claude`, `openai`, `google`, uma assinatura ou o id de um compatível). */
  id: string
  /** O nome como está no banco. */
  name: string
  protocol?: TProvider
  models: string[]
  pricing: Record<string, IModelPrice>
  /** Os níveis do agente que o protocolo deste provider aceita. */
  reasoningEfforts?: string[]
  /** Por modelo: os níveis que ele aceita. `null` = desconhecido (valem os do provider); `[]` = não raciocina. */
  modelReasoning?: Record<string, string[] | null>
  /** Só na edição: declarados pelo agente, mas desligados no catálogo do provider. */
  disabledModels?: string[]
  /** Só para admin: por que este provider não roda agora. */
  unavailable?: { reason: string; label: string }
}

export interface IAgent {
  id: string
  name: string
  /** Onde o agente roda. O PRIMEIRO é o padrão; a conversa troca entre eles no meio. */
  providers: IAgentProvider[]
  /** Os níveis que o agente oferece (cada provider usa os do seu protocolo). */
  reasoningEfforts?: string[]
  modes: TMode[]
  allowedTools: string[]
  /** `subagent`: só é chamado por outro agente (delegação); não abre conversa. */
  role?: 'subagent'
  /** Só para admin: por que o agente não abre conversa agora (nenhum provider roda). Ausente = ativo. */
  unavailable?: { reason: 'provider_disabled' | 'no_model' | 'no_key' | 'admin_only'; label: string }
}

export interface IAgentDetail extends IAgent {
  /** Quem o agente é (personalidade). */
  soul?: string
  systemPrompt: string
  updatedAt?: string
  updatedBy?: string
}

export interface IAgentInput {
  id?: string
  name: string
  /** Um ou mais; o primeiro é o padrão. */
  providers: Array<{ provider: string; models: string[] }>
  /** Quem o agente é (personalidade). */
  soul?: string
  systemPrompt: string
  reasoningEfforts?: string[]
  modes: TMode[]
  allowedTools: string[]
  /** `null` volta a agente normal. */
  role?: 'subagent' | null
}

export interface ITool {
  name: string
  description: string
  origin: 'local' | 'mcp'
  /** Alcança este servidor: com `DANGEROUS_TOOLS_ADMIN_ONLY`, o agente que a tem só conversa com admin. */
  dangerous?: boolean
}

/** Um protocolo como o servidor o descreve (`GET /protocols`) — a tela não copia mais essas regras. */
export interface IProtocolInfo {
  id: TProvider
  label: string
  subscription: boolean
  lanes: TMode[]
  reasoningLevels: string[]
  nativeFamily: TProvider
  brand: 'claude' | 'openai' | 'google'
  consoleUrl?: string
  envName?: string
}

export type TLimitName = 'maxToolTurns' | 'maxOutputTokens' | 'delegationMaxDepth' | 'bashTimeoutMs' | 'bashMaxOutputChars' | 'sessionsPerOwner' | 'streamsPerOwner'

export type TAudience = 'off' | 'restricted' | 'all'

export interface ISettings {
  audience: TAudience
  agentId?: string
  provider?: string
  model?: string
  classifierModel?: string
  classifierProvider?: string
  classifyTurns?: boolean
  updatedAt?: string
  updatedBy?: string
  defaults?: { agentId?: string; provider?: string; model?: string }
  /** Os limites gravados na tela; o que falta vale pelo `.env` ou pelo padrão. */
  limits?: Partial<Record<TLimitName, number>>
  /** O que vale agora, limite a limite (só leitura). */
  limitsInEffect?: Record<TLimitName, number>
  limitBounds?: Record<TLimitName, { min: number; max: number; env: string }>
  /** Decisões de implantação: a tela mostra, só o deploy muda. */
  deployment?: {
    dangerousToolsAdminOnly: boolean
    subscriptionAdminOnly: boolean
    localToolsEnabled?: string
    nativeToolsEnabled?: string
    allowAnonymous: boolean
  }
}

/** Eventos do stream de um turno (`POST /sessions/:id/messages`). */
export interface IAgentEvent {
  type: string
  sessionId: string
  payload?: Record<string, unknown>
}

export type TUserRole = 'admin' | 'member'

export interface IUser {
  id: string
  email: string
  name: string
  role: TUserRole
  disabled: boolean
  createdAt: string
  updatedAt: string
  updatedBy?: string
  lastLoginAt?: string
}

/** A sessão que o login devolve à TELA: sem o token, que fica no cookie HttpOnly. */
export interface ISession {
  expiresAt: string
  user: IUser
}

export interface IProviderStatus {
  id: string
  name: string
  /** O SDK que fala com ele. Compatível fala `openai` ou `claude` (Anthropic). */
  protocol: TProvider
  baseUrl?: string
  official: boolean
  /** Fala pela assinatura de uma pessoa (Claude Pro/Max, ChatGPT, Google), sem chave de API. */
  subscription?: boolean
  enabled: boolean
  credential: {
    configured: boolean
    source: 'stored' | 'none'
    last4?: string
    updatedAt?: string
    updatedBy?: string
    unreadable?: boolean
  }
  models: string[]
  agents: Array<{ id: string; name: string }>
  catalog?: { total: number; enabled: number }
}

export interface ICatalogModel {
  modelId: string
  label?: string
  enabled: boolean
  available: boolean
  contextLength?: number
  price?: IModelPrice
  priceSource?: 'manual' | 'catalog' | 'default'
  /** Ausente = a listagem não diz. `heuristic` = palpite pelo id. */
  reasoning?: { supported: boolean; levels?: string[]; source: 'provider' | 'heuristic' }
  syncedAt?: string
  updatedAt: string
  updatedBy?: string
}

export interface IProbeResult {
  ok: boolean
  /** Respondeu, mas a listagem do provider é pública: a chave não foi provada. */
  unverified?: boolean
  models?: number
  status?: number
  message?: string
}

export type TNativeRisk = 'hosted' | 'session' | 'server-network' | 'server-read' | 'server-exec'

/** Ferramenta nativa de um SDK (só na lane Agents SDK). O `id` é o que vai em `allowedTools`. */
export interface INativeTool {
  id: string
  protocol: TProvider
  sdkName: string
  label: string
  description: string
  risk: TNativeRisk
  officialOnly: boolean
  /** Dentro do perímetro do deploy (`NATIVE_TOOLS_ENABLED`). */
  allowed: boolean
  dangerous?: boolean
  reason?: string
}

export interface IUsageTokens {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface IUsageFigure {
  conversations: number
  turns: number
  usage: IUsageTokens
  /** Só na visão do admin. */
  costUsd?: number
  costIsFloor?: boolean
}

export interface IUsageSummary {
  period: { days: number; since: string; tzOffsetMinutes: number }
  totals: IUsageFigure
  daily: Array<IUsageFigure & { date: string }>
  byAgent: Array<IUsageFigure & { agentId: string }>
  byModel: Array<IUsageFigure & { provider: string; model: string }>
  top: Array<IUsageFigure & { id: string; title?: string; agentId: string; provider: string; model: string }>
}

/** Um valor de uma chave do `metadata` (ex.: `accountId`). Sem `value` = as conversas sem a chave. */
export interface IGroupUsage extends IUsageFigure {
  value?: string
}

export interface IUserUsage extends IUsageFigure {
  ownerId?: string
  email?: string
  name?: string
}

export type TMcpAuth = 'caller' | 'header' | 'none'
export type TMcpTransport = 'auto' | 'http' | 'sse'

/** Um servidor MCP cadastrado. ⛔ O segredo nunca vem: só se está configurado e o final dele. */
/** Um MCP em contêiner isolado (um por conversa). As travas não aparecem aqui: não são configuráveis. */
export interface IMcpContainer {
  image: string
  args: string[]
  writable: string[]
  memoryMb: number
  cpus: number
  network: 'none' | 'allowlist'
  allowedHosts: string[]
  env: string[]
}

export interface IMcpServer {
  id: string
  name: string
  kind: 'remote' | 'container'
  container?: IMcpContainer
  /** Só em contêiner: as variáveis secretas declaradas e se têm valor (⛔ nunca o valor). */
  env?: Array<{ name: string; configured: boolean }>
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  headerName?: string
  enabled: boolean
  secret: { configured: boolean; last4?: string; unreadable?: boolean; updatedAt?: string; updatedBy?: string }
  status: { connected: boolean; lastError?: string; instances?: number }
  agents: Array<{ id: string; name: string }>
  /** A URL é o MCP do próprio gateway. */
  selfReference: boolean
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

export interface IMcpTool {
  name: string
  description: string
}

/** O login de uma assinatura em andamento (ver `/providers/:id/login`). */
export interface ISubscriptionLogin {
  state: 'idle' | 'waiting' | 'done' | 'failed'
  url?: string
  userCode?: string
  needsCode: boolean
  expiresAt?: string
  message?: string
  /** O cliente não está na máquina do gateway: a tela mostra como instalar. */
  missing?: boolean
}
