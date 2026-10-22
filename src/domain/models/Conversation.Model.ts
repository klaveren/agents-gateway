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

import { TClassification } from './Classification.Model'

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
  /**
   * ⚠️ O CACHE É PARCELA DA ENTRADA, não soma a ela. `inputTokens` é a entrada inteira, e o
   * `totalTokens` não os soma de novo. A entrada nova, sem cache, é
   * `inputTokens - cacheReadTokens - cacheWriteTokens`.
   *
   * ⚖️ Separados porque o preço é outro: leitura de cache custa uma fração da entrada, e gravação
   * (em alguns providers) custa mais que ela. Quem não informa um dos dois grava zero.
   */
  cacheReadTokens?: number
  cacheWriteTokens?: number
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
  /**
   * A PIOR classificação entre os turnos desta conversa.
   *
   * ⚠️ Pior, não a mais recente nem a mais comum (ver `worstOf`). Só é escrita por `classifyTurn`:
   * `saveSession` regrava o cabeçalho a cada turno e não a toca.
   */
  classification?: TClassification
  usage: IStoredUsage
  /**
   * O consumo por modelo, quando a conversa trocou de modelo no meio (ou foi gravada depois disto).
   * ⚖️ Ausente nas conversas antigas: aí vale `model` + `usage`, como sempre.
   */
  usageByModel?: Record<string, IStoredUsage>
  /** Espaço para quem chama identificar o dono da conversa. O gateway não interpreta o conteúdo. */
  metadata?: Record<string, unknown>
  /**
   * A conversa está aberta por link, para quem não tem credencial.
   *
   * ⚠️ AUSENTE É FECHADO. Registro gravado antes deste campo existir não o tem e continua privado —
   * um padrão que abrisse tornaria público o histórico inteiro na primeira atualização. Só é escrito
   * por `setShared`; `saveSession` não o toca.
   */
  shared?: boolean
  /**
   * O identificador do LINK público — separado do `id` da sessão de propósito.
   *
   * ⚖️ O `id` da sessão carrega o prefixo do provider (`google-agent-…`): infra vazando para uma URL
   * que uma pessoa vê e cola. O `shareId` é curto, sem prefixo, e ESTÁVEL: gerado no primeiro
   * compartilhamento e reusado, para o link não trocar a cada vez que se liga e desliga.
   */
  shareId?: string
  /**
   * O último turno, encurtado — o que a caixa de entrada mostra na linha.
   *
   * ⚖️ LIDO DO TURNO, não guardado no cabeçalho: uma coluna a mais seria uma segunda cópia para manter
   * em dia a cada gravação, e a primeira que divergisse mostraria na lista uma frase que a conversa
   * não tem. Ausente quando a conversa ainda não tem turno.
   */
  preview?: IConversationPreview
}

export const PREVIEW_MAX = 160

export interface IConversationPreview {
  at: Date
  /** Até `PREVIEW_MAX` caracteres de cada lado. */
  request: string
  text: string
}

/** Um turno: o que foi perguntado, o que foi respondido, e o que o agente fez no caminho. */
export interface IConversationTurn {
  sessionId: string
  index: number
  at: Date
  request: string
  /** O que veio anexado à pergunta — só o descritivo; o conteúdo (base64) nunca é gravado. */
  files?: Array<{ name: string; mimeType: string; size: number }>
  text: string
  reasoning?: string
  /** O modelo que respondeu ESTE turno. Ausente nos antigos: vale o da conversa. */
  model?: string
  /** O nível de raciocínio pedido neste turno (o `reasoning` acima é o TEXTO do raciocínio). */
  effort?: string
  toolCalls: Array<{ tool: string; args?: unknown; result?: unknown; error?: string }>
  usage?: IStoredUsage
  /** Do envio da pergunta ao último evento do turno, em ms — o tempo que a pessoa esperou. */
  durationMs?: number
  /** Do envio ao primeiro pedaço de texto da resposta, em ms. Ausente quando não houve texto. */
  firstTextMs?: number
  warnings?: string[]
  aborted?: boolean
  error?: string
  /** Como este turno foi rotulado. Ausente enquanto ninguém classificou (ou a classificação falhou). */
  classification?: TClassification
}

/**
 * O que um link público mostra — e, sobretudo, o que ele NÃO mostra.
 *
 * ⛔ NÃO É O REGISTRO. Um `IConversationTurn` carrega `toolCalls[].args` e `.result`, que são os
 * RETORNOS CRUS das ferramentas (dado de cliente, de pedido, de conta), o `reasoning` do modelo, os
 * anexos e a `classification` — o rótulo interno que julga a conversa. Nada disso é assunto de quem
 * abre um link. O `metadata` também fica de fora: é onde mora a identidade do dono.
 *
 * ⚖️ ESTA FUNÇÃO É A REGRA, e mora no domínio em vez do controller de propósito: rota nova que
 * exponha conversa passa por aqui, ou repete a decisão — e a segunda cópia é a que esquece um campo.
 * Lista explícita de campos, nunca spread: campo novo no registro nasce PRIVADO.
 *
 * ⚠️ O QUE ELA NÃO RESOLVE: a resposta do agente é texto corrido e pode citar dado da conta. Nenhuma
 * projeção limpa isso. Compartilhar é ato deliberado de quem já podia ler — cabe à tela avisar.
 */
export interface ISharedConversation {
  /** O `shareId`, nunca o id interno da sessão. */
  id: string
  title?: string
  createdAt: Date
  turns: Array<{ at: Date; request: string; text: string }>
}

export function toSharedConversation(session: IConversationSession & { shareId: string }, turns: IConversationTurn[]): ISharedConversation {
  return {
    id: session.shareId,
    title: session.title,
    createdAt: session.createdAt,
    turns: turns.map((turn) => ({ at: turn.at, request: turn.request, text: turn.text })),
  }
}

/** Quem é dono: o que `metadata.owner` guarda. Conta, quando existe, tem de bater também. */
export interface IOwnerFilter {
  id: string
  account?: string
}

/** Recorte de uma página do monitor. Os filtros são todos opcionais e se somam. */
export interface IConversationPageQuery {
  /** 1 em diante. */
  page: number
  pageSize: number
  /** Trecho do título, do e-mail, do id ou da conta do dono — sem diferenciar caixa (ASCII). */
  q?: string
  classification?: TClassification
  provider?: string
  agentId?: string
}

/**
 * Uma página de conversas, com o total e as contagens que sustentam as abas.
 *
 * ⚖️ `facets` é contado sobre a BUSCA, não sobre a aba: com a aba "red" aberta, a aba "amber"
 * continua dizendo quantas há. Contar sobre a página daria um número que muda ao paginar.
 */
export interface IConversationPage {
  sessions: IConversationSession[]
  total: number
  facets: { classification: Record<string, number>; provider: Record<string, number>; agent: Record<string, number> }
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
  /** Pessoas distintas, pelo `metadata.owner.id`. Conversa sem dono não conta. */
  users: number
  /** Contas distintas, pelo `metadata.owner.account`. */
  accounts: number
  usage: IStoredUsage
  /** Quanto cada modelo consumiu. É o que permite comparar custo ao trocar de modelo. */
  byModel: Array<{ provider: string; model: string; conversations: number; usage: IStoredUsage }>
  /** Quantas conversas em cada sinal. Chave ausente = nenhuma. */
  byClassification: Record<string, number>
}
