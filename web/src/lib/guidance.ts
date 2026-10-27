import type { IProject } from './types'

/** O escopo de uma rule ou documento: `global` ou o id de um projeto (o mesmo `?project=` da API). */
export const GLOBAL_SCOPE = 'global'

export function scopeLabel(scope: string | undefined, projects: readonly IProject[]): string {
  if (!scope || scope === GLOBAL_SCOPE) return 'Global'
  return projects.find((project) => project.id === scope)?.name ?? scope
}

/** O `projectId` que a API grava: `null` para o global. */
export function scopeToProjectId(scope: string): string | null {
  return scope === GLOBAL_SCOPE ? null : scope
}

/** Um id de documento a partir do título: minúsculas, sem acento, hífens (o `read_doc` usa ele). */
export function docSlug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Acima disto, a tela avisa: o contexto inicial pesa em TODA conversa do projeto. */
export const CONTEXT_WARN_TOKENS = 20_000

/** O peso do contexto inicial: a soma dos tokens estimados das specs marcadas. */
export function contextWeight(selected: readonly string[], tokensOf: (id: string) => number | undefined): { total: number; warn: boolean } {
  const total = selected.reduce((sum, id) => sum + (tokensOf(id) ?? 0), 0)
  return { total, warn: total > CONTEXT_WARN_TOKENS }
}
