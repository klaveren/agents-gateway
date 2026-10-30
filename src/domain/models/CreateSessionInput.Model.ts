import { IAmbient } from '../Ambient.Policy'
import { EMode } from '../enums/EMode.Enum'

export interface ICreateSessionInput {
  /**
   * ⚖️ OPCIONAL. Qual agente atende é decisão de OPERAÇÃO — vem da configuração. Quem chama a API
   * direto para comparar dois providers continua podendo escolher, e aí a escolha dele ganha.
   */
  agentId?: string
  /** Um dos providers do agente. Ausente: o primeiro que oferece o `model` (ou o padrão do agente). */
  provider?: string
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
   * Quem pede é ADMINISTRADOR PROVADO — o que libera agente de assinatura (`subscriptionAdminOnly`) e
   * agente com ferramenta perigosa (`dangerousToolsAdminOnly`). Só a porta HTTP preenche; ausente = não é.
   */
  adminAccess?: boolean
  /**
   * A sessão nasce de uma DELEGAÇÃO (ver `DelegationService`) — o único caminho que abre um subagente.
   * A filha herda o `adminAccess` da conversa-mãe (`parentSessionId`), e nunca mais do que ela.
   * ⛔ Internos: o schema HTTP não aceita estes campos, e nenhum controller os repassa.
   */
  delegated?: boolean
  parentSessionId?: string
  /**
   * As rules e o índice de documentos da conversa (ver `GuidanceService.environmentFor`), que vão no system
   * prompt. ⛔ Interno: quem preenche é o `AgentProvider`, nunca o corpo da requisição.
   */
  environment?: string
  /**
   * O agente, o projeto e o diretório de operação da conversa (ver `Ambient.Policy`), que vão no system prompt como
   * "## Ambiente". ⛔ Interno: quem preenche é o `AgentProvider`, nunca o corpo da requisição.
   */
  ambient?: IAmbient
}
