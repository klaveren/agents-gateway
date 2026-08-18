import { EProvider } from '../enums/EProvider'

export interface IAgentSession {
  id: string
  provider: EProvider
  createdAt: Date
  metadata?: Record<string, unknown>
}
