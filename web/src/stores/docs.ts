import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import { keyedResource } from '@/lib/resource'
import type { IImportIssue, IProjectDoc, TDocKind, TImportIssueMatch } from '@/lib/types'
import { useAgentCatalogStore } from './agentCatalog'

/** O que o "resolvido" manda: o código e, para tirar só um, o alvo; ou `{ pending: true }` (todos os pendentes). */
export const issueMatch = (match: TImportIssueMatch) => ('pending' in match ? { pending: true } : { code: match.code, ...(match.target ? { target: match.target } : {}) })

/** Os PENDENTES: voltariam sozinhos com o alvo. O botão deles é "Descartar" (esquece o que guardavam). */
export const PENDING_ISSUE_CODES: readonly string[] = ['link-pending', 'skill-missing', 'command-missing', 'delegate-missing', 'mcp-missing']
export const isPendingIssue = (issue: Pick<IImportIssue, 'code'>) => PENDING_ISSUE_CODES.includes(issue.code)

/** O corpo que a gravação manda (o `id` só ao criar). */
export type TDocInput = Pick<IProjectDoc, 'kind' | 'title' | 'summary' | 'tags' | 'body' | 'status' | 'supersedes'> & {
  projectId: string | null
  docIds: string[]
  docRefs: string[]
}

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

  /** Salvar com `supersedes` muda o status e o `supersededBy` dos outros: o que estava em `details` deles já não vale. */
  function staleDetails(...groups: Array<string[] | undefined>): void {
    for (const id of groups.flatMap((group) => group ?? [])) details.drop(id)
  }

  async function create(input: TDocInput & { id: string }): Promise<IProjectDoc> {
    const created = await api<IProjectDoc>('/docs', { method: 'POST', body: input })
    details.set(created.id, created)
    staleDetails(created.supersedes)
    useAgentCatalogStore().docsChanged()
    await refreshScopes(scopeOf(created))
    return created
  }

  async function update(id: string, input: TDocInput): Promise<IProjectDoc> {
    const before = details.get(id)
    const saved = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}`, { method: 'PUT', body: input })
    details.set(id, saved)
    staleDetails(before?.supersedes, saved.supersedes)
    useAgentCatalogStore().docsChanged()
    await refreshScopes(scopeOf(saved), ...(before ? [scopeOf(before)] : []))
    return saved
  }

  /** A guia Compartilhar: grava a lista INTEIRA de projetos; a lista do dono troca só o `sharedWith` e as dos outros projetos (que recebem) são relidas. */
  async function share(id: string, projects: string[]): Promise<IProjectDoc> {
    const saved = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}/shares`, { method: 'PUT', body: { projects } })
    details.set(id, saved)
    for (const key of lists.keys()) lists.update(key, (list) => list.map((doc) => (doc.id === id ? { ...doc, sharedWith: saved.sharedWith } : doc)))
    const others = lists.keys().filter((key) => {
      const scope = (JSON.parse(key) as [string])[0]
      return scope !== GLOBAL_SCOPE && scope !== saved.projectId
    })
    await Promise.all(others.map((key) => lists.refresh(key).catch(() => undefined)))
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/docs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    details.drop(id)
    for (const key of lists.keys()) lists.update(key, (list) => list.filter((doc) => doc.id !== id))
    useAgentCatalogStore().docsChanged()
  }

  /** "Resolvido" (ou "Descartar") num problema da importação: o documento salvo em `details`, e a lista dele troca só os problemas. */
  async function resolveIssue(id: string, issue: TImportIssueMatch): Promise<IProjectDoc> {
    const saved = await api<IProjectDoc>(`/docs/${encodeURIComponent(id)}/import-issues/resolve`, { method: 'POST', body: issueMatch(issue) })
    details.set(id, saved)
    for (const key of lists.keys()) lists.update(key, (list) => list.map((doc) => (doc.id === id ? { ...doc, importIssues: saved.importIssues } : doc)))
    return saved
  }

  /** Restaurou uma versão (o histórico): relê o documento e as listas — o escopo pode ter mudado. */
  async function restored(id: string, exists: boolean): Promise<void> {
    if (exists) await details.refresh(id).catch(() => undefined)
    else details.drop(id)
    useAgentCatalogStore().docsChanged()
    await lists.refreshLoaded()
  }

  return { lists, details, listKey, create, update, resolveIssue, share, remove, restored }
})
