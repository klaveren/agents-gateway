import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { usePaged } from './usePaged'

const rows = (count: number, from = 1) => Array.from({ length: count }, (_, index) => ({ id: `r${from + index}` }))

describe('usePaged', () => {
  it('fatia de 10 em 10; a lista nova volta para a primeira página', async () => {
    const list = ref(rows(23))
    const paged = usePaged(list)
    expect([paged.pages.value, paged.total.value, paged.items.value.length]).toEqual([3, 23, 10])

    paged.page.value = 2
    expect(paged.items.value.map((item) => item.id)).toEqual(['r21', 'r22', 'r23'])

    list.value = rows(23)
    await nextTick()
    expect(paged.page.value).toBe(0)
  })

  it('a lista que encolheu não deixa a página fora do fim', async () => {
    const list = ref(rows(23))
    const paged = usePaged(list, { by: (item) => item.id })
    paged.page.value = 2
    list.value = list.value.slice(0, 20)
    await nextTick()
    expect([paged.page.value, paged.pages.value]).toEqual([1, 2])
  })

  it('com a identidade da linha: remover fica na página, e o item novo leva para a dele', async () => {
    const list = ref(rows(25))
    const paged = usePaged(list, { by: (item) => item.id })
    paged.page.value = 1

    list.value = list.value.filter((item) => item.id !== 'r12')
    await nextTick()
    expect(paged.page.value).toBe(1)

    list.value = [...list.value, { id: 'novo' }]
    await nextTick()
    expect(paged.page.value).toBe(2)
    expect(paged.items.value.at(-1)?.id).toBe('novo')
  })

  it('com a identidade da linha: outra lista (nada em comum) volta para a primeira página', async () => {
    const list = ref(rows(25))
    const paged = usePaged(list, { by: (item) => item.id })
    paged.page.value = 2
    list.value = rows(25, 100)
    await nextTick()
    expect(paged.page.value).toBe(0)
  })
})
