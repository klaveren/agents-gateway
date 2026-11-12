import { computed, ref, watch, type Ref } from 'vue'

/** As listas mostram 10 por página. */
export const PAGE_SIZE = 10

export interface IPagedOptions<T> {
  size?: number
  /**
   * A identidade da linha, nas listas em que se AGE nela (remover, revogar, criar): a lista relida fica na página em que
   * estava, e o item novo leva para a página dele. Sem isto, toda lista nova volta para a primeira página.
   */
  by?: (item: T) => unknown
}

/**
 * A página de uma lista: os itens dela, a página atual e o total. A lista nova (outro período, outro projeto) volta para
 * a primeira página; a que encolheu não deixa a página fora do fim.
 */
export function usePaged<T>(list: Ref<readonly T[]>, options: IPagedOptions<T> = {}) {
  const size = options.size ?? PAGE_SIZE
  const by = options.by
  const page = ref(0)
  const pages = computed(() => Math.max(1, Math.ceil(list.value.length / size)))
  watch(
    () => list.value,
    (next, previous) => {
      if (!by) return (page.value = 0)
      const known = new Set(previous.map(by))
      // Nada em comum com a de antes: é OUTRA lista (outro agente, outro projeto), não a mesma relida.
      if (!next.some((item) => known.has(by(item)))) return (page.value = 0)
      const added = next.findIndex((item) => !known.has(by(item)))
      if (added >= 0) page.value = Math.floor(added / size)
    },
  )
  watch(pages, (count) => {
    if (page.value >= count) page.value = count - 1
  })
  const items = computed(() => list.value.slice(page.value * size, (page.value + 1) * size))
  const total = computed(() => list.value.length)
  return { page, pages, items, total, size }
}
