import { EProvider } from '../enums/EProvider'

export interface IAgent {
  id: string
  name: string
  provider: EProvider
  systemPrompt: string
  models: string[]
  reasoningEfforts?: string[]
  allowedTools: string[]
}
