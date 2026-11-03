import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import { keyedResource } from '@/lib/resource'
import type { IProjectDoc, TDocKind } from '@/lib/types'
import { useAgentCatalogStore } from './agentCatalog'

/** O corpo que a gravação manda (o `id` só ao criar). */
export type TDocInput = Pick<IProjectDoc, 'kind' | 'title' | 'summary' | 'body'> & { projectId: string | null; docIds: string[]; docRefs: string[] }

/**
 * Os documentos — specs, ADRs e estudos (só admin): as listas por escopo (`lists`, a chave é `listKey(escopo, tipo?)`;
 * o escopo é `global` ou o id do projeto, e a lista é SÓ dele) e o documento inteiro por id (`details`).
 *
 * ⚖️ A lista vem sem o corpo e com o que só o servidor calcula (o peso, quem carrega): a gravação põe o documento salvo
 * em `details` e relê só as listas do escopo dele (o de antes e o de agora), sem reler o resto.
 */
export const useDocsStore = defineStore('docs', () => {
  const listKey = (scope: string, kind?: TDocKind) => JSON.stringify([scope, kind ?? ''])
  const lists = keyedResource((key) => {
    const [project, kind] = JSON.parse(key) as [string, string]
    return api<IProjectDoc[]>('/docs', { query: { project, ...(kind ? { kind } : {}) } })
  })
  const details = keyedResource((id) => api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`))
  const scopeOf = (doc: Pick<IProjectDoc, 'projectId'>) => doc.projectId ?? GLOBAL_SCOPE

  /** Relê as listas já lidas destes escopos (todas as de tipo, inclusive). */
  async function refreshScopes(...scopes: string[]): Promise<void> {
    const touched = lists.keys().filter((key) => scopes.includes((JSON.parse(key) as [string])[0]))
    await Promise.all(touched.map((key) => lists.refresh(key).catch(() => undefined)))
  }

  async function create(input: TDocInput & { id: string }): Promise<IProjectDoc> {
    const created = await api<IProjectDoc>('/docs', { method: 'POST', body: input })
    details.set(created.id, created)
    useAgentCatalogStore().docsChanged()
    await refreshScopes(scopeOf(created))
    return created
  }

  async function update(id: string, input: TDocInput): Promise<IProjectDoc> {
    const before = details.get(id)
    const saved = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
    details.set(id, saved)
    useAgentCatalogStore().docsChanged()
    await refreshScopes(scopeOf(saved), ...(before ? [scopeOf(before)] : []))
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/docs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    details.drop(id)
    for (const key of lists.keys()) lists.update(key, (list) => list.filter((doc) => doc.id !== id))
    useAgentCatalogStore().docsChanged()
  }

  /** Restaurou uma versão (o histórico): relê o documento e as listas — o escopo pode ter mudado. */
  async function restored(id: string, exists: boolean): Promise<void> {
    if (exists) await details.refresh(id).catch(() => undefined)
    else details.drop(id)
    useAgentCatalogStore().docsChanged()
    await lists.refreshLoaded()
  }

  return { lists, details, listKey, create, update, remove, restored }
})
