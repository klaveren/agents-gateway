import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** As variáveis secretas só têm NOME e rótulo aqui: ⛔ o valor entra e nunca volta (nem para o admin). */
export interface ISecretMeta {
  scope: 'agent' | 'skill' | 'command'
  scopeId: string
  name: string
  description?: string
  updatedAt: string
  updatedBy?: string
}

/**
 * As variáveis secretas por dono (só admin): a chave é o caminho-base (`/agents/<id>` ou `/resources/<id>`). A gravação
 * põe a resposta do servidor (só o rótulo) na lista, sem reler. ⛔ O `value` passa por aqui para o `PUT` e não fica
 * em nenhuma lista nem estado da store.
 */
export const useResourceSecretsStore = defineStore('resourceSecrets', () => {
  const lists = keyedResource((basePath) => api<ISecretMeta[]>(`${basePath}/secrets`))
  const path = (basePath: string, name: string) => `${basePath}/secrets/${encodeURIComponent(name)}`

  /** Grava (cria ou troca): `value` ausente só muda a descrição. ⛔ Só pela sessão da tela: o servidor responde 403 no resto. */
  async function save(basePath: string, name: string, change: { value?: string; description?: string }): Promise<ISecretMeta> {
    const meta = await api<ISecretMeta>(path(basePath, name), { method: 'PUT', body: change })
    lists.update(basePath, (list) => {
      const rest = list.filter((one) => one.name !== meta.name)
      return [...rest, meta].sort((a, b) => a.name.localeCompare(b.name))
    })
    return meta
  }

  async function remove(basePath: string, name: string): Promise<void> {
    await api(path(basePath, name), { method: 'DELETE' })
    lists.update(basePath, (list) => list.filter((one) => one.name !== name))
  }

  return { lists, save, remove }
})
