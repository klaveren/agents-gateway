/**
 * A conversa como REGISTRO — o que sobrevive ao processo.
 *
 * ⚖️ POR QUE ISTO NÃO É O `ISessionRecord`. Aquele é o estado VIVO da sessão: carrega
 * `AbortController` e o `native` de cada SDK (runtime do ADK, session_id do CLI do Claude, itens do
 * @openai/agents). Nada disso serializa, e nada disso deveria sobreviver a um restart — sessão
 * interrompida no meio é sessão perdida, e tentar ressuscitá-la produziria um agente conversando
 * com um estado que o provider já esqueceu.
 *
 * O que precisa sobreviver é outra coisa: o que foi DITO, e quanto custou. Antes disto o gateway
 * não guardava nem em memória — `aggregateTurn` montava o turno para responder o JSON e descartava,
 * e a lane SSE nem por lá passava. Conversa terminada não existia em lugar nenhum.
 */

/**
 * Consumo gravado.
 *
 * ⚠️ `reasoningTokens` É CAMPO PRÓPRIO, não some dentro da saída. Ele é cobrado como token de
 * saída, o que torna tentador somá-lo ali — mas quem olha custo precisa saber quanto do gasto foi o
 * modelo PENSANDO, porque essa é a parte que muda ao trocar de modelo ou de nível de raciocínio.
 * Somado, o número fica certo e a informação se perde.
 */
export interface IStoredUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

/** Cabeçalho da conversa: com qual agente, com qual modelo, e o acumulado. */
export interface IConversationSession {
  id: string
  agentId: string
  provider: string
  mode: string
  model: string
  title?: string
  createdAt: Date
  updatedAt: Date
  turns: number
  usage: IStoredUsage
  /** Espaço para quem chama identificar o dono da conversa. O gateway não interpreta o conteúdo. */
  metadata?: Record<string, unknown>
}

/** Um turno: o que foi perguntado, o que foi respondido, e o que o agente fez no caminho. */
export interface IConversationTurn {
  sessionId: string
  index: number
  at: Date
  request: string
  text: string
  reasoning?: string
  toolCalls: Array<{ tool: string; args?: unknown; result?: unknown; error?: string }>
  usage?: IStoredUsage
  warnings?: string[]
  aborted?: boolean
  error?: string
}

/**
 * O retrato agregado das conversas.
 *
 * ⚖️ AGREGADO NO BANCO, não em quem lê. Uma listagem traz no máximo N conversas; somar em cima
 * disso daria um número que parece total e não é, e que muda de valor conforme a paginação. Erro
 * assim não se denuncia: o painel continua bonito, com o número errado.
 */
export interface IConversationStats {
  conversations: number
  turns: number
  usage: IStoredUsage
  /** Quanto cada modelo consumiu. É o que permite comparar custo ao trocar de modelo. */
  byModel: Array<{ provider: string; model: string; conversations: number; usage: IStoredUsage }>
}
