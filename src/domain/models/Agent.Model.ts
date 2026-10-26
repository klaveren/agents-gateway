import { EMode } from '../enums/EMode.Enum'

export interface IAgent {
  id: string
  name: string
  /**
   * Onde o agente roda: um ou mais providers, cada um com os seus modelos. O PRIMEIRO é o padrão.
   *
   * ⚖️ Vários, e não um: com API e assinatura configuradas, trocar de provider é trocar de modelo — a
   * conversa troca no meio (ver `AgentProvider.reconfigure`), sem editar o agente e voltar.
   */
  providers: IAgentTarget[]
  /**
   * QUEM o agente é: identidade, tom, valores, jeito de falar. ⚖️ Separado do `systemPrompt`, que diz O QUE
   * ele faz (função, regras): dá para ajustar a personalidade sem mexer nas regras, e vice-versa.
   */
  soul?: string
  systemPrompt: string
  /** Os níveis de raciocínio que o agente oferece. Cada provider usa os que o protocolo dele aceita. */
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

/** Um provider do agente e os modelos que ele usa ali. */
export interface IAgentTarget {
  /** O id do provider configurado. Os oficiais têm id igual ao protocolo (`claude`, `openai`, `google`). */
  provider: string
  models: string[]
}

export type TAgentRole = 'subagent'
export const AGENT_ROLES: readonly TAgentRole[] = ['subagent']
