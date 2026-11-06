import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** As variáveis secretas só têm NOME e rótulo aqui: ⛔ o valor entra e nunca volta (nem para o admin). */
export interface ISecretMeta {
  scope: 'agent' | 'skill' | 'command'
  scopeId: string
  name: string
  description?: string
  /** Ausente quando ainda não há valor (o nome que a origem usa, num projeto que recebeu a skill compartilhada). */
  updatedAt?: string
  updatedBy?: string
  /** `false`: o projeto ainda não definiu o valor desta variável. */
  configured?: boolean
}

/**
 * As variáveis secretas por dono (só admin): a chave é o caminho-base (`/agents/<id>` ou `/resources/<id>`). A gravação
 * põe a resposta do servidor (só o rótulo) na lista, sem reler. ⛔ O `value` passa por aqui para o `PUT` e não fica
 * em nenhuma lista nem estado da store.
 */
export const useResourceSecretsStore = defineStore('resourceSecrets', () => {
  // A chave pode levar `?project=<projeto>` (os valores de skill/command são POR PROJETO): a rota vai depois de `/secrets`.
  const route = (basePath: string, name?: string) => {
    const [base = '', query] = basePath.split('?')
    return `${base}/secrets${name ? `/${encodeURIComponent(name)}` : ''}${query ? `?${query}` : ''}`
  }
  const lists = keyedResource((basePath) => api<ISecretMeta[]>(route(basePath)))
  const path = (basePath: string, name: string) => route(basePath, name)

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
