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

  it('sem dados por ferramenta, o bloco não aparece', async () => {
    const host = await mount({ summary: summary(), showCost: false })
    expect(host.querySelector('[data-test="by-tool"]')).toBeNull()
  })
})
