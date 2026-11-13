import type { IResourceFile } from './resourceFiles'
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
  /** O contexto em uso na última chamada ao modelo. Não se soma; ausente = o provider não informa. */
  contextTokens?: number
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
  /** Quando foi arquivada; ausente = está na caixa de entrada. */
  archivedAt?: string
}

/** O que a sessão viva usa AGORA — pode trocar no meio da conversa. */
export interface ISessionState {
  /** O provider que responde agora: um dos do agente. */
  provider?: string
  model: string
  reasoning?: string
  status?: string
  /** Onde a conversa trabalha: o repositório do projeto, a worktree e o branch de agora. */
  place?: { repository: string; worktree?: string; branch?: string }
  /** A compactação foi pedida e roda no início do próximo turno. */
  compactNext?: boolean
  /** A lane compacta o próprio contexto (Codex, Antigravity): sem botão de compactar. */
  compactsItself?: boolean
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
  /** O que a pessoa mandou com o turno rodando, e onde entrou na resposta (`at`, a posição no texto). */
  interjections?: ITurnInterjection[]
  aborted?: boolean
  error?: string
  classification?: TClassification
  /** A próxima mensagem provável da pessoa (o modelo de sugestão), que chega segundos depois do turno. */
  suggestion?: string
  costUsd?: number
}

export interface ITurnInterjection {
  at: number
  text: string
}

export interface IConversationPage {
  sessions: IConversation[]
  total?: number
  page?: number
  pageSize?: number
  /** Quantas conversas arquivadas existem (a lista traz só as ativas). */
  archivedCount?: number
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
  /** A janela de contexto de cada modelo que o provider informou. */
  contextLength?: Record<string, number>
  /** Os níveis do agente que o protocolo deste provider aceita. */
  reasoningEfforts?: string[]
  /** Por modelo: os níveis que ele aceita. `null` = desconhecido (valem os do provider); `[]` = não raciocina. */
  modelReasoning?: Record<string, string[] | null>
  /** O sandbox escolhido para este provider (Codex, Antigravity). Ausente = o padrão do protocolo. */
  sandbox?: TSandboxLevel
  /** Rede liberada no sandbox (Codex). */
  network?: boolean
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
  /** Só administrador conversa com o agente — escolha de quem o criou. */
  adminOnly?: boolean
  /** O projeto do agente; ausente = global (aparece em todos os projetos). */
  projectId?: string
  /** Só para admin: por que o agente não abre conversa agora (nenhum provider roda). Ausente = ativo. */
  unavailable?: { reason: 'provider_disabled' | 'no_model' | 'no_key' | 'admin_only'; label: string }
  /** Só na lista, só para admin: quantos problemas da importação ele tem (o detalhe traz a lista). */
  importIssueCount?: number
  /** Só na lista, só para admin: o grupo de modelos do agente (ausente = o padrão; `none` = não troca). */
  modelGroup?: string
  /** Etiquetas para achar o agente na lista (minúsculas, com hífen). Ausente = nenhuma. */
  tags?: string[]
  /** Os projetos que também conversam com este agente, sem editar (o dono é `projectId`). */
  sharedWith?: string[]
  /** Só nas listas de um projeto: veio de outro projeto (o id dele) e aqui é só leitura. */
  sharedFrom?: string
}

/**
 * Um PROBLEMA DA IMPORTAÇÃO que ficou dentro do artefato (doc, skill, command, agente): não impediu a gravação; o
 * artefato entrou sem o vínculo quebrado. Os PENDENTES (`link-pending`, `skill-missing`, `command-missing`,
 * `delegate-missing`, `mcp-missing`) voltam sozinhos quando o alvo é importado; descartar um esquece o que ele guardava.
 */
export interface IImportIssue {
  code: string
  message: string
  target?: string
  link?: string
  /** `delegate-missing`/`mcp-missing`: as regras do agente que ficaram guardadas (voltam com o alvo). */
  rules?: IPermissionRule[]
  /** E as ferramentas (`agent:<id>`, `mcp:<servidor>/…`). */
  tools?: string[]
}

/** Qual resolver: um (o código e, dado, o alvo), ou todos os pendentes de uma vez. */
export type TImportIssueMatch = Pick<IImportIssue, 'code' | 'target'> | { pending: true }

export interface IAgentDetail extends IAgent {
  /** Os problemas da importação (ver `IImportIssue`). */
  importIssues?: IImportIssue[]
  /** Quem o agente é (personalidade). */
  soul?: string
  permissions?: IPermissionRule[]
  /** O terminal deste agente: tempo por comando e saída. Ausente = o global. */
  terminal?: IAgentTerminal
  /** O diagnóstico depois de editar. Ausente = desligado. */
  diagnostics?: IAgentDiagnostics
  /** As ações ativadas sob demanda (guia Triggers). */
  triggers?: IAgentTrigger[]
  /** O grupo de modelos: ausente = o padrão; `none` = não troca. */
  modelGroup?: string
  /** As variáveis de ambiente fixas do agente, em todo terminal dele. */
  env?: Record<string, string>
  /** Os arquivos da pasta do agente (guia Arquivos): ver `lib/resourceFiles`. */
  files?: IResourceFile[]
  systemPrompt: string
  updatedAt?: string
  updatedBy?: string
}

/** Um passo de um grupo de modelos (ver `Fallback.Policy` no servidor). */
export interface IFallbackStep {
  provider: string
  model: string
}

/** As falhas que fazem a conversa trocar de passo. */
export type TSwitchFailure = 'quota' | 'rate_limit' | 'model' | 'overloaded' | 'auth'

/** Um GRUPO DE MODELOS: os passos em ordem e quando trocar de um para o próximo (ver `Fallback.Policy` no servidor). */
export interface IModelGroup {
  id: string
  name: string
  description?: string
  steps: IFallbackStep[]
  /** Ausente = cota, limite de uso e modelo indisponível. */
  switchOn?: TSwitchFailure[]
  /** Ausente = 15. */
  cooldownMinutes?: number
}

/** Um trigger do agente: o nome, quando usar (vai no índice do prompt) e o procedimento (carregado sob demanda). */
export interface IAgentTrigger {
  id: string
  when: string
  body: string
}

/** O tsc, o eslint e o prettier do pacote, depois de cada edição (ver `Edit.Diagnostics` no servidor). */
export interface IAgentDiagnostics {
  typecheck?: boolean
  lint?: boolean
  format?: boolean
  timeoutSeconds?: number
}

export interface IAgentTerminal {
  timeoutSeconds?: number
  maxOutputChars?: number
}

export interface IAgentInput {
  id?: string
  name: string
  /** Um ou mais; o primeiro é o padrão. */
  providers: Array<{ provider: string; models: string[]; sandbox?: TSandboxLevel; network?: boolean }>
  /** Quem o agente é (personalidade). */
  soul?: string
  systemPrompt: string
  reasoningEfforts?: string[]
  modes: TMode[]
  allowedTools: string[]
  /** `null` volta a agente normal. */
  role?: 'subagent' | null
  adminOnly?: boolean
  /** `null` = global. */
  projectId?: string | null
  /** As regras de permissão do agente (a camada dele, por cima das do projeto). */
  permissions?: IPermissionRule[]
  terminal?: IAgentTerminal | null
  /** `null` desliga. */
  diagnostics?: IAgentDiagnostics | null
  /** Vazio apaga todos. */
  triggers?: IAgentTrigger[]
  /** Ausente mantém; `null` volta ao grupo padrão; `none` = não troca; senão o id de um grupo. */
  modelGroup?: string | null
  /** `null` apaga todas. */
  env?: Record<string, string> | null
  /** Ausente mantém; vazio apaga todas. */
  tags?: string[]
}

export type TPermissionCategory = 'terminal' | 'read' | 'write' | 'network' | 'mcp' | 'skill' | 'delegate' | 'account' | 'repository' | 'trigger'

/** Uma regra de permissão: o padrão, Permitir ou Negar, e uma nota. */
export interface IPermissionRule {
  category: TPermissionCategory
  pattern: string
  decision: 'allow' | 'deny'
  note?: string
}

/** O que decidiu um pedido (o testador e as últimas decisões). */
export interface IPermissionPart {
  category: TPermissionCategory
  value: string
  allowed: boolean
  layer: 'system' | 'agent' | 'project' | 'default'
  reason: string
}

export interface IPermissionDecision {
  at: string
  agentId?: string
  sessionId?: string
  category: TPermissionCategory
  subject: string
  allowed: boolean
  layer: IPermissionPart['layer']
  pattern?: string
}

/** O sandbox do cliente agêntico (`Sandbox.Policy` no servidor). */
export type TSandboxLevel = 'read-only' | 'workspace-write' | 'full'

/** Uma capacidade do gateway (`cap:terminal`…): escolhida uma vez; `runs` diz o que roda em cada protocolo. */
export interface ICapability {
  id: string
  label: string
  description: string
  risk: TNativeRisk
  dangerous: boolean
  runs: Record<string, string>
}

export interface ITool {
  name: string
  description: string
  origin: 'local' | 'mcp'
  /** Alcança este servidor: quem conversa com o agente ganha esse alcance (a tela avisa). */
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
  /** Os níveis do sandbox, o padrão primeiro; vazio = nada a ajustar. */
  sandboxLevels?: TSandboxLevel[]
  sandboxNetwork?: boolean
  brand: 'claude' | 'openai' | 'google'
  consoleUrl?: string
  envName?: string
}

export type TLimitName =
  | 'maxToolTurns'
  | 'maxOutputTokens'
  | 'delegationMaxDepth'
  | 'bashTimeoutMs'
  | 'bashMaxOutputChars'
  | 'sessionsPerOwner'
  | 'streamsPerOwner'
  | 'compactAtPercent'
  | 'loopRefuseAt'
  | 'loopStopAt'
  | 'loopMaxErrors'
  | 'monthlyCostCapUsd'
  | 'userMonthlyCostCapUsd'
  | 'monthlyTokenCap'
  | 'userMonthlyTokenCap'

export type TAudience = 'off' | 'restricted' | 'all'

export interface ISettings {
  audience: TAudience
  agentId?: string
  provider?: string
  model?: string
  classifierModel?: string
  classifierProvider?: string
  /** O modelo da sugestão de próximo passo (Configuração). Ausentes = sem sugestão. */
  suggestProvider?: string
  suggestModel?: string
  /** O provider e o modelo do construtor (agente do core). Ausentes = os do Atlas. */
  builderProvider?: string
  builderModel?: string
  classifyTurns?: boolean
  /** Os grupos de modelos (Configuração → Grupos de modelos). */
  modelGroups?: IModelGroup[]
  /** O grupo dos agentes que não escolheram um. Ausente = nenhum. */
  defaultModelGroup?: string
  /** 🌿 Esta instalação no git: o nome, o prefixo das branches, a base das worktrees e as branches que só recebem por PR. */
  installationName?: string
  branchPrefix?: string
  baseBranch?: string
  protectedBranches?: string[]
  /** Trocar de branch na pasta principal do repositório. Ausente = travado. */
  lockMainCheckout?: boolean
  /** Os provedores sem cota agora, e quando voltam (só leitura). */
  benched?: Array<{ provider: string; until: string }>
  updatedAt?: string
  updatedBy?: string
  defaults?: { agentId?: string; provider?: string; model?: string }
  /** Os limites gravados na tela; o que falta vale pelo `.env` ou pelo padrão. */
  limits?: Partial<Record<TLimitName, number>>
  /** O que vale agora, limite a limite (só leitura). */
  limitsInEffect?: Record<TLimitName, number>
  /** `unlimited`: aceita -1 (sem teto). */
  limitBounds?: Record<TLimitName, { min: number; max: number; env: string; unlimited?: boolean; cents?: boolean }>
  /** Decisões de implantação: a tela mostra, só o deploy muda. */
  deployment?: {
    localToolsEnabled?: string
    allowAnonymous: boolean
    /** O cerco dos agentes de projeto neste servidor. Sem ele, o Bash deles fica bloqueado. */
    sandbox?: ISandboxStatus
    /** O Docker responde neste servidor? Sem ele, o MCP "Contêiner isolado" não sobe. */
    docker?: { available: boolean; reason?: string }
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
  dangerous?: boolean
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
  /** ESTIMATIVA por ferramenta (o provedor não separa): diretos = argumentos + resultado; contexto = o resultado relido no turno. */
  byTool?: IToolUsage[]
}

export interface IToolUsage {
  tool: string
  calls: number
  errors: number
  directTokens: number
  contextTokens: number
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

export type TMcpAuth = 'caller' | 'header' | 'none' | 'oauth'

/** O login OAuth de um MCP remoto: cada pessoa conecta a própria conta (o secret fica no cofre, como a chave). */
export interface IMcpOAuth {
  clientId: string
  scopes?: string
  authorizationServer?: string
}
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
  /** As fixas do MCP: o valor é visível e igual em todo projeto. */
  vars?: Record<string, string>
  /** As que CADA projeto preenche com valor visível (Ambiente → Variáveis). */
  projectVars?: string[]
  /** As SECRETAS que cada projeto preenche (⛔ o MCP não guarda segredo). */
  env: string[]
}

/** Um MCP que roda como processo do próprio gateway (pacote npm ou comando), sem isolamento. */
export interface IMcpProcess {
  package?: string
  command?: string
  args: string[]
  /** As fixas do MCP: o valor é visível e igual em todo projeto. */
  vars?: Record<string, string>
  /** As que CADA projeto preenche com valor visível (Ambiente → Variáveis). */
  projectVars?: string[]
  /** As SECRETAS que cada projeto preenche (⛔ o MCP não guarda segredo). */
  env: string[]
  scope: 'conversation' | 'shared'
}

export type TMcpKind = 'remote' | 'container' | 'process'

export interface IMcpServer {
  /** A chave das rotas: o id no global, `<projeto>.<id>` no de projeto. */
  key: string
  /** O que o agente cita (`mcp:<id>/…`). Dois projetos podem ter o mesmo. */
  id: string
  /** O projeto dono. Ausente = global (serve a todo agente); de projeto, só aos agentes dele. */
  projectId?: string
  /** 🔌 Desta máquina: cadastrado aqui, num projeto conectado. A origem não o conhece, e ele segue editável. */
  local?: boolean
  name: string
  kind: TMcpKind
  container?: IMcpContainer
  process?: IMcpProcess
  /** Só em processo: o que está instalado e se ainda é o pacote do cadastro. */
  install?: { installed: boolean; version?: string; spec?: string; installedAt?: string; stale?: boolean }
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  headerName?: string
  /** Envia a identidade de quem chama em cabeçalhos (`x-gateway-agent`, `-conversation`, `-project`). */
  identity?: boolean
  oauth?: IMcpOAuth
  /** `auth: oauth`: quem está na tela já conectou a conta, e o endereço de retorno a cadastrar no provedor. */
  oauthConnected?: boolean
  oauthRedirectUri?: string
  enabled: boolean
  secret: { configured: boolean; last4?: string; unreadable?: boolean; updatedAt?: string; updatedBy?: string }
  status: { connected: boolean; lastError?: string; instances?: number }
  agents: Array<{ id: string; name: string }>
  /** A URL é o MCP do próprio gateway. */
  selfReference: boolean
  tags?: string[]
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

/** Uma chamada recebida por um hook. */
export interface IHookDelivery {
  id: string
  receivedAt: string
  status: 'running' | 'ok' | 'error'
  sessionId?: string
  error?: string
}

export interface ISandboxStatus {
  available: boolean
  mechanism: 'seatbelt' | 'bubblewrap' | 'none'
  reason?: string
}

/** Um projeto: agentes e conversas vivem dentro de um, com a sua pasta. `folder` e `members` só para admin. */
/** Uma regra do ambiente (Rule N). Sem `projectId` = global. */
export interface IRule {
  id: string
  projectId?: string
  position: number
  title: string
  body: string
  enabled: boolean
  tags?: string[]
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

export type TDocKind = 'spec' | 'adr' | 'knowledge'
/** O estado do documento; ausente = aceita (ver `lib/docStatus`). */
export type TDocStatus = 'proposed' | 'accepted' | 'superseded' | 'archived'

/** Uma spec ou ADR em markdown. A lista vem sem o `body`. */
export interface IProjectDoc {
  id: string
  kind: TDocKind
  projectId?: string
  title: string
  summary: string
  tags?: string[]
  body?: string
  /** Ausente = aceita. Substituída e arquivada saem do índice da conversa. */
  status?: TDocStatus
  /** Ids de documentos do MESMO tipo que este substitui (global só substitui global). Ao salvar, o servidor marca-os como substituídos. */
  supersedes?: string[]
  /** SÓ LEITURA, calculado pelo servidor: os documentos cujo `supersedes` inclui este. */
  supersededBy?: string[]
  /** Outros documentos anexados, na ordem: vão junto quando este é lido. Globais ou do mesmo projeto (o global só anexa global). */
  docIds?: string[]
  /** Dos anexados, os que vão por referência (o agente lê com `read_doc` se precisar). Ausente = todos inteiros. */
  docRefs?: string[]
  /** Só na lista: quem carrega a spec inteira (o contexto inicial dos projetos e dos agentes). */
  loadedIn?: { projects: string[]; agents: string[] }
  /** Só na lista: o peso estimado do corpo. */
  tokens?: number
  /** Os problemas da importação (ver `IImportIssue`), na lista também. */
  importIssues?: IImportIssue[]
  /** Os projetos que recebem este documento só para leitura (o dono é `projectId`). */
  sharedWith?: string[]
  /** Só nas listas de um projeto: veio de outro projeto (o id dele) e aqui é só leitura. */
  sharedFrom?: string
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

/** O tamanho de um agente: o que ele carrega antes da primeira mensagem, parte a parte (`GET /agents/:id/footprint`). */
export interface IFootprintSection {
  key: string
  label: string
  /** `null`: está no prompt, mas não se mede daqui (as ferramentas nativas do SDK, um MCP fora do ar). */
  tokens: number | null
  items?: Array<{ name: string; tokens: number }>
  note?: string
}

export interface IAgentFootprint {
  total: number
  project?: string
  sections: IFootprintSection[]
  /** Só quando o agente salvo oferece Codex ou Antigravity: o prompt montado como argumento de linha de comando. */
  cli?: ICliFootprint
}

/** O prompt montado num argumento de CLI, em bytes, contra o limite do Linux (128 KiB por argumento). */
export interface ICliFootprint {
  providers: string[]
  /** O argumento inteiro estimado (o maior entre os CLIs do agente). */
  bytes: number
  limit: number
  /** A partir daqui, aviso (nunca bloqueio). */
  warnAt: number
  /** Cada parte do prompt em bytes crus (`soul`, `instructions`, `rules`, `skills`, `index`…). */
  parts: Array<{ key: string; label: string; bytes: number }>
}

export type TResourceKind = 'skill' | 'command'

/** Uma skill ou um command (`/nome`). Sem `projectId` = global. */
export interface IResource {
  id: string
  kind: TResourceKind
  projectId?: string
  description: string
  tags?: string[]
  body: string
  docIds: string[]
  /** Dos anexados, os que vão por referência (o agente lê com `read_doc` se precisar). Ausente = todos inteiros. */
  docRefs?: string[]
  /** Os arquivos da pasta (scripts, modelos): ver `lib/resourceFiles`. */
  files?: IResourceFile[]
  /** Os problemas da importação (ver `IImportIssue`). */
  importIssues?: IImportIssue[]
  /** Os triggers da skill ou do command: o procedimento de uma situação, carregado sob demanda (`<id>/<trigger>`). */
  triggers?: IAgentTrigger[]
  /** As variáveis fixas (texto comum, valor visível): carregado o recurso, vão ao terminal, por baixo das secretas. */
  env?: Record<string, string>
  /** Os projetos que recebem este recurso só para leitura (o dono é `projectId`). */
  sharedWith?: string[]
  /** Só nas listas de um projeto: veio de outro projeto (o id dele) e aqui é só leitura. */
  sharedFrom?: string
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

/** O que um agente pode usar: ids, ou `['*']` = todos os que ele vê. */
export interface IAgentResources {
  skills: string[]
  commands: string[]
}

/** O contexto inicial de um projeto: as specs que vão inteiras no prompt, na ordem. */
export interface IInitialContext {
  docs: Array<{ id: string; title: string; summary: string; projectId?: string; tokens: number }>
  totalTokens: number
}

export interface IProject {
  id: string
  name: string
  description?: string
  /** O papel de quem pediu (a lista é só dos projetos de que a pessoa é membro). */
  role?: TProjectRole
  folder?: string
  members?: number
  /** Só admin: as variáveis FIXAS do projeto (valor visível; para todo agente dele, por baixo das do agente). */
  env?: Record<string, string>
  /** Só admin: os valores VISÍVEIS que o projeto dá às variáveis que cada MCP pede. */
  mcpEnv?: IProjectMcpVar[]
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

/** Um valor visível que o projeto dá a uma variável de um MCP (`server` = o id do MCP). */
export interface IProjectMcpVar {
  server: string
  name: string
  value: string
}

/** Um MCP que pede valor ao projeto, com o que pede (`GET /projects/:id/mcp-variables`). ⛔ A secreta nunca traz o valor. */
export interface IMcpProjectVariables {
  key: string
  id: string
  name: string
  enabled: boolean
  fixed: string[]
  /** `local`: num projeto conectado, o valor visível é desta máquina (por cima do da origem). */
  variables: Array<{ name: string; secret: boolean; configured: boolean; value?: string; local?: boolean }>
}

/** O papel no projeto: o administrador cuida de tudo dele; o membro conversa com os agentes. */
export type TProjectRole = 'admin' | 'member'

export interface IProjectMember {
  projectId: string
  userId: string
  role: TProjectRole
  addedAt: string
  addedBy?: string
}

/** Um hook de agente: `POST /v1/hook/<agente>/<hook>` executa o `prompt` com o evento recebido. */
export interface IAgentHook {
  agentId: string
  name: string
  /** `/v1/hook/<agente>/<hook>` — a tela completa com a origem. */
  path: string
  prompt: string
  enabled: boolean
  verify: 'key' | 'hmac'
  signatureHeader: string
  signaturePrefix: string
  signatureEncoding: 'hex' | 'base64'
  requireTimestamp: boolean
  session: 'new' | 'continuous'
  sessionId?: string
  runAs: string
  secretLast4?: string
  lastDelivery?: IHookDelivery
  /** Só ao criar e ao trocar a chave. */
  secret?: string
  createdAt: string
  updatedAt: string
  updatedBy?: string
}

export type THookInput = Pick<IAgentHook, 'prompt' | 'enabled' | 'verify' | 'signatureHeader' | 'signaturePrefix' | 'signatureEncoding' | 'requireTimestamp' | 'session'>

/** Uma ferramenta do servidor instalada pela guia Pacotes (micromamba, conda-forge). */
export interface IInstalledPackage {
  name: string
  version: string
  /** Pedido por quem administra; `false` = veio como dependência. */
  explicit: boolean
}

export interface IPackagesState {
  /** O micromamba existe no servidor. */
  available: boolean
  version?: string
  /** Onde as ferramentas moram (persistente). */
  prefix: string
  packages: IInstalledPackage[]
  /** O npm do servidor (pacotes globais num prefixo próprio). */
  npm?: INpmPackagesState
}

export interface INpmPackagesState {
  /** O `npm` existe no servidor. */
  available: boolean
  version?: string
  prefix: string
  packages: IInstalledPackage[]
}

/** De onde vem o pacote: conda-forge (micromamba) ou registro npm. */
export type TPackageSource = 'conda' | 'npm'

export interface IPackageHit {
  name: string
  version: string
  license?: string
}

export interface IMcpTool {
  name: string
  description: string
  /** O esquema dos parâmetros, como o servidor o descreve (é o que mais pesa na definição). */
  inputSchema?: unknown
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

/** Uma execução de agendamento, para o histórico. */
export interface IScheduleRun {
  id: string
  trigger: 'cron' | 'manual'
  scheduledFor: string
  startedAt?: string
  finishedAt?: string
  status: 'running' | 'ok' | 'error' | 'skipped' | 'missed'
  sessionId?: string
  error?: string
}

/** O que se edita num agendamento. */
export interface TScheduleInput {
  cron: string
  timezone: string
  prompt: string
  session: 'new' | 'continuous'
  projectId?: string | null
  enabled: boolean
}

/** Um agendamento de agente: o agente executa `prompt` nos horários do cron, em nome de quem criou. */
export interface ISchedule extends TScheduleInput {
  agentId: string
  name: string
  sessionId?: string
  runAs: string
  failures: number
  pausedReason?: string
  nextRunAt?: string
  lastRun?: IScheduleRun
  updatedAt?: string
  updatedBy?: string
}

/**
 * Uma vigia armada na conversa (`watch_start`, `wake_me`): o gateway confere um comando de tempos em tempos, ou espera
 * um horário, e a conversa retoma sozinha quando acontecer.
 */
export interface IWatchItem {
  id: string
  kind: 'command' | 'timer'
  label: string
  command?: string
  everySeconds?: number
  status: 'active' | 'met' | 'expired' | 'failed' | 'cancelled'
  createdAt: string
  deadlineAt: string
  checks: number
  endReason?: string
}

/** Uma tarefa da lista que o agente mantém na conversa (`update_todos`). */
export interface ITodoItem {
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
}
