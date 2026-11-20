import { IMediaUsageEntry, mediaUsageRows } from './MediaUsage.Model'
import type { IUsageQuery, IUsageRow } from './Usage.Model'

/**
 * 🔊 O USO DA VOZ: cada fala que o gateway pediu ao provider (cache não conta: não custou) vira uma linha aqui, e o relatório de
 * Uso a lê como lê as conversas — o custo sai do preço do modelo no catálogo, na hora (nunca é gravado).
 *
 * ⚖️ Os tokens são os que o provider informou (DashScope); sem eles (OpenAI) ficam zero e o custo, se o modelo tem preço, é zero —
 * sem preço, "sem preço", como um modelo de conversa sem preço. Os caracteres ficam gravados para quem for estimar depois.
 */
export interface ISpeechUsageEntry extends IMediaUsageEntry {
  characters: number
}

/** O "agente" das linhas de voz no relatório: a tela o mostra como "Voz (mensagens)". */
export const SPEECH_USAGE_AGENT_ID = 'voice-messages'
/** O prefixo do id da "conversa" das linhas de voz: marcado, para nunca colidir com uma conversa (nem virar link). */
export const SPEECH_USAGE_CONVERSATION_PREFIX = 'speech:'

/**
 * As falas como linhas do relatório (`IUsageRow`), no recorte do pedido (ver `mediaUsageRows`): uma linha por dia, pessoa,
 * projeto, provider e modelo; `turns` = quantas falas.
 */
export function speechUsageRows(entries: readonly ISpeechUsageEntry[], query: IUsageQuery): IUsageRow[] {
  return mediaUsageRows(entries, query, { title: 'Voz (mensagens)', agentId: () => SPEECH_USAGE_AGENT_ID, conversationPrefix: SPEECH_USAGE_CONVERSATION_PREFIX })
}
