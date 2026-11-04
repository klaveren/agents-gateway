import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { openCount, type IConversationPanel } from '@/lib/conversationPanel'
import ConversationPanel from './ConversationPanel.vue'
import PanelToggle from './PanelToggle.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const fake = (): IConversationPanel => ({
  goal: 'Migrar o billing',
  items: [
    {
      id: 'p1',
      title: 'Mapear tabelas',
      status: 'done',
      doneTurn: 2,
      askedTurn: 1,
      links: [
        { label: 'PR', href: 'https://x.dev/pr/1' },
        { label: 'filha', href: 'gw_abc' },
        { label: 'arq', href: 'src/a.ts' },
      ],
    },
    { id: 'p2', title: 'Escrever migração', status: 'doing', delegatedTo: { agentId: 'theo', sessionId: 'gw_xyz' } },
    { id: 'p3', title: 'Rodar em produção', status: 'blocked', note: 'espera janela' },
    { id: 'p4', title: 'Revisar A', status: 'queued' },
    { id: 'p5', title: 'Revisar B', status: 'queued' },
    { id: 'p6', title: 'Ideia velha', status: 'dropped' },
  ],
  decisions: [{ id: 'd1', text: 'Usar Postgres', why: 'já temos', by: 'pessoa' }],
  questions: [{ id: 'q1', text: 'Qual janela?' }],
  history: [{ at: '2026-11-01T10:00:00Z', turn: 1, by: 'agente', text: 'p1 adicionado' }],
})

let app: App | undefined
let current: IConversationPanel
const flush = async () => {
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}
async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] })
  app = createApp({ render: () => h(ConversationPanel, { conversationId: 'gw_1' }) })
  app.use(createPinia()).use(router)
  app.mount(host)
  await flush()
  return host
}
const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const patches = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([, request]) => request?.method === 'PATCH')
    .map(([, request]) => request?.body)

describe('ConversationPanel', () => {
  beforeEach(() => {
    current = fake()
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (_path: string, request?: { method?: string }) => (request?.method === 'PATCH' ? current : current))
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('mostra o selo só com itens em aberto', () => {
    expect(openCount(fake())).toBe(4)
    const render = (count?: number) => {
      const host = document.createElement('div')
      const instance = createApp({ render: () => h(PanelToggle, { count }) })
      instance.mount(host)
      return { host, instance }
    }
    const withCount = render(4)
    expect(withCount.host.querySelector('[data-test="panel-badge"]')?.textContent).toBe('4')
    expect(withCount.host.querySelector('button')?.getAttribute('title')).toBe('Painel da conversa')
    withCount.instance.unmount()
    const none = render(0)
    expect(none.host.querySelector('[data-test="panel-badge"]')).toBeNull()
    none.instance.unmount()
  })

  it('desenha as seções, links, delegação e turnos', async () => {
    const host = await mount()
    expect(host.textContent).toContain('Migrar o billing')
    expect(host.querySelector('[data-test="section-doing"] [data-item="p2"]')).toBeTruthy()
    expect(host.querySelector('[data-test="section-blocked"]')?.textContent).toContain('espera janela')
    expect(host.querySelectorAll('[data-test="section-queued"] [data-item]')).toHaveLength(2)
    const done = host.querySelector('[data-test="section-done"]') as HTMLElement
    expect(done.textContent).toContain('pedido no turno 1')
    expect(done.textContent).toContain('entregue no turno 2')
    const external = done.querySelector('a[target="_blank"]')
    expect(external?.getAttribute('href')).toBe('https://x.dev/pr/1')
    expect(done.querySelector('a[href="/c/gw_abc"]')).toBeTruthy()
    expect(done.querySelector('span.font-mono')?.textContent).toBe('src/a.ts')
    const badge = host.querySelector('[data-item="p2"] [data-test="delegated"]')
    expect(badge?.textContent).toContain('com theo')
    expect(badge?.getAttribute('href')).toBe('/c/gw_xyz')
    expect(host.querySelector('[data-test="decisions"]')?.textContent).toContain('Usar Postgres')
    expect(host.querySelector('[data-test="questions"]')?.textContent).toContain('Qual janela?')
    // Descartado e linha do tempo começam recolhidos.
    expect(host.textContent).not.toContain('Ideia velha')
    expect(host.textContent).not.toContain('p1 adicionado')
    await click(host.querySelector('[data-test="dropped-toggle"]'))
    expect(host.textContent).toContain('Ideia velha')
    await click(host.querySelector('[data-test="timeline-toggle"]'))
    expect(host.textContent).toContain('p1 adicionado')
  })

  it('muda o estado de um item com PATCH update', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="menu-p4"]'))
    await click(host.querySelector('[data-item="p4"] [data-test="status-done"]'))
    expect(patches()).toEqual([{ op: 'update', id: 'p4', status: 'done' }])
  })

  it('reordena com PATCH move', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="menu-p5"]'))
    await click(host.querySelector('[data-item="p5"] [data-test="move-up"]'))
    expect(patches()).toEqual([{ op: 'move', id: 'p5', before: 'p4' }])
    await click(host.querySelector('[data-test="menu-p4"]'))
    await click(host.querySelector('[data-item="p4"] [data-test="move-down"]'))
    // Depois de p5 não há vizinho: sem `before` = vai para o fim.
    expect(patches()[1]).toEqual({ op: 'move', id: 'p4' })
  })

  it('responde a uma pergunta com PATCH answer', async () => {
    const host = await mount()
    const input = host.querySelector('[data-question="q1"] [data-test="answer-input"]') as HTMLInputElement
    input.value = 'sábado'
    input.dispatchEvent(new Event('input'))
    await flush()
    await click(host.querySelector('[data-question="q1"] [data-test="answer-send"]'))
    expect(patches()).toEqual([{ op: 'answer', id: 'q1', answer: 'sábado' }])
  })

  it('as respondidas descem recolhidas, com o aviso de que o agente ainda não viu', async () => {
    current = {
      ...fake(),
      questions: [
        { id: 'q1', text: 'Qual janela?' },
        { id: 'q2', text: 'Qual porta?', answer: '27017', answeredBy: 'person', delivered: false },
      ],
    }
    const host = await mount()
    expect(host.querySelector('[data-question="q1"]')).not.toBeNull()
    expect(host.querySelector('[data-question="q2"]')).toBeNull()
    await click(host.querySelector('[data-test="answered-toggle"]'))
    expect(host.querySelector('[data-test="answered"]')?.textContent).toContain('o agente vê no próximo turno')
  })

  it('edita o objetivo com set_goal', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="goal-edit"]'))
    const input = host.querySelector('[data-test="goal-input"]') as HTMLTextAreaElement
    input.value = 'Novo objetivo'
    input.dispatchEvent(new Event('input'))
    await flush()
    await click(host.querySelector('[data-test="goal-save"]'))
    expect(patches()).toEqual([{ op: 'set_goal', goal: 'Novo objetivo' }])
  })

  it('exporta o Markdown de ?format=md', async () => {
    const host = await mount()
    const fetchMock = vi.fn(async () => new Response('# Painel', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const clicked: string[] = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    }
    await click(host.querySelector('[data-test="export-md"]'))
    HTMLAnchorElement.prototype.click = original
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/v1/conversations/gw_1/panel?format=md')
    expect(clicked).toEqual(['painel-gw_1.md'])
  })

  it('mostra o estado vazio', async () => {
    current = { items: [], decisions: [], questions: [], history: [] }
    const host = await mount()
    expect(host.querySelector('[data-test="panel-empty"]')?.textContent).toBe('O agente ainda não registrou nada nesta conversa.')
  })
})
