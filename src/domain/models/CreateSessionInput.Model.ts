import { EMode } from '../enums/EMode.Enum'

export interface ICreateSessionInput {
  /**
   * ⚖️ OPCIONAL. Qual agente atende é decisão de OPERAÇÃO — vem da configuração. Quem chama a API
   * direto para comparar dois providers continua podendo escolher, e aí a escolha dele ganha.
   */
  agentId?: string
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
  /**
   * Quem pede pode usar agente de ASSINATURA (ver `subscriptionAdminOnly`). Só a porta HTTP preenche,
   * com o papel PROVADO do chamador; ausente = não pode, quando a regra está ligada.
   */
  subscriptionAccess?: boolean
}
