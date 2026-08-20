import { EMode } from '../enums/EMode.Enum'

export interface ICreateSessionInput {
  agentId: string
  model?: string
  systemPrompt?: string
  reasoning?: string
  language?: string
  /** Lane de execução. Default: EMode.CHAT. */
  mode?: EMode
  metadata?: Record<string, unknown>
}
