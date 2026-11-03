import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'

/** Um repositório do projeto (`repositories/<nome>`, com git) e as worktrees dele. */
export interface IProjectRepository {
  name: string
  worktrees: Array<{ name: string; branch?: string; path: string }>
}

/**
 * Os repositórios de cada projeto (`lists`, a chave é o id do projeto): onde a conversa pode abrir e o que o Importador
 * analisa. Uma leitura por projeto, para todas as telas.
 */
export const useRepositoriesStore = defineStore('repositories', () => {
  const lists = keyedResource((projectId) => api<IProjectRepository[]>(`/projects/${encodeURIComponent(projectId)}/repositories`))
  return { lists }
})
