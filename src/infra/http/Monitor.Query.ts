import { CLASSIFICATIONS, TClassification } from '@domain/models/Classification.Model'
import { IConversationPageQuery } from '@domain/models/Conversation.Model'

export const PAGE_SIZE_DEFAULT = 10
export const PAGE_SIZE_MAX = 50
export const SEARCH_MAX = 100

/**
 * Query da página do monitor → recorte validado.
 *
 * ⚖️ O que não serve vira o padrão, em vez de erro: é uma tela de leitura, e uma `page=abc` vinda de
 * um link antigo deve abrir a primeira página, não uma mensagem de falha. O teto de `pageSize` é o
 * que impede um `pageSize=100000` de trazer o banco inteiro de volta numa chamada só.
 *
 * ⚠️ `classification` desconhecida é IGNORADA (e não vira "nenhum resultado"): um filtro que some
 * alarga a lista, o que é o erro mais visível dos dois. `provider` e `agentId` só aceitam identificador simples.
 */
export function parsePageQuery(query: Record<string, unknown>): IConversationPageQuery {
  const int = (value: unknown) => Number.parseInt(String(value ?? ''), 10)

  const page = int(query.page)
  const pageSize = int(query.pageSize)
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, SEARCH_MAX) : ''
  const classification = CLASSIFICATIONS.includes(query.classification as TClassification) ? (query.classification as TClassification) : undefined
  const provider = typeof query.provider === 'string' && /^[a-z0-9_-]{1,40}$/i.test(query.provider) ? query.provider : undefined
  const agentId = typeof query.agentId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(query.agentId) ? query.agentId : undefined

  return {
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize >= 1 ? Math.min(pageSize, PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT,
    q: q || undefined,
    classification,
    provider,
    agentId,
  }
}

/**
 * O resto da query vira filtro sobre `metadata`, sem as chaves que são da própria rota ou do dono.
 *
 * ⛔ AS CHAVES `owner*` SÃO DESCARTADAS. O dono vem da credencial; deixar a query escolher
 * `?owner=<outro>` seria declarar de quem a conversa é. Só valor de texto passa: array e objeto
 * (`a[b]=1`) não são rótulo.
 */
export function metadataFilter(query: Record<string, unknown>, reserved: readonly string[] = []): Record<string, string> | undefined {
  const skip = new Set(['limit', 'scope', ...reserved])
  const entries = Object.entries(query).filter(([key, value]) => !skip.has(key) && !key.toLowerCase().startsWith('owner') && typeof value === 'string')

  return entries.length ? Object.fromEntries(entries as Array<[string, string]>) : undefined
}
