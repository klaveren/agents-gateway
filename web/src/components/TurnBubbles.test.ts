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

  it('uma linha "Executou N ferramentas", com os erros, que abre a lista inteira e recolhe', async () => {
    narrow(true)
    const host = await mount({ toolCalls: calls })
    const toggle = host.querySelector<HTMLButtonElement>('[data-test="tools-toggle"]')!
    expect(toggle.textContent).toContain('Executou 7 ferramentas')
    expect(toggle.textContent).toContain('1 com erro')
    expect(host.querySelector('[data-test="tools"]')).toBeNull()
    toggle.click()
    await nextTick()
    expect(host.querySelector('[data-test="tools"]')!.textContent).toContain('run_bash')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('uma ferramenta só fica como chip, sem a linha', async () => {
    narrow(true)
    const host = await mount({ toolCalls: [{ tool: 'Read', args: {} }] as ITurn['toolCalls'] })
    expect(host.querySelector('[data-test="tools-toggle"]')).toBeNull()
    expect(host.querySelector('[data-test="tools"]')!.textContent).toContain('Read')
  })

  it('em tela larga, todas à vista e sem botão', async () => {
    narrow(false)
    const host = await mount({ toolCalls: calls })
    expect(host.querySelector('[data-test="tools-toggle"]')).toBeNull()
  })
})

describe('TurnBubbles — arquivo entregue', () => {
  it('o deliver_file vira um botão de baixar, também com o resultado aninhado do SDK; o que falhou, não', async () => {
    const note = 'Delivered x. {"deliveredFile":{"id":"f_ab12","name":"teste.csv","size":2048}}'
    const host = await mount({
      sessionId: 'gw_1',
      toolCalls: [
        { tool: 'mcp__gateway__deliver_file', args: { path: 'teste.csv' }, result: [{ type: 'text', text: note }] },
        { tool: 'deliver_file', args: { path: 'outro.csv' }, error: 'file is larger than 20 MB' },
      ] as ITurn['toolCalls'],
    })
    const links = host.querySelectorAll<HTMLAnchorElement>('[data-test="delivered-files"] a')
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute('href')).toBe('/v1/conversations/gw_1/files/f_ab12')
    expect(links[0]!.getAttribute('download')).toBe('teste.csv')
    expect(links[0]!.textContent).toContain('2 KB')
  })
})

describe('TurnBubbles — aviso do gateway', () => {
  it('o turno que o gateway abriu é um aviso no meio, não o balão de quem fala; o resto fica recolhido', async () => {
    const host = await mount({ request: '[Aviso do gateway, não é mensagem da pessoa: a vigia "servidor voltar" disparou.]\nComando conferido: test -f pronto' })
    const notice = host.querySelector('[data-test="gateway-notice"]')!
    expect(notice.textContent).toContain('Aviso do gateway')
    expect(notice.textContent).toContain('A vigia "servidor voltar" disparou.')
    expect(notice.querySelector('details pre')?.textContent).toBe('Comando conferido: test -f pronto')
    expect(host.querySelector('.bg-emerald-600\\/90')).toBeNull()
  })

  it('a fala da pessoa segue no balão dela', async () => {
    const host = await mount({ request: 'oi' })
    expect(host.querySelector('[data-test="gateway-notice"]')).toBeNull()
    expect(host.querySelector('.bg-emerald-600\\/90')?.textContent).toContain('oi')
  })
})
