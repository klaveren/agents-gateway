import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import { keyedResource } from '@/lib/resource'
import type { IResource, TImportIssueMatch, TResourceKind } from '@/lib/types'
import { issueMatch } from './docs'
import { useAgentCatalogStore } from './agentCatalog'

/** O corpo que a gravação manda (o `id` e o `kind` só ao criar). */
export type TResourceInput = Pick<IResource, 'description' | 'body' | 'tags'> & { projectId: string | null; docIds: string[]; docRefs: string[] }

/**
 * As skills e os commands (só admin): as listas por escopo (`lists`, a chave é `listKey(escopo, tipo?)`; a lista é SÓ
 * do escopo) e o recurso inteiro por id (`details`). A lista traz o recurso inteiro: a gravação troca, acrescenta ou
 * tira dela a resposta do servidor, sem reler.
 */
export const useResourcesStore = defineStore('resources', () => {
  const listKey = (scope: string, kind?: TResourceKind) => JSON.stringify([scope, kind ?? ''])
  const lists = keyedResource((key) => {
    const [project, kind] = JSON.parse(key) as [string, string]
    return api<IResource[]>('/resources', { query: { project, ...(kind ? { kind } : {}) } })
  })
  const details = keyedResource((id) => api<IResource>(`/resources/${encodeURIComponent(id)}`))

  /** Põe o recurso em `details` e nas listas lidas: sai de todas, entra nas do escopo e do tipo dele (pelo id, como o servidor ordena). */
  function put(resource: IResource): void {
    details.set(resource.id, resource)
    const scope = resource.projectId ?? GLOBAL_SCOPE
    for (const key of lists.keys()) {
      const [listScope, kind] = JSON.parse(key) as [string, string]
      const fits = listScope === scope && (!kind || kind === resource.kind)
      lists.update(key, (list) => {
        const others = list.filter((item) => item.id !== resource.id)
        return fits ? [...others, resource].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : others
      })
    }
    useAgentCatalogStore().invalidate()
  }

  async function create(input: TResourceInput & { id: string; kind: TResourceKind }): Promise<IResource> {
    const created = await api<IResource>('/resources', { method: 'POST', body: input })
    put(created)
    return created
  }

  async function update(id: string, input: TResourceInput): Promise<IResource> {
    const saved = await api<IResource>(`/resources/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
    put(saved)
    return saved
  }

  /** A guia Arquivos: grava só a lista (o resto fica). */
  async function saveFiles(id: string, files: IResource['files']): Promise<IResource> {
    const saved = await api<IResource>(`/resources/${encodeURIComponent(id)}/files`, { method: 'PUT', body: { files } })
    put(saved)
    return saved
  }

  /** "Resolvido" num problema da importação: a resposta entra em `details` e nas listas, sem reler. */
  async function resolveIssue(id: string, issue: TImportIssueMatch): Promise<IResource> {
    const saved = await api<IResource>(`/resources/${encodeURIComponent(id)}/import-issues/resolve`, { method: 'POST', body: issueMatch(issue) })
    put(saved)
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/resources/${encodeURIComponent(id)}`, { method: 'DELETE' })
    details.drop(id)
    for (const key of lists.keys()) lists.update(key, (list) => list.filter((item) => item.id !== id))
    useAgentCatalogStore().invalidate()
  }

  /** Restaurou uma versão (o histórico): relê o recurso e o põe nas listas; a versão de antes de existir o tira delas. */
  async function restored(id: string, exists: boolean): Promise<void> {
    if (!exists) {
      details.drop(id)
      for (const key of lists.keys()) lists.update(key, (list) => list.filter((item) => item.id !== id))
      return useAgentCatalogStore().invalidate()
    }
    put(await details.refresh(id))
  }

  return { lists, details, listKey, create, update, saveFiles, resolveIssue, remove, restored }
})
