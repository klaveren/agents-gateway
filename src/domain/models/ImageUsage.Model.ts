import { IMediaUsageEntry, mediaUsageRows } from './MediaUsage.Model'
import type { IUsageQuery, IUsageRow } from './Usage.Model'

/**
 * 🖼️ O USO DAS IMAGENS: cada imagem que o `generate_image` gerou com sucesso vira uma entrada, e o relatório de Uso a lê como
 * lê as conversas (ver `MediaUsage.Model`). O custo sai do preço do modelo no catálogo, na leitura.
 *
 * ⚖️ QUEM CONTA: a pessoa dona da conversa (é o teto dela que a imagem consome) e o projeto da conversa. O AGENTE da linha é o
 * que pediu a imagem — o custo aparece sob ele, junto do das conversas; sem agente (não deveria), "Imagens".
 */
export interface IImageUsageEntry extends IMediaUsageEntry {
  /** O agente que pediu a imagem; ausente = sem agente. */
  agentId?: string
}

/** O "agente" das linhas de imagem sem agente: a tela o mostra como "Imagens". */
export const IMAGE_USAGE_AGENT_ID = 'image-generation'
/** O prefixo do id da "conversa" das linhas de imagem: marcado, para nunca colidir com uma conversa (nem virar link). */
export const IMAGE_USAGE_CONVERSATION_PREFIX = 'image:'

export function imageUsageRows(entries: readonly IImageUsageEntry[], query: IUsageQuery): IUsageRow[] {
  return mediaUsageRows(entries, query, { title: 'Imagens', agentId: (entry) => entry.agentId ?? IMAGE_USAGE_AGENT_ID, conversationPrefix: IMAGE_USAGE_CONVERSATION_PREFIX })
}
