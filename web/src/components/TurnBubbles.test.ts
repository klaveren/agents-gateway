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

describe('TurnBubbles — ferramentas no celular', () => {
  const narrow = (matches: boolean) =>
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches, addEventListener: () => undefined, removeEventListener: () => undefined }),
    })
  afterEach(() => Reflect.deleteProperty(window, 'matchMedia'))

  const calls = [
    { tool: 'Read', args: {} },
    { tool: 'run_bash', args: {}, error: 'falhou' },
    { tool: 'Read', args: {} },
    { tool: 'Read', args: {} },
    { tool: 'search_files', args: {} },
    { tool: 'list_files', args: {} },
    { tool: 'Read', args: {} },
  ] as ITurn['toolCalls']

  it('ficam as 3 últimas; o resto vai para o botão com o contador e os erros, que abre e recolhe', async () => {
    narrow(true)
    const host = await mount({ toolCalls: calls })
    const toggle = host.querySelector<HTMLButtonElement>('[data-test="tools-toggle"]')!
    expect(toggle.textContent).toContain('+4 ferramentas')
    expect(toggle.textContent).toContain('1 com erro')
    expect(host.querySelector('[data-test="tools"]')!.textContent).not.toContain('run_bash')
    toggle.click()
    await nextTick()
    expect(host.querySelector('[data-test="tools"]')!.textContent).toContain('run_bash')
    expect(host.querySelector('[data-test="tools-toggle"]')!.textContent).toContain('recolher')
  })

  it('em tela larga, todas à vista e sem botão', async () => {
    narrow(false)
    const host = await mount({ toolCalls: calls })
    expect(host.querySelector('[data-test="tools-toggle"]')).toBeNull()
  })
})
