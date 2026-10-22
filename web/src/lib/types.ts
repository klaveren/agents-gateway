/** O que a API do gateway devolve — espelho do OpenAPI (`/v1/openapi.json`). */

export type TProvider = 'claude' | 'openai' | 'google'
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
  provider: TProvider
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

export interface IAgent {
  id: string
  name: string
  provider: TProvider
  models: string[]
  pricing: Record<string, IModelPrice>
  reasoningEfforts?: string[]
  modes: TMode[]
  allowedTools: string[]
  builtIn: boolean
}

export interface IAgentDetail extends IAgent {
  systemPrompt: string
  updatedAt?: string
  updatedBy?: string
}

export interface IAgentInput {
  id?: string
  name: string
  provider: TProvider
  systemPrompt: string
  models: string[]
  reasoningEfforts?: string[]
  modes: TMode[]
  allowedTools: string[]
}

export interface ITool {
  name: string
  description: string
  origin: 'local' | 'mcp'
}

export type TAudience = 'off' | 'restricted' | 'all'

export interface ISettings {
  audience: TAudience
  agentId?: string
  model?: string
  classifierModel?: string
  classifyTurns?: boolean
  updatedAt?: string
  updatedBy?: string
  defaults?: { agentId?: string; model?: string }
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

export interface ISession {
  token: string
  expiresAt: string
  user: IUser
}
