import { EMode } from '../enums/EMode.Enum'

export interface IAgent {
  id: string
  name: string
  /** O id do provider configurado. Os oficiais têm id igual ao protocolo (`claude`, `openai`, `google`). */
  provider: string
  /**
   * QUEM o agente é: identidade, tom, valores, jeito de falar. ⚖️ Separado do `systemPrompt`, que diz O QUE
   * ele faz (função, regras): dá para ajustar a personalidade sem mexer nas regras, e vice-versa.
   */
  soul?: string
  systemPrompt: string
  models: string[]
  reasoningEfforts?: string[]
  /** Lanes de execução suportadas por este agente. */
  modes: EMode[]
  allowedTools: string[]
  /**
   * `subagent`: só é chamado por OUTRO agente (`delegate_to_agent`, via `agent:<id>`) e nunca abre
   * conversa direta — nem pela tela, nem pela API, nem pelo MCP. Ausente = agente normal.
   */
  role?: TAgentRole
}

export type TAgentRole = 'subagent'
export const AGENT_ROLES: readonly TAgentRole[] = ['subagent']
