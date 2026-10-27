/**
 * Um PROJETO: agentes, conversas e (depois) skills, rules e specs vivem dentro de um, com a sua pasta
 * (`<dados>/projects/<id>/`). ⚖️ Vários projetos isolados no mesmo gateway, cada um com as suas
 * particularidades. Modelos, MCPs e pacotes são do sistema e valem para todos.
 */
export interface IProject {
  id: string
  name: string
  description?: string
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

export interface IProjectMember {
  projectId: string
  userId: string
  addedAt: Date
  addedBy?: string
}

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
/** O projeto que a migração cria para o que existia antes dos projetos. */
export const DEFAULT_PROJECT_ID = 'geral'
