import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { api } from '@/lib/api'
import ImportDraftAside from './ImportDraftAside.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const draft = (key: string, removals = 0) => ({
  key,
  kind: 'knowledge',
  sources: [],
  ops: [{ op: 'setMeta', field: 'id', value: key }],
  meta: { id: key },
  outputs: [],
  links: [],
  removals: Array.from({ length: removals }, (_, op) => ({ op, source: 'x.md', text: 'x', whole: false, reason: 'r' })),
  diffs: [],
  conversationId: 'c1',
  proposedAt: '2026-11-02T12:00:00.000Z',
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

const KEYS = ['knowledge:a', 'knowledge:b', 'knowledge:c', 'knowledge:d']

async function mount() {
  const refresh = ref(0)
  const updated: string[][] = []
  const host = document.createElement('div')
  document.body.append(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  createApp({
    render: () =>
      h(ImportDraftAside, {
        projectId: 'logiccus',
        jobId: 'j1',
        keys: KEYS,
        refresh: refresh.value,
        onUpdated: (states: Array<{ key: string }>) => updated.push(states.map((one) => one.key)),
      }),
  })
    .use(pinia)
    .mount(host)
  await flush()
  return { host, refresh, updated }
}

const toggles = (host: HTMLElement) => [...host.querySelectorAll('[data-test="import-draft-toggle"]')].map((row) => row.querySelector('code')!.textContent)

describe('ImportDraftAside — a fila de revisão de uma conversa de importação', () => {
  const mocked = vi.mocked(api)
  beforeEach(() => {
    mocked.mockReset()
    mocked.mockImplementation(async (path: string, request?: { method?: string; body?: unknown }) => {
      if (request?.method === 'PATCH') {
        const { key, kind } = request.body as { key: string; kind: string }
        return { key, state: 'pending', kind, fingerprint: 'f' }
      }
      if (path.endsWith('/items/approve')) {
        const key = (request!.body as { key: string }).key
        return { key, state: 'approved', drafts: [draft(key)] }
      }
      return {
        latest: true,
        states: [
          { key: 'knowledge:a', state: 'drafting' },
          { key: 'knowledge:b', state: 'review', drafts: [draft('knowledge:b')] },
          { key: 'knowledge:c', state: 'approved', drafts: [draft('knowledge:c')] },
          { key: 'knowledge:d', state: 'review', drafts: [draft('knowledge:d', 1)] },
        ],
      }
    })
  })

  it('a fila põe o que está a revisar primeiro e abre o primeiro; "só a revisar" desmarcado mostra todos, na ordem do que pede ação', async () => {
    const { host, updated } = await mount()
    expect(mocked).toHaveBeenCalledWith('/projects/logiccus/import/jobs/j1/items', { query: { keys: KEYS } })
    expect(host.querySelector('[data-test="review-count"]')!.textContent).toContain('2 a revisar · 4 na conversa')
    expect(toggles(host)).toEqual(['knowledge:b', 'knowledge:d'])
    expect(host.querySelectorAll('[data-test="import-review"]')).toHaveLength(1)
    expect(updated[0]).toEqual(KEYS)
    host.querySelector<HTMLInputElement>('[data-test="only-review"]')!.click()
    await flush()
    expect(toggles(host)).toEqual(['knowledge:b', 'knowledge:d', 'knowledge:a', 'knowledge:c'])
  })

  it('aprovar abre o próximo a revisar e avisa quem embute', async () => {
    const { host, updated } = await mount()
    ;(host.querySelector('[data-test="approve"]') as HTMLButtonElement).click()
    await flush()
    expect(mocked).toHaveBeenCalledWith('/projects/logiccus/import/jobs/j1/items/approve', { method: 'POST', body: { key: 'knowledge:b', removals: [] } })
    expect(updated.at(-1)).toEqual(['knowledge:b'])
    const open = host.querySelector('[data-test="import-draft-toggle"][aria-expanded="true"]')!
    expect(open.textContent).toContain('knowledge:d')
  })

  it('o item no construtor sem rascunho reclassifica daqui: sai da conversa e volta à fila; com rascunho, não', async () => {
    const { host, updated } = await mount()
    expect(host.querySelector('[data-test="import-draft-reclassify"]')).toBeNull()
    host.querySelector<HTMLInputElement>('[data-test="only-review"]')!.click()
    await flush()
    const row = [...host.querySelectorAll<HTMLButtonElement>('[data-test="import-draft-toggle"]')].find((one) => one.textContent!.includes('knowledge:a'))!
    row.click()
    await flush()
    const select = host.querySelector<HTMLSelectElement>('[data-test="import-draft-reclassify-kind"]')!
    expect(select.value).toBe('knowledge')
    select.value = 'spec'
    select.dispatchEvent(new Event('change'))
    await flush()
    expect(mocked).toHaveBeenCalledWith('/projects/logiccus/import/jobs/j1/items', { method: 'PATCH', body: { key: 'knowledge:a', kind: 'spec' } })
    expect(updated.at(-1)).toEqual(['knowledge:a'])
    expect(host.querySelector<HTMLSelectElement>('[data-test="import-draft-reclassify-kind"]')!.value).toBe('spec')
  })

  it('"Aprovar os N sem remoção": só os que não removem nada, com confirmação e a lista', async () => {
    const { host } = await mount()
    const open = host.querySelector<HTMLButtonElement>('[data-test="quick-approve-open"]')!
    expect(open.textContent).toContain('Aprovar os 1 sem remoção')
    open.click()
    await flush()
    expect(host.querySelector('[data-test="quick-approve-list"]')!.textContent).toBe('knowledge:b')
    host.querySelector<HTMLButtonElement>('[data-test="quick-approve-confirm"]')!.click()
    await flush()
    const approvals = mocked.mock.calls.filter(([path]) => path.endsWith('/items/approve'))
    expect(approvals.map(([, request]) => (request?.body as { key: string }).key)).toEqual(['knowledge:b'])
    expect(host.querySelector('[data-test="quick-approve-result"]')!.textContent).toContain('1/1 aprovado(s)')
  })

  it('recarrega quando uma proposta termina; trabalho antigo avisa', async () => {
    const { host, refresh } = await mount()
    mocked.mockResolvedValue({ latest: false, states: [] })
    refresh.value = 1
    await flush()
    expect(host.querySelector('[data-test="import-drafts-outdated"]')).not.toBeNull()
  })
})
