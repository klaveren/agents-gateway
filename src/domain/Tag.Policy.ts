/**
 * As TAGS de um item do catálogo (agente, skill, command, documento, rule, MCP): palavras livres para agrupar e filtrar
 * nas listas. ⚖️ Livres, mas normalizadas no servidor — `Infra`, `infra ` e `ínfra` são a mesma `infra` — para o
 * filtro não partir o mesmo grupo em três.
 */

export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const TAG_MAX = 20

/** Sem acento, minúscula, espaço e `_` viram hífen; o que sobra fora do padrão sai. Vazio = `undefined`. */
export function normalizeTag(raw: string): string | undefined {
  const tag = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return tag || undefined
}

/** As tags como vão ser gravadas: normalizadas, sem repetir, na ordem em que vieram. */
export function normalizeTags(raw: readonly string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((tag) => normalizeTag(String(tag))).filter((tag): tag is string => !!tag))]
}

/** O que está errado na lista (depois de normalizada): demais, ou uma que não sobrou nada. */
export function tagIssues(raw: readonly string[] | undefined): Array<{ field: 'tags'; message: string }> {
  const issues: Array<{ field: 'tags'; message: string }> = []
  for (const tag of raw ?? []) if (!normalizeTag(String(tag))) issues.push({ field: 'tags', message: `"${tag}": use letters, digits or hyphens` })
  if (normalizeTags(raw).length > TAG_MAX) issues.push({ field: 'tags', message: `at most ${TAG_MAX} tags` })
  return issues
}
