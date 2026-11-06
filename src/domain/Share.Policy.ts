import type { TDocKind } from './models/ProjectDoc.Model'
import type { TResourceKind } from './models/Resource.Model'

/**
 * ⛔ O COMPARTILHAMENTO ENTRE PROJETOS. O dono de uma skill, de um command, de uma spec ou de um conhecimento deixa
 * outro projeto USÁ-LO, só para leitura: o item continua do projeto de origem, que é o único que o mantém (editar,
 * apagar, os arquivos). Quem compartilha administra os DOIS projetos (a regra fica no controller, ver `Project.Access`).
 *
 * Rules e ADRs não se compartilham: são as decisões e as travas de UM projeto. O global não precisa: já vale para todos.
 * Segredo não vai junto: cada projeto que usa a skill configura os valores dele, com os mesmos nomes.
 */
export const SHAREABLE_RESOURCE_KINDS: readonly TResourceKind[] = ['skill', 'command']
export const SHAREABLE_DOC_KINDS: readonly TDocKind[] = ['spec', 'knowledge']

/** Teto de projetos por item: a lista vai numa coluna e na tela inteira. */
export const SHARE_MAX_PROJECTS = 100

interface IShareable {
  kind: string
  projectId?: string
  sharedWith?: readonly string[]
}

/** O item vale neste projeto: é global, é do projeto ou foi compartilhado com ele. */
export function visibleIn(item: Pick<IShareable, 'projectId' | 'sharedWith'>, projectId: string | undefined): boolean {
  if (!item.projectId) return true
  return !!projectId && (item.projectId === projectId || !!item.sharedWith?.includes(projectId))
}

/** O item chegou a este projeto por compartilhamento (não é dele nem global): só leitura aqui. */
export function sharedInto(item: Pick<IShareable, 'projectId' | 'sharedWith'>, projectId: string | undefined): boolean {
  return !!projectId && !!item.projectId && item.projectId !== projectId && !!item.sharedWith?.includes(projectId)
}

/** A lista nova de projetos, sem repetição, na ordem dada. */
export function normalizeShares(projects: readonly string[]): string[] {
  return [...new Set(projects.map((project) => project.trim()).filter(Boolean))]
}

/** O que impede compartilhar o item com estes projetos (vazio = pode). `exists`: o projeto existe. */
export function shareIssues(item: IShareable, projects: readonly string[], exists: (projectId: string) => boolean): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  const shareable = (SHAREABLE_RESOURCE_KINDS as readonly string[]).includes(item.kind) || (SHAREABLE_DOC_KINDS as readonly string[]).includes(item.kind)
  if (!shareable) issues.push({ field: 'projects', message: `a ${item.kind} is not shared (only skills, commands, specs and knowledge)` })
  if (!item.projectId && projects.length) issues.push({ field: 'projects', message: 'a global item already serves every project' })
  if (projects.length > SHARE_MAX_PROJECTS) issues.push({ field: 'projects', message: `at most ${SHARE_MAX_PROJECTS} projects` })
  for (const project of projects) {
    if (project === item.projectId) issues.push({ field: 'projects', message: `${project} is the project of the item` })
    else if (!exists(project)) issues.push({ field: 'projects', message: `no such project: ${project}` })
  }
  return issues
}
