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

const DRAFT = {
  key: 'knowledge:pesquisa',
  kind: 'knowledge',
  sources: [],
  ops: [{ op: 'setMeta', field: 'id', value: 'pesquisa' }],
  meta: { id: 'pesquisa', title: 'Pesquisa' },
  outputs: [],
  links: [],
  removals: [],
  diffs: [],
  conversationId: 'c1',
  proposedAt: '2026-11-02T12:00:00.000Z',
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

async function mount() {
  const refresh = ref(0)
  const host = document.createElement('div')
  document.body.append(host)
  createApp({ render: () => h(ImportDraftAside, { projectId: 'logiccus', jobId: 'job 1', keys: ['knowledge:pesquisa', 'spec:plano'], refresh: refresh.value }) }).mount(host)
  await flush()
  return { host, refresh }
}

describe('ImportDraftAside', () => {
  const mocked = vi.mocked(api)
  beforeEach(() => mocked.mockReset())

  it('carrega só os itens da conversa; o que tem rascunho mostra a revisão, o que não tem diz que espera', async () => {
    mocked.mockResolvedValue({
      latest: true,
      states: [
        { key: 'knowledge:pesquisa', state: 'review', drafts: [DRAFT] },
        { key: 'spec:plano', state: 'drafting' },
      ],
    })
    const { host } = await mount()
    expect(mocked).toHaveBeenCalledWith('/projects/logiccus/import/jobs/job%201/items', { query: { keys: ['knowledge:pesquisa', 'spec:plano'] } })
    const items = host.querySelectorAll('[data-test="import-draft-item"]')
    expect([...items].map((item) => item.querySelector('[data-test="import-draft-state"]')?.textContent?.trim())).toEqual(['a revisar', 'no construtor'])
    expect(items[0].querySelector('[data-test="import-review"]')).not.toBeNull()
    expect(items[1].querySelector('[data-test="import-review"]')).toBeNull()
    expect(items[1].textContent).toContain('Ainda sem rascunho')
  })

  it('aprovar daqui vai à mesma rota do Importador e o item muda de estado', async () => {
    mocked.mockResolvedValueOnce({ latest: true, states: [{ key: 'knowledge:pesquisa', state: 'review', drafts: [DRAFT] }] })
    const { host } = await mount()
    mocked.mockResolvedValueOnce({ key: 'knowledge:pesquisa', state: 'approved', drafts: [DRAFT], approvedBy: 'eu@x.test' })
    ;(host.querySelector('[data-test="approve"]') as HTMLButtonElement).click()
    await flush()
    expect(mocked).toHaveBeenLastCalledWith('/projects/logiccus/import/jobs/job%201/items/approve', { method: 'POST', body: { key: 'knowledge:pesquisa', removals: [] } })
    expect(host.querySelector('[data-test="import-draft-state"]')?.textContent?.trim()).toBe('aprovado')
  })

  it('recarrega quando uma proposta termina (refresh muda); trabalho antigo fica só leitura', async () => {
    mocked.mockResolvedValue({ latest: true, states: [] })
    const { host, refresh } = await mount()
    mocked.mockResolvedValue({ latest: false, states: [{ key: 'knowledge:pesquisa', state: 'review', drafts: [DRAFT] }] })
    refresh.value = 1
    await flush()
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-test="import-drafts-outdated"]')).not.toBeNull()
    expect((host.querySelector('[data-test="approve"]') as HTMLButtonElement | null)?.disabled ?? true).toBe(true)
  })
})
