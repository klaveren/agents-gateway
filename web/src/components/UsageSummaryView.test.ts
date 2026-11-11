import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { IUsageFigure, IUsageSummary } from '@/lib/types'
import UsageSummaryView from './UsageSummaryView.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn().mockResolvedValue([]),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const figure: IUsageFigure = {
  conversations: 1,
  turns: 2,
  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
}
const summary = (over: Partial<IUsageSummary> = {}): IUsageSummary => ({
  period: { days: 7, since: '2026-11-01T00:00:00Z', tzOffsetMinutes: 0 },
  totals: figure,
  daily: [],
  byAgent: [],
  byModel: [],
  top: [],
  ...over,
})

async function mount(props: { summary: IUsageSummary; showCost: boolean }): Promise<HTMLElement> {
  const host = document.createElement('div')
  const app = createApp(UsageSummaryView, props)
  app.use(createPinia())
  app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { template: '<div />' } }] }))
  app.mount(host)
  await nextTick()
  return host
}

describe('UsageSummaryView', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('o bloco por ferramenta mostra chamadas, erros e o total estimado, marcado como estimativa', async () => {
    const host = await mount({
      summary: summary({ byTool: [{ tool: 'Read', calls: 804, errors: 3, directTokens: 1_500_000, contextTokens: 9_000_000 }] }),
      showCost: false,
    })
    const block = host.querySelector('[data-test="by-tool"]')
    expect(block?.textContent).toContain('estimativa')
    const row = block?.querySelector('[data-tool="Read"]')
    expect(row?.textContent).toContain('804×')
    expect(row?.textContent).toContain('3 erros')
  })

  it('10 por página: o passador avança e mostra o intervalo', async () => {
    const byTool = Array.from({ length: 23 }, (_, index) => ({ tool: `t${index}`, calls: 1, errors: 0, directTokens: 100 - index, contextTokens: 0 }))
    const host = await mount({ summary: summary({ byTool }), showCost: false })
    const block = host.querySelector('[data-test="by-tool"]')!
    expect(block.querySelectorAll('[data-tool]').length).toBe(10)
    expect(block.querySelector('[data-test="pager"]')?.textContent).toContain('1–10 de 23')
    for (let click = 0; click < 2; click += 1) {
      ;(block.querySelector('[data-test="pager-next"]') as HTMLButtonElement).click()
      await nextTick()
    }
    expect([...block.querySelectorAll('[data-tool]')].map((row) => row.getAttribute('data-tool'))).toEqual(['t20', 't21', 't22'])
    expect((block.querySelector('[data-test="pager-next"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('tudo numa página: sem passador', async () => {
    const host = await mount({ summary: summary({ byTool: [{ tool: 'Read', calls: 1, errors: 0, directTokens: 1, contextTokens: 0 }] }), showCost: false })
    expect(host.querySelector('[data-test="pager"]')).toBeNull()
  })

  it('por provedor: soma os modelos de cada um, maior primeiro, com o custo para o admin', async () => {
    const model = (provider: string, model: string, totalTokens: number, costUsd: number) => ({ ...figure, provider, model, usage: { ...figure.usage, totalTokens }, costUsd })
    const byModel = [model('openai', 'gpt-a', 100, 0.5), model('claude', 'sonnet', 300, 1), model('openai', 'gpt-b', 400, 0.25)]
    const host = await mount({ summary: summary({ byModel }), showCost: true })
    const rows = [...host.querySelectorAll('[data-test="by-provider"] li')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('500')
    expect(rows[0]).toContain('$0.75')
    expect(rows[1]).toContain('300')
    expect(rows[1]).toContain('$1.00')
  })

  it('sem dados por ferramenta, o bloco não aparece', async () => {
    const host = await mount({ summary: summary(), showCost: false })
    expect(host.querySelector('[data-test="by-tool"]')).toBeNull()
  })
})
