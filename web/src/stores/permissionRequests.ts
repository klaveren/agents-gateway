import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { type IPermissionRequest, requestsKey } from '@/lib/permissionRequests'
import { keyedResource } from '@/lib/resource'
import type { IPermissionRule } from '@/lib/types'

/**
 * Os pedidos de permissão dos agentes (só admin): os ABERTOS (pendentes e vencidos), por agente (`agent:<id>`), pelas
 * regras de um projeto (`project:<id>`) e de todos (`''`, o selo da lista de agentes; ver `requestsKey`). ⚖️ Aprovar e recusar põem a resposta em toda chave já lida, sem reler; o
 * pedido novo (feito por um agente numa conversa) chega pelo `catalog.changed` (ver `catalogSync`).
 */
export const usePermissionRequestsStore = defineStore('permissionRequests', () => {
  const lists = keyedResource((key) => {
    const [scope, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    if (scope === 'agent') return api<IPermissionRequest[]>(`/agents/${encodeURIComponent(id)}/permission-requests`)
    if (scope === 'project') return api<IPermissionRequest[]>(`/projects/${encodeURIComponent(id)}/permission-requests`)
    return api<IPermissionRequest[]>('/permission-requests')
  })

  /** Troca o pedido (ou o tira, se não está mais aberto) em toda lista lida. */
  function put(request: IPermissionRequest): void {
    const open = request.status === 'pending' || request.status === 'expired'
    const own = request.agentId ? requestsKey({ agentId: request.agentId }) : requestsKey({ projectId: request.projectId })
    for (const key of lists.keys()) {
      if (key && key !== own) continue
      lists.update(key, (current) => (open ? current.map((item) => (item.id === request.id ? request : item)) : current.filter((item) => item.id !== request.id)))
    }
  }

  /**
   * ⛔ Aprovar: só passa pela sessão da tela (o cookie). `confirm` = as chaves de `widenings`, todas. `value` é o valor
   * digitado de um pedido `secret` (só ele leva; não fica na store).
   */
  async function approve(id: string, confirm: string[], value?: string): Promise<{ request: IPermissionRequest; permissions?: IPermissionRule[] }> {
    const result = await api<{ request: IPermissionRequest; permissions?: IPermissionRule[] }>(`/permission-requests/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: value === undefined ? { confirm } : { confirm, value },
    })
    put(result.request)
    return result
  }

  async function reject(id: string, note?: string): Promise<IPermissionRequest> {
    const request = await api<IPermissionRequest>(`/permission-requests/${encodeURIComponent(id)}/reject`, { method: 'POST', body: note ? { note } : {} })
    put(request)
    return request
  }

  /** O servidor recalculou as ampliações (o agente mudou no meio): a lista nova entra no pedido, para confirmar de novo. */
  function recomputed(id: string, widenings: IPermissionRequest['widenings']): void {
    for (const key of lists.keys()) lists.update(key, (current) => current.map((item) => (item.id === id ? { ...item, widenings, changed: true } : item)))
  }

  return { lists, approve, reject, recomputed }
})
