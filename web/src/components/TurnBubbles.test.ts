import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ITurn } from '@/lib/types'
import TurnBubbles from './TurnBubbles.vue'

let app: App | undefined

async function mount(turn: Partial<ITurn>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(TurnBubbles, { turn: { at: '2026-11-03T12:00:00Z', request: 'oi', text: 'ok', ...turn } as ITurn, showCost: false }) })
  app.use(pinia).use(router).mount(host)
  await nextTick()
  return host
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('TurnBubbles — ferramenta com erro', () => {
  it('o chip com ✕ é um botão que abre e fecha o erro inteiro', async () => {
    const host = await mount({
      toolCalls: [
        { tool: 'read', args: {} },
        { tool: 'bash', args: {}, error: 'falhou\nem duas linhas' },
      ] as ITurn['toolCalls'],
    })
    const chip = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!
    expect(chip.textContent).toContain('✕')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-test="tool-error"]')).toBeNull()
    expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(1)

    chip.click()
    await nextTick()
    const panel = host.querySelector('[data-test="tool-error"]')!
    expect(panel.textContent).toContain('bash')
    expect(panel.textContent).toContain('falhou\nem duas linhas')
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    chip.click()
    await nextTick()
    expect(host.querySelector('[data-test="tool-error"]')).toBeNull()
  })
})
