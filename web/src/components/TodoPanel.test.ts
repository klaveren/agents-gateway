import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import type { ITodoItem } from '@/lib/types'
import TodoPanel from './TodoPanel.vue'

let app: App | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

function mount(initial: ITodoItem[]) {
  const items = ref(initial)
  const host = document.body.appendChild(document.createElement('div'))
  app = createApp({ render: () => h(TodoPanel, { items: items.value }) })
  app.mount(host)
  return { items, host, open: () => host.querySelector('button')?.getAttribute('aria-expanded') === 'true' }
}

describe('TodoPanel', () => {
  it('com tarefa por fazer, a lista fica aberta', () => {
    const panel = mount([
      { title: 'a', status: 'done' },
      { title: 'b', status: 'in_progress' },
    ])
    expect(panel.open()).toBe(true)
    expect(panel.host.querySelectorAll('li')).toHaveLength(2)
  })

  it('tudo concluído, ela já chega recolhida, e ainda abre no clique', async () => {
    const panel = mount([
      { title: 'a', status: 'done' },
      { title: 'b', status: 'cancelled' },
    ])
    expect(panel.open()).toBe(false)
    expect(panel.host.querySelector('ol')).toBeNull()
    panel.host.querySelector('button')?.click()
    await nextTick()
    expect(panel.open()).toBe(true)
  })

  it('recolhe sozinha quando a última tarefa conclui, e reabre quando chega tarefa nova', async () => {
    const panel = mount([{ title: 'a', status: 'in_progress' }])
    panel.items.value = [{ title: 'a', status: 'done' }]
    await nextTick()
    expect(panel.open()).toBe(false)
    panel.items.value = [
      { title: 'a', status: 'done' },
      { title: 'b', status: 'pending' },
    ]
    await nextTick()
    expect(panel.open()).toBe(true)
  })
})
