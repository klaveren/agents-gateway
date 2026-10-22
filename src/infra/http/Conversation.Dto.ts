import { TClassification } from '@domain/models/Classification.Model'
import { IConversationPreview, IConversationSession, IConversationStats, IConversationTurn, IStoredUsage } from '@domain/models/Conversation.Model'
import { costOf, TModelPricing } from '@domain/models/Model.Pricing'

/**
 * Quem está lendo, para decidir o que sai: o dono da conversa vê a conversa; quem administra vê
 * também o que a operação sabe dela — o custo e o rótulo.
 */
export interface IConversationView {
  admin: boolean
  pricing: TModelPricing
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

  const costUsd = costOf(session.model, session.usage, view.pricing)

  return { ...dto, classification: session.classification, ...(costUsd === undefined ? {} : { costUsd }) }
}

export interface ITurnDto extends Omit<IConversationTurn, 'classification'> {
  /** Só para administrador. */
  classification?: TClassification
  /** Só para administrador. O modelo vem da conversa; sem preço, ausente. */
  costUsd?: number
}

export function toTurnDto(turn: IConversationTurn, model: string | undefined, view: IConversationView): ITurnDto {
  const { classification, ...rest } = turn
  if (!view.admin) return rest

  const costUsd = model && turn.usage ? costOf(model, turn.usage, view.pricing) : undefined

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
export function toStatsDto(stats: IConversationStats, pricing: TModelPricing): IStatsDto {
  const byModel: IStatsDto['byModel'] = stats.byModel.map((item) => {
    const costUsd = costOf(item.model, item.usage, pricing)

    return costUsd === undefined ? item : { ...item, costUsd }
  })

  return { ...stats, byModel, costUsd: byModel.reduce((total, item) => total + (item.costUsd ?? 0), 0) }
}
