import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { ITurn } from '@/lib/types'
import TurnBubbles from './TurnBubbles.vue'

let app: App | undefined

async function mount(turn: Partial<ITurn>, extra: Record<string, unknown> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(TurnBubbles, { turn: { at: '2026-11-03T12:00:00Z', request: 'oi', text: 'ok', ...turn } as ITurn, showCost: false, ...extra }) })
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
    // As que terminaram ficam na linha "Executou N ferramentas": abrir a lista mostra o chip com ✕.
    host.querySelector<HTMLButtonElement>('[data-test="tools-toggle"]')!.click()
    await nextTick()
    const chip = host.querySelector<HTMLButtonElement>('[data-test="tools"] button[aria-expanded]')!
    expect(chip.textContent).toContain('✕')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-test="tool-error"]')).toBeNull()
    expect(host.querySelectorAll('[data-test="tools"] button[aria-expanded]')).toHaveLength(1)

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

describe('TurnBubbles — ferramentas agrupadas', () => {
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
    const host = await mount({ toolCalls: [{ tool: 'Read', args: {} }] as ITurn['toolCalls'] })
    expect(host.querySelector('[data-test="tools-toggle"]')).toBeNull()
    expect(host.querySelector('[data-test="tools"]')!.textContent).toContain('Read')
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
    const chips = host.querySelectorAll('[data-test="delivered-file"]')
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toContain('2 KB')
    const download = chips[0]!.querySelector<HTMLAnchorElement>('[data-test="delivered-file-download"]')!
    expect(download.getAttribute('href')).toBe('/v1/conversations/gw_1/files/f_ab12')
    expect(download.getAttribute('download')).toBe('teste.csv')
    // Sem quem ouça o `open-file`, o chip só baixa.
    expect(chips[0]!.querySelector('[data-test="delivered-file-open"]')).toBeNull()
  })

  it('com quem ouça, o chip tem os dois ícones (abrir e baixar); o que não abre na tela, só baixar', async () => {
    const opened: string[] = []
    const note = (id: string, name: string) => `{"deliveredFile":{"id":"${id}","name":"${name}","size":10}}`
    const host = await mount(
      {
        sessionId: 'gw_1',
        toolCalls: [
          { tool: 'deliver_file', args: {}, result: note('f_aa', 'grafico.png') },
          { tool: 'deliver_file', args: {}, result: note('f_bb', 'planilha.xlsx') },
        ] as ITurn['toolCalls'],
      },
      { onOpenFile: (id: string) => opened.push(id) },
    )
    const [image, sheet] = [...host.querySelectorAll('[data-test="delivered-file"]')]
    expect(image!.querySelector('[data-test="delivered-file-download"]')).not.toBeNull()
    expect(sheet!.querySelector('[data-test="delivered-file-download"]')).not.toBeNull()
    expect(sheet!.querySelector('[data-test="delivered-file-open"]')).toBeNull()
    image!.querySelector<HTMLButtonElement>('[data-test="delivered-file-open"]')!.click()
    expect(opened).toEqual(['f_aa'])
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
    expect(host.querySelector('[data-test="person-bubble"]')?.textContent).toContain('oi')
    expect(host.querySelector('[data-test="agent-reply"]')).toBeNull()
  })

  it('🤝 a resposta de outro agente entregue como mensagem vira cartão, não balão da pessoa', async () => {
    const host = await mount({ request: '[Resposta de integra (conversation gw_filha), que você pediu sem esperar: leia e continue de onde parou.]\n\n**feito**' })
    expect(host.querySelector('[data-test="person-bubble"]')).toBeNull()
    const card = host.querySelector('[data-test="agent-reply"]')!
    expect(card.textContent).toContain('Resposta de integra')
    expect(card.querySelector('strong')?.textContent).toBe('feito')
    expect(card.querySelector('a')?.getAttribute('href')).toContain('/c/gw_filha')
  })
})

describe('TurnBubbles — conversa com outro agente', () => {
  it('o talk com mensagem vira link para a conversa (também o delegate_to_agent dos turnos antigos); o talk que só lista, não', async () => {
    const reply = JSON.stringify({ to: 'integra', conversation: 'gw_filha', reply: 'feito' })
    const host = await mount({
      toolCalls: [
        { tool: 'talk', args: {}, result: JSON.stringify({ agents: [{ id: 'integra' }], conversations: [{ conversation: 'gw_x', to: 'integra' }] }) },
        { tool: 'mcp__gateway-local__talk', args: { to: 'integra', message: 'oi' }, result: [{ type: 'text', text: reply }] },
        { tool: 'delegate_to_agent', args: { agentId: 'tradutor', message: 'x' }, result: '{"sessionId":"gw_velha","reply":"ok"}' },
      ] as ITurn['toolCalls'],
    })
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-test="tools"] a')]
    expect(links.map((link) => [link.getAttribute('href'), link.textContent?.trim()])).toEqual([
      ['/c/gw_filha', 'Falou com integra →'],
      ['/c/gw_velha', 'Falou com tradutor →'],
    ])
  })
})
