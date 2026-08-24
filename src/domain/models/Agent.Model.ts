import { EProvider } from '../enums/EProvider.Enum'
import { EMode } from '../enums/EMode.Enum'

export interface IAgent {
  id: string
  name: string
  provider: EProvider
  systemPrompt: string
  models: string[]
  reasoningEfforts?: string[]
  /** Lanes de execução suportadas por este agente. */
  modes: EMode[]
  allowedTools: string[]
}
