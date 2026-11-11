import type { IStoredUsage } from './Conversation.Model'
import { PROJECT_METADATA_KEY } from '../Session.Metadata'
import type { IUsageQuery, IUsageRow } from './Usage.Model'

/**
 * 🔌 O USO DE UM GATEWAY CONECTADO: o gateway do dev usa o projeto desta instalação e manda para cá o que gastou nele —
 * por dia (UTC), conversa de lá, provedor e modelo. A conta é a dona do token de conexão (não a conta de lá).
 *
 * ⚖️ IDEMPOTENTE: a chave é da conversa de lá + dia + provedor + modelo; reenviar o mesmo dia SUBSTITUI a linha (o dia
 * cresce enquanto não acaba). A conversa de lá esta instalação não abre: entra no uso com a marca, sem link.
 */
export interface IRemoteUsageRow {
  key: string
  projectId: string
  userId: string
  email: string
  /** `YYYY-MM-DD`, em UTC. */
  day: string
  conversationId: string
  agentId: string
  provider: string
  model: string
  turns: number
  usage: IStoredUsage
}

/** O que o gateway de lá manda numa linha (o projeto e a conta vêm da conexão, nunca do corpo). */
export type TRemoteUsageInput = Omit<IRemoteUsageRow, 'key' | 'projectId' | 'userId' | 'email'>

export const REMOTE_USAGE_MAX_ROWS = 2000

/** A chave idempotente da linha. */
export const remoteUsageKey = (row: Pick<IRemoteUsageRow, 'conversationId' | 'day' | 'provider' | 'model'>) => `${row.conversationId}|${row.day}|${row.provider}|${row.model}`

/** O id da conversa de lá aqui: marcado, para nunca colidir com uma daqui (nem virar link). */
export const remoteConversationId = (projectId: string, conversationId: string) => `remote:${projectId}:${conversationId}`

/**
 * As linhas de lá como as daqui (`IUsageRow`), no recorte do pedido: o período, o dono, o filtro por `metadata` (só o
 * projeto existe numa linha de lá: outro filtro a exclui) e o agrupamento (só por projeto).
 */
export function remoteUsageRows(rows: readonly IRemoteUsageRow[], query: IUsageQuery): IUsageRow[] {
  const since = query.since.toISOString().slice(0, 10)
  return rows
    .filter((row) => row.day >= since)
    .filter((row) => (query.owner === undefined ? true : query.owner === null ? false : query.owner.id === row.userId))
    .filter((row) => Object.entries(query.metadata ?? {}).every(([key, value]) => key === PROJECT_METADATA_KEY && value === row.projectId))
    .map((row) => ({
      day: row.day,
      conversationId: remoteConversationId(row.projectId, row.conversationId),
      title: `conversa no gateway de ${row.email}`,
      ownerId: row.userId,
      ownerEmail: row.email,
      agentId: row.agentId,
      provider: row.provider,
      model: row.model,
      ...(query.groupBy === PROJECT_METADATA_KEY ? { group: row.projectId } : {}),
      turns: row.turns,
      usage: row.usage,
    }))
}
