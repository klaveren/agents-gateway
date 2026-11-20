import type { IUsageQuery, IUsageRow } from './Usage.Model'
import { PROJECT_METADATA_KEY } from '../Session.Metadata'

/**
 * 🔊 O USO DA VOZ: cada fala que o gateway pediu ao provider (cache não conta: não custou) vira uma linha aqui, e o relatório de
 * Uso a lê como lê as conversas — o custo sai do preço do modelo no catálogo, na hora (nunca é gravado).
 *
 * ⚖️ Os tokens são os que o provider informou (DashScope); sem eles (OpenAI) ficam zero e o custo, se o modelo tem preço, é zero —
 * sem preço, "sem preço", como um modelo de conversa sem preço. Os caracteres ficam gravados para quem for estimar depois.
 */
export interface ISpeechUsageEntry {
  at: Date
  /** Quem ouviu (a conta). */
  userId: string
  /** O projeto da mensagem; ausente = sem projeto (o "Testar" do Perfil). */
  projectId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  characters: number
}

/** O "agente" das linhas de voz no relatório: a tela o mostra como "Voz (mensagens)". */
export const SPEECH_USAGE_AGENT_ID = 'voice-messages'
/** O prefixo do id da "conversa" das linhas de voz: marcado, para nunca colidir com uma conversa (nem virar link). */
export const SPEECH_USAGE_CONVERSATION_PREFIX = 'speech:'

/**
 * As falas como linhas do relatório (`IUsageRow`), no recorte do pedido: o período, o dono (só pelo id), o filtro por
 * `metadata` (só o projeto existe numa fala: outro filtro a exclui) e o agrupamento (só por projeto). Uma linha por dia, pessoa,
 * projeto, provider e modelo; `turns` = quantas falas.
 */
export function speechUsageRows(entries: readonly ISpeechUsageEntry[], query: IUsageQuery): IUsageRow[] {
  const since = query.since.getTime()
  const rows = new Map<string, IUsageRow>()
  for (const entry of entries) {
    if (entry.at.getTime() < since) continue
    if (query.owner === null) continue
    if (query.owner !== undefined && query.owner.id !== entry.userId) continue
    if (!Object.entries(query.metadata ?? {}).every(([key, value]) => key === PROJECT_METADATA_KEY && value === entry.projectId)) continue

    const day = new Date(entry.at.getTime() + query.tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
    const conversationId = `${SPEECH_USAGE_CONVERSATION_PREFIX}${entry.userId}`
    const key = [day, entry.userId, entry.projectId ?? '', entry.provider, entry.model].join('\u0000')
    const row =
      rows.get(key) ??
      rows
        .set(key, {
          day,
          conversationId,
          title: 'Voz (mensagens)',
          ownerId: entry.userId,
          agentId: SPEECH_USAGE_AGENT_ID,
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
