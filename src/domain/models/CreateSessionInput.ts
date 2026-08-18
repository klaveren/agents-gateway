import { EProvider } from '../enums/EProvider'

export interface ICreateSessionInput {
  agentId: string
  model?: string
  systemPrompt?: string
  reasoning?: string
  language?: string
  metadata?: Record<string, any>
}
