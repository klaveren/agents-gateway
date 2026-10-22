import { EMode } from '../enums/EMode.Enum'

export interface IAgent {
  id: string
  name: string
  /** O id do provider configurado. Os oficiais têm id igual ao protocolo (`claude`, `openai`, `google`). */
  provider: string
  systemPrompt: string
  models: string[]
  reasoningEfforts?: string[]
  /** Lanes de execução suportadas por este agente. */
  modes: EMode[]
  allowedTools: string[]
}
