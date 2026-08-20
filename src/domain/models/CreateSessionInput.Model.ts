import { EMode } from '../enums/EMode.Enum'

export interface ICreateSessionInput {
  agentId: string
  model?: string
  systemPrompt?: string
  reasoning?: string
  language?: string
  /** Lane de execução. Default: EMode.CHAT. */
  mode?: EMode
  /**
   * Só na lane `chat`: liga o loop de tools escrito à mão, sobre o SDK normal.
   *
   * Default `false`, que é conversa pura. Na lane `agent` quem manda nas tools é o
   * Agents SDK, então aqui o campo não se aplica.
   */
  tools?: boolean
  metadata?: Record<string, unknown>
}
