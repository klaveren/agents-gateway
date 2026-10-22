import { IConversationSession } from '@domain/models/Conversation.Model'

/**
 * O que muda numa conversa gravada, para quem está olhando a lista.
 *
 * ⚖️ `updated` leva o CABEÇALHO INTEIRO, já relido do banco: quem escuta troca a linha sem ir buscar
 * de novo, e não há janela em que a lista mostre um estado que o banco não tem. `deleted` leva o
 * `metadata` de antes de apagar — é ele que diz de quem era, e depois de apagar não há onde ler.
 */
export type TConversationEvent =
  { type: 'conversation.updated'; session: IConversationSession } | { type: 'conversation.deleted'; sessionId: string; metadata?: Record<string, unknown> }

/**
 * Por onde as mudanças passam. Em processo: um gateway, um barramento.
 *
 * ⛔ NÃO FILTRA POR DONO. Entrega tudo a quem assinou; quem repassa para fora (a rota SSE) decide o
 * que cada chamador pode ver, com a mesma regra da listagem.
 */
export interface IConversationEvents {
  publish(event: TConversationEvent): void
  /** Devolve quem cancela a assinatura. */
  subscribe(listener: (event: TConversationEvent) => void): () => void
}
