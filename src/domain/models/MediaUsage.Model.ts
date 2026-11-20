import { PROJECT_METADATA_KEY } from '../Session.Metadata'
import type { IUsageQuery, IUsageRow } from './Usage.Model'

/**
 * 🎞️ O USO DE MÍDIA (voz e imagem): cada chamada que o gateway fez a um provider fora do turno de conversa vira uma entrada
 * e, no relatório, uma linha como as das conversas. O custo nunca é gravado: sai do preço do modelo no catálogo, na leitura.
 * Os tokens são os que o provider informou; sem eles ficam zero.
 */
export interface IMediaUsageEntry {
  at: Date
  /** Quem pediu (a conta). */
  userId: string
  /** O projeto da conversa; ausente = sem projeto. */
  projectId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface IMediaUsageLabel<T extends IMediaUsageEntry> {
  /** O título da "conversa" da linha. */
  title: string
  /** O "agente" da linha (a tela traduz os ids de mídia; o de uma imagem é o agente que a pediu). */
  agentId: (entry: T) => string
  /** O prefixo do id da "conversa": marcado, para nunca colidir com uma conversa (nem virar link). */
  conversationPrefix: string
}

/**
 * As entradas como linhas do relatório (`IUsageRow`), no recorte do pedido: o período, o dono (só pelo id), o filtro por
 * `metadata` (só o projeto existe aqui: outro filtro a exclui) e o agrupamento (só por projeto). Uma linha por dia, pessoa,
 * agente, projeto, provider e modelo; `turns` = quantas chamadas.
 */
export function mediaUsageRows<T extends IMediaUsageEntry>(entries: readonly T[], query: IUsageQuery, label: IMediaUsageLabel<T>): IUsageRow[] {
  const since = query.since.getTime()
  const rows = new Map<string, IUsageRow>()
  for (const entry of entries) {
    if (entry.at.getTime() < since) continue
    if (query.owner === null) continue
    if (query.owner !== undefined && query.owner.id !== entry.userId) continue
    if (!Object.entries(query.metadata ?? {}).every(([key, value]) => key === PROJECT_METADATA_KEY && value === entry.projectId)) continue

    const day = new Date(entry.at.getTime() + query.tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
    const agentId = label.agentId(entry)
    const key = [day, entry.userId, agentId, entry.projectId ?? '', entry.provider, entry.model].join('\u0000')
    const row =
      rows.get(key) ??
      rows
        .set(key, {
          day,
          conversationId: `${label.conversationPrefix}${entry.userId}`,
          title: label.title,
          ownerId: entry.userId,
          agentId,
          provider: entry.provider,
          model: entry.model,
          ...(query.groupBy === PROJECT_METADATA_KEY && entry.projectId ? { group: entry.projectId } : {}),
          turns: 0,
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        })
        .get(key)!
    row.turns += 1
    row.usage.inputTokens! += entry.inputTokens
    row.usage.outputTokens! += entry.outputTokens
    row.usage.totalTokens! += entry.totalTokens
  }
  return [...rows.values()]
}
