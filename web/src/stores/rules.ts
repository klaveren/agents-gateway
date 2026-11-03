import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { GLOBAL_SCOPE, scopeToProjectId } from '@/lib/guidance'
import { keyedResource } from '@/lib/resource'
import type { IRule } from '@/lib/types'
import { useAgentCatalogStore } from './agentCatalog'

/**
 * As rules (só admin), por escopo (`lists`, a chave é `global` ou o id do projeto; a lista é SÓ dele, na ordem do
 * prompt). A gravação põe a resposta do servidor na lista, sem reler: a rule nova vai para o fim, o `move` devolve a
 * lista já na ordem nova.
 */
export const useRulesStore = defineStore('rules', () => {
  const lists = keyedResource((scope) => api<IRule[]>('/rules', { query: { project: scope } }))
  const path = (id: string) => `/rules/${encodeURIComponent(id)}`
  const scopeOf = (rule: Pick<IRule, 'projectId'>) => rule.projectId ?? GLOBAL_SCOPE

  async function create(scope: string, input: { title: string; body: string }): Promise<IRule> {
    const created = await api<IRule>('/rules', { method: 'POST', body: { ...input, projectId: scopeToProjectId(scope) } })
    lists.update(scopeOf(created), (list) => [...list, created])
    useAgentCatalogStore().invalidate()
    return created
  }

  async function update(rule: IRule, change: Partial<Pick<IRule, 'title' | 'body' | 'enabled'>>): Promise<IRule> {
    const saved = await api<IRule>(path(rule.id), { method: 'PUT', body: change })
    lists.update(scopeOf(saved), (list) => list.map((item) => (item.id === saved.id ? saved : item)))
    useAgentCatalogStore().invalidate()
    return saved
  }

  async function move(rule: IRule, direction: 'up' | 'down'): Promise<void> {
    lists.set(scopeOf(rule), await api<IRule[]>(`${path(rule.id)}/move`, { method: 'POST', body: { direction } }))
    useAgentCatalogStore().invalidate()
  }

  async function remove(rule: IRule): Promise<void> {
    await api(path(rule.id), { method: 'DELETE' })
    lists.update(scopeOf(rule), (list) => list.filter((item) => item.id !== rule.id))
    useAgentCatalogStore().invalidate()
  }

  /** Restaurou uma versão (o histórico): relê as listas lidas — a rule voltou no fim (talvez de outro escopo), ou as vizinhas foram renumeradas. */
  async function restored(): Promise<void> {
    await lists.refreshLoaded()
    useAgentCatalogStore().invalidate()
  }

  return { lists, create, update, move, remove, restored }
})
