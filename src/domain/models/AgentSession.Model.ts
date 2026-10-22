import { EMode } from '../enums/EMode.Enum'

export interface IAgentSession {
  id: string
  provider: string
  mode: EMode
  createdAt: Date
  metadata?: Record<string, unknown>
}
