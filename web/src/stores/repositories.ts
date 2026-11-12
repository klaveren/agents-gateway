import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** Um repositório do projeto (`repositories/<nome>`, com git) e as worktrees dele. */
export interface IProjectRepository {
  name: string
  /** A branch da pasta principal. */
  branch?: string
  /** O remoto `origin`, sem credencial. Ausente: git local, sem remoto. */
  origin?: string
  /** O clone ainda está em curso: a pasta ainda não serve a uma conversa. */
  cloning?: boolean
  worktrees: Array<{ name: string; branch?: string; path: string }>
}

/** Com `url`, clona (a `account` é a conta de git do projeto); sem ela, cria um git local, sem remoto, com o `name`. */
export interface IRepositoryInput {
  url?: string
  name?: string
  account?: string
  branch?: string
}

/**
 * Os repositórios de cada projeto (`lists`, a chave é o id do projeto): onde a conversa pode abrir e o que o Importador
 * analisa. Uma leitura por projeto, para todas as telas. Criar devolve o repositório, que entra na lista pelo nome;
 * remover o tira — sem reler.
 */
export const useRepositoriesStore = defineStore('repositories', () => {
  const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/repositories`
  const lists = keyedResource((projectId) => api<IProjectRepository[]>(base(projectId)))

  /** ⚠️ O clone responde só quando acaba (minutos, num repositório grande). */
  async function add(projectId: string, input: IRepositoryInput): Promise<IProjectRepository> {
    const created = await api<IProjectRepository>(base(projectId), { method: 'POST', body: input })
    lists.update(projectId, (list) => [...list.filter((item) => item.name !== created.name), created].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    return created
  }

  /** `kept`: as worktrees que ficaram no disco (as de fora de `repositories/`). */
  async function remove(projectId: string, name: string): Promise<{ kept: string[] }> {
    const result = await api<{ kept: string[] }>(`${base(projectId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    lists.update(projectId, (list) => list.filter((item) => item.name !== name))
    return result
  }

  return { lists, add, remove }
})
