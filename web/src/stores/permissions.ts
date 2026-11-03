import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IPermissionDecision, IPermissionRule } from '@/lib/types'

/** As permissões de um projeto como o servidor as devolve: as regras dele e as do sistema (só leitura). */
export interface IProjectPermissions {
  rules: IPermissionRule[]
  system: IPermissionRule[]
  updatedAt?: string
  updatedBy?: string
}

/**
 * As permissões de cada projeto (só admin; a chave é o id do projeto). A gravação põe as regras salvas na store, sem
 * reler. ⚖️ As decisões são um registro que muda a cada ferramenta usada: lidas na hora, não guardadas.
 */
export const usePermissionsStore = defineStore('permissions', () => {
  const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/permissions`
  const projects = keyedResource((projectId) => api<IProjectPermissions>(path(projectId)))

  async function save(projectId: string, rules: IPermissionRule[]): Promise<IPermissionRule[]> {
    const saved = (await api<{ rules: IPermissionRule[] }>(path(projectId), { method: 'PUT', body: { rules } })).rules
    projects.update(projectId, (current) => ({ ...current, rules: saved }))
    return saved
  }

  /**
   * Acrescenta as regras que faltam e devolve quantas entraram. ⚠️ Lê de novo antes de gravar: a gravação troca a lista
   * INTEIRA, e uma cópia velha apagaria o que outra pessoa salvou depois.
   */
  async function addMissing(projectId: string, rules: IPermissionRule[]): Promise<number> {
    const current = (await projects.refresh(projectId)).rules
    const missing = rules.filter((rule) => !current.some((item) => item.category === rule.category && item.pattern === rule.pattern))
    if (missing.length) await save(projectId, [...current, ...missing])
    return missing.length
  }

  async function decisions(projectId: string, agentId?: string): Promise<IPermissionDecision[]> {
    return api<IPermissionDecision[]>(`${path(projectId)}/decisions`, { query: agentId ? { agentId } : {} })
  }

  return { projects, save, addMissing, decisions }
})
