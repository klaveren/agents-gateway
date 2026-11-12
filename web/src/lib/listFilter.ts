/**
 * O FILTRO DAS LISTAS (agentes, skills, commands, documentos, MCPs, projetos…): a busca por palavras e as tags, na
 * tela, sobre o que a lista já tem. Sem acento e sem maiúscula; cada palavra tem de aparecer em algum dos campos.
 */

/** Sem acento e minúsculo. */
export const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Todas as palavras da busca aparecem em algum dos campos? Busca vazia = sim. */
export function matchesSearch(query: string, fields: ReadonlyArray<string | undefined>): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = fold(fields.filter(Boolean).join(' '))
  return words.every((word) => haystack.includes(word))
}

/** As tags de um item (o que não tem o campo, nenhuma). */
const tagsOf = (item: object): readonly string[] => (item as { tags?: readonly string[] }).tags ?? []

/** As tags que aparecem na lista, com quantos itens cada uma tem, em ordem de nome. */
export function tagCounts(items: readonly object[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) for (const tag of new Set(tagsOf(item))) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag))
}

/** A lista filtrada: a busca nos campos de cada item e, com uma tag escolhida, só os que a têm. */
export function filterList<T extends object>(items: readonly T[], filter: { query: string; tag?: string }, fieldsOf: (item: T) => ReadonlyArray<string | undefined>): T[] {
  return items.filter((item) => (!filter.tag || tagsOf(item).includes(filter.tag)) && matchesSearch(filter.query, [...fieldsOf(item), ...tagsOf(item)]))
}

/** A ordem das listas de cadastro: pelo nome, sem acento nem maiúscula, e número como número ("a2" antes de "a10"). */
export function sortByName<T>(items: readonly T[], nameOf: (item: T) => string | undefined): T[] {
  return [...items].sort((a, b) => (nameOf(a) ?? '').localeCompare(nameOf(b) ?? '', 'pt-BR', { sensitivity: 'base', numeric: true }))
}

/** O total ao lado do título da lista: com busca ou tag, quantos aparecem do total ("3 de 12"). */
export const countLabel = (shown: number, total: number): string => (shown === total ? String(total) : `${shown} de ${total}`)

/** Uma tag como o servidor a grava: sem acento, minúscula, `a-z0-9` e hífen, até 32. Vazia depois de limpar = `undefined`. */
export function normalizeTag(raw: string): string | undefined {
  const slug = fold(raw)
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return slug || undefined
}

/** As tags distintas dos itens, em ordem de nome (as sugestões do campo de tags). */
export const tagNames = (items: readonly object[]): string[] => tagCounts(items).map((entry) => entry.tag)

/** As duas listas de tags são iguais (mesma ordem)? Ausente = vazia. */
export const sameTags = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (a ?? []).join(',') === (b ?? []).join(',')
