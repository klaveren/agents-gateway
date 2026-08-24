import { EProvider } from '../enums/EProvider.Enum'
import { EMode } from '../enums/EMode.Enum'

export interface IAgentSession {
  id: string
  provider: EProvider
  mode: EMode
  createdAt: Date
  metadata?: Record<string, unknown>
}
