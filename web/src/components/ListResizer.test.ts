import { describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import { LIST_WIDTH, useListWidth } from '@/composables/useListWidth'
import ListResizer from './ListResizer.vue'

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  createApp(ListResizer).mount(host)
  await nextTick()
  return host.querySelector('[data-test="list-resizer"]') as HTMLElement
}

describe('ListResizer', () => {
  it('arrastar muda a largura dentro dos limites e guarda; duplo clique volta ao padrão', async () => {
    const { width } = useListWidth()
    const handle = await mount()
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 340 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 440 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    expect(width.value).toBe(LIST_WIDTH.default + 100)
    expect(localStorage.getItem('layout.listWidth')).toBe(String(LIST_WIDTH.default + 100))

    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5000 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    expect(width.value).toBe(LIST_WIDTH.max)

    handle.dispatchEvent(new MouseEvent('dblclick'))
    expect(width.value).toBe(LIST_WIDTH.default)
  })

  it('⛔ o clique que fecha o arraste não chega à linha da lista', async () => {
    const handle = await mount()
    let clicked = false
    document.body.addEventListener('click', () => (clicked = true))
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicked).toBe(false)
  })

  it('as setas ajustam de 20 em 20', async () => {
    const { width, reset } = useListWidth()
    reset()
    const handle = await mount()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    expect(width.value).toBe(LIST_WIDTH.default - 20)
  })
})
