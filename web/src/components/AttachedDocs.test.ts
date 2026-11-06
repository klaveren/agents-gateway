import { describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, h, nextTick, ref } from 'vue'
import type { TAttachMode } from '@/lib/guidance'
import AttachedDocs from './AttachedDocs.vue'

const DOCS = [
  { id: 'arq', kind: 'spec', title: 'Arquitetura', tokens: 1000 },
  { id: 'filas', kind: 'spec', title: 'Filas', tokens: 300 },
  { id: 'seguranca', kind: 'knowledge', title: 'Segurança', tokens: 2000 },
  { id: 'alheia', kind: 'spec', title: 'Alheia', tokens: 10, sharedFrom: 'alfa' },
]

describe('AttachedDocs — os anexados em cima, todos embaixo', () => {
  it('mostra os escolhidos com o peso dos inteiros; a busca filtra os outros; marcar e tirar avisam quem embute', async () => {
    const selected = ref(['arq', 'seguranca'])
    const refs = ref<string[]>(['seguranca'])
    const host = document.createElement('div')
    createApp({
      render: () =>
        h(AttachedDocs, {
          attachable: DOCS,
          selected: selected.value,
          modeOf: (id: string): TAttachMode => (refs.value.includes(id) ? 'reference' : 'inline'),
          emptyText: 'nada',
          onToggle: (id: string) => (selected.value = selected.value.includes(id) ? selected.value.filter((one) => one !== id) : [...selected.value, id]),
          onMode: (id: string, mode: TAttachMode) => (refs.value = mode === 'reference' ? [...refs.value, id] : refs.value.filter((one) => one !== id)),
        }),
    })
      .use(createPinia())
      .mount(host)
    await nextTick()
    const chosen = () => [...host.querySelectorAll('[data-test="attached-doc"]')].map((row) => row.textContent)
    const others = () => [...host.querySelectorAll('[data-test="attachable-doc"]')].map((row) => row.textContent?.trim())
    expect(chosen()).toHaveLength(2)
    expect(host.textContent).toContain('Anexados (2)')
    expect(host.textContent).toContain('≈ 1.000 tokens inteiros')
    expect(others()).toEqual([expect.stringContaining('Filas'), expect.stringContaining('Alheia')])
    expect(host.querySelectorAll('[data-test="shared-badge"]')).toHaveLength(1)
    const search = host.querySelector<HTMLInputElement>('[data-test="attached-search"]')!
    search.value = 'nada disso'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    expect(others()).toEqual([])
    search.value = 'fil'
    search.dispatchEvent(new Event('input'))
    await nextTick()
    host.querySelector<HTMLInputElement>('[data-test="attachable-doc"] input')!.dispatchEvent(new Event('change'))
    await nextTick()
    expect(selected.value).toEqual(['arq', 'seguranca', 'filas'])
    host.querySelector<HTMLButtonElement>('[data-test="attached-remove"]')!.click()
    await nextTick()
    expect(selected.value).toEqual(['seguranca', 'filas'])
  })
})
