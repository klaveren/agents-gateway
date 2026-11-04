import { computed, ref, watch, type Ref } from 'vue'

/** Os relatórios mostram 10 por página. */
export const PAGE_SIZE = 10

/**
 * A página de uma lista: os itens dela, a página atual e o total. A lista nova (outro período, outro projeto) volta para
 * a primeira página; a que encolheu não deixa a página fora do fim.
 */
export function usePaged<T>(list: Ref<readonly T[]>, size = PAGE_SIZE) {
  const page = ref(0)
  const pages = computed(() => Math.max(1, Math.ceil(list.value.length / size)))
  watch(
    () => list.value,
    () => (page.value = 0),
  )
  watch(pages, (count) => {
    if (page.value >= count) page.value = count - 1
  })
  const items = computed(() => list.value.slice(page.value * size, (page.value + 1) * size))
  const total = computed(() => list.value.length)
  return { page, pages, items, total, size }
}
