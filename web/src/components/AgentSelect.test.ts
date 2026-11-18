import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, h, nextTick, type App } from 'vue'
import type { IAgent } from '@/lib/types'
import AgentSelect from './AgentSelect.vue'

vi.mock('vue-router', () => ({ useRoute: () => ({ fullPath: '/' }) }))

const agent = (id: string, name: string, over: Partial<IAgent> = {}) =>
  ({ id, name, providers: [{ id: 'claude', name: 'Claude', models: ['claude-sonnet-5-5'] }], ...over }) as unknown as IAgent

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

function mount(value: string, picked: string[]) {
  const host = document.createElement('div')
  document.body.append(host)
  const options = [agent('z', 'Zeus'), agent('m', 'Morfeu'), agent('a', 'Argos'), agent('i', 'Íris', { unavailable: { label: 'sem modelo' } as never })]
  app = createApp({ render: () => h(AgentSelect, { options, value, onPick: (id: string) => picked.push(id) }) })
  app.use(createPinia())
  app.mount(host)
  return host
}

describe('AgentSelect', () => {
  it('fechado mostra o escolhido; aberto, todos em ordem alfabética (acento não atrapalha)', async () => {
    const host = mount('m', [])
    expect(host.querySelector('[data-test="agent-select-toggle"]')?.textContent).toContain('Morfeu')
    host.querySelector<HTMLElement>('[data-test="agent-select-toggle"]')!.click()
    await nextTick()
    const names = [...host.querySelectorAll('[role="option"] .font-medium')].map((item) => item.textContent?.trim())
    expect(names).toEqual(['Argos', 'Íris', 'Morfeu', 'Zeus'])
  })

  it('a busca filtra, Enter escolhe o primeiro que serve e o indisponível não se escolhe', async () => {
    const picked: string[] = []
    const host = mount('m', picked)
    host.querySelector<HTMLElement>('[data-test="agent-select-toggle"]')!.click()
    await nextTick()
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
    input.value = 'ze'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(host.querySelectorAll('[role="option"]').length).toBe(1)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await nextTick()
    expect(picked).toEqual(['z'])
    expect(host.querySelector('[data-test="agent-select-list"]')).toBeNull()

    host.querySelector<HTMLElement>('[data-test="agent-select-toggle"]')!.click()
    await nextTick()
    const iris = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) => item.textContent?.includes('Íris'))!
    expect(iris.disabled).toBe(true)
  })
})
