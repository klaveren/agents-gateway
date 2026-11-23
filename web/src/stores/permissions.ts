import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IPermissionDecision, IPermissionRule, TPermissionCategory } from '@/lib/types'

/** Uma regra que o servidor aceitou mas que não tem efeito, e por quê. */
export interface IRuleWarning {
  category: TPermissionCategory
  pattern: string
  code: string
  message: string
}

/** As permissões de um projeto como o servidor as devolve: as regras dele e as do sistema (só leitura). */
export interface IProjectPermissions {
  rules: IPermissionRule[]
  /** As regras aceitas que não valem (ex.: a porta do próprio gateway com o alcance desligado), com o motivo. */
  warnings?: IRuleWarning[]
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
    const answer = await api<{ rules: IPermissionRule[]; warnings?: IRuleWarning[] }>(path(projectId), { method: 'PUT', body: { rules } })
    projects.update(projectId, (current) => ({ ...current, rules: answer.rules, warnings: answer.warnings ?? [] }))
    return answer.rules
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

  /** As últimas decisões, das mais novas: de uma categoria (a guia aberta) e, se pedido, de um agente só. */
  async function decisions(projectId: string, filter: { agentId?: string; category?: TPermissionCategory } = {}): Promise<IPermissionDecision[]> {
    return api<IPermissionDecision[]>(`${path(projectId)}/decisions`, {
      query: { ...(filter.agentId ? { agentId: filter.agentId } : {}), ...(filter.category ? { category: filter.category } : {}) },
    })
  }

  /** Os avisos de regras ainda não salvas (o formulário do agente): "sem efeito", com o motivo. */
  async function warnings(rules: IPermissionRule[]): Promise<IRuleWarning[]> {
    const answer = await api<{ warnings: IRuleWarning[] }>('/permissions/warnings', { method: 'POST', body: { rules } })
    return answer.warnings
  }

  return { projects, save, addMissing, decisions, warnings }
})
