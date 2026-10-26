import { parseUsageKey } from '@domain/models/Session.Model'
import { TClassification } from '@domain/models/Classification.Model'
import { IConversationPreview, IConversationSession, IConversationStats, IConversationTurn, IStoredUsage } from '@domain/models/Conversation.Model'
import { costOf, TModelPricing } from '@domain/models/Model.Pricing'

/**
 * Quem está lendo, para decidir o que sai: o dono da conversa vê a conversa; quem administra vê
 * também o que a operação sabe dela — o custo e o rótulo.
 */
export interface IConversationView {
  admin: boolean
  /**
   * Os preços de um PROVIDER: o mesmo id de modelo pode custar outra coisa num compatível. Vem do
   * catálogo (manual, da listagem, de fábrica nos oficiais).
   */
  pricingOf(provider: string): TModelPricing
}

export interface IConversationDto {
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
  metadata?: Record<string, unknown>
  shared: boolean
  shareId?: string
  /** O último turno, encurtado. Conteúdo da própria conversa: sai para quem já pode lê-la. */
  preview?: IConversationPreview
  /** Só para administrador. */
  classification?: TClassification
  /** Só para administrador. Ausente quando o modelo não tem preço — nunca zero. */
  costUsd?: number
  /** Só para administrador. A conversa passou por algum modelo sem preço: `costUsd` é um PISO. */
  costIsFloor?: boolean
}

/**
 * ⛔ `costUsd` E `classification` SÓ SAEM PARA ADMINISTRADOR. O custo é o que a operação paga ao
 * fornecedor e o rótulo é o julgamento que a operação faz da conversa; nenhum dos dois é assunto de
 * quem lê a própria conversa. Lista explícita de campos: campo novo no registro nasce privado.
 */
export function toConversationDto(session: IConversationSession, view: IConversationView): IConversationDto {
  const dto: IConversationDto = {
    id: session.id,
    agentId: session.agentId,
    provider: session.provider,
    mode: session.mode,
    model: session.model,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: session.turns,
    usage: session.usage,
    metadata: session.metadata,
    shared: session.shared === true,
    shareId: session.shared ? session.shareId : undefined,
    preview: session.preview,
  }

  if (!view.admin) return dto

  const { costUsd, costIsFloor } = conversationCost(session, view.pricingOf)

  return { ...dto, classification: session.classification, ...(costUsd === undefined ? {} : { costUsd }), ...(costIsFloor ? { costIsFloor } : {}) }
}

/**
 * O custo da conversa: provider + modelo a provider + modelo quando ela registra o consumo assim (trocou
 * no meio, ou é recente), senão o modelo da conversa com o consumo inteiro — o cálculo de sempre. Cada
 * entrada é precificada pela tabela DO SEU provider (`parseUsageKey`): a chave antiga, só com o modelo, é
 * do provider da conversa.
 *
 * ⚠️ Modelo sem preço não vira zero: fica de fora e marca o total como piso.
 */
export function conversationCost(
  session: Pick<IConversationSession, 'provider' | 'model' | 'usage' | 'usageByModel'>,
  pricingOf: (provider: string) => TModelPricing,
): { costUsd?: number; costIsFloor?: boolean } {
  const entries = session.usageByModel && Object.keys(session.usageByModel).length ? Object.entries(session.usageByModel) : [[session.model, session.usage] as const]
  const costs = entries.map(([key, usage]) => {
    const { provider, model } = parseUsageKey(key, session.provider)
    return costOf(model, usage, pricingOf(provider))
  })
  const priced = costs.filter((cost): cost is number => cost !== undefined)
  if (!priced.length) return {}

  return { costUsd: priced.reduce((total, cost) => total + cost, 0), costIsFloor: priced.length < costs.length || undefined }
}

export interface ITurnDto extends Omit<IConversationTurn, 'classification'> {
  /** Só para administrador. */
  classification?: TClassification
  /** Só para administrador. O modelo é o do turno (ou o da conversa, nos antigos); sem preço, ausente. */
  costUsd?: number
}

export function toTurnDto(turn: IConversationTurn, conversation: { provider: string; model?: string }, view: IConversationView): ITurnDto {
  const { classification, ...rest } = turn
  if (!view.admin) return rest

  // O provider e o modelo do turno; nos antigos, os da conversa.
  const model = turn.model ?? conversation.model
  const costUsd = model && turn.usage ? costOf(model, turn.usage, view.pricingOf(turn.provider ?? conversation.provider)) : undefined

  return { ...rest, classification, ...(costUsd === undefined ? {} : { costUsd }) }
}

export interface IStatsDto extends IConversationStats {
  costUsd: number
  byModel: Array<IConversationStats['byModel'][number] & { costUsd?: number }>
}

/**
 * O retrato para o painel, com o custo somado.
 *
 * ⚠️ `costUsd` soma SÓ os modelos com preço: um modelo sem preço aparece sem custo, e fica de fora da
 * soma em vez de entrar como zero. O total é portanto um piso, não um valor exato, quando há modelo
 * sem preço — o que se vê em `byModel[].costUsd` ausente.
 */
export function toStatsDto(stats: IConversationStats, pricingOf: (provider: string) => TModelPricing): IStatsDto {
  const byModel: IStatsDto['byModel'] = stats.byModel.map((item) => {
    const costUsd = costOf(item.model, item.usage, pricingOf(item.provider))

    return costUsd === undefined ? item : { ...item, costUsd }
  })

  return { ...stats, byModel, costUsd: byModel.reduce((total, item) => total + (item.costUsd ?? 0), 0) }
}
