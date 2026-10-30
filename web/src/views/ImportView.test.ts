import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import type { IImportScan, IInventoryItem } from '@/lib/importer'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import ImportView from './ImportView.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

function item(partial: Partial<IInventoryItem> & Pick<IInventoryItem, 'key' | 'kind'>): IInventoryItem {
  return { candidateId: partial.key.split(':')[1], detectors: ['agents-dir'], sources: [], refs: [], unresolved: [], notes: [], ...partial }
}

function scan(items: IInventoryItem[]): IImportScan {
  return {
    projectId: 'alfa',
    repository: 'app',
    head: '0123456789abcdef',
    dirty: true,
    scannedAt: '2026-10-30T12:00:00.000Z',
    formats: ['agents-dir', 'opencode'],
    totals: { files: 9, items: items.length, tokens: 1200, byKind: {} },
    ignored: { dirs: { node_modules: 40 }, binaries: [], links: [{ path: '.agents/fora', reason: 'outside' }] },
    items,
  }
}

const SMALL = [
  item({
    key: 'skill:deploy',
    kind: 'skill',
    catalog: 'new',
    sources: [{ path: '.agents/skills/deploy/SKILL.md', aliases: ['.claude/skills/deploy/SKILL.md'], bytes: 400, tokens: 100, sha256: 'f'.repeat(64), secret: true }],
    notes: [{ level: 'untranslatable', code: 'skill-triggers', text: 'a skill tem triggers/' }],
  }),
  item({
    key: 'command:ship',
    kind: 'command',
    catalog: 'other-project',
    sources: [{ path: '.agents/commands/ship.md', aliases: [], bytes: 80, tokens: 20, sha256: 'a'.repeat(64) }],
    refs: [{ path: '.agents/skills/deploy/SKILL.md', item: 'skill:deploy' }],
    unresolved: ['docs/sumiu.md'],
    notes: [{ level: 'attention', code: 'broken-ref', text: 'referência quebrada: docs/sumiu.md' }],
  }),
  item({ key: 'unknown:notes/x.md', kind: 'unknown', sources: [{ path: 'notes/x.md', aliases: [], bytes: 10, tokens: 3, sha256: 'b'.repeat(64) }] }),
]

async function flush() {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(items: IInventoryItem[]): Promise<HTMLElement> {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path.endsWith('/repositories'))
      return [
        { name: 'app', worktrees: [] },
        { name: 'lib', worktrees: [] },
      ]
    if (path.endsWith('/import/scan')) return scan(items)
    throw new Error(`inesperado: ${path}`)
  })
  const host = document.createElement('div')
  // ⚠️ No documento: o jsdom só envia o formulário (o "Analisar") que está nele.
  document.body.append(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa', createdAt: '', updatedAt: '' }]
  projects.current = 'alfa'
  projects.loaded = true
  createApp(ImportView).use(pinia).mount(host)
  await flush()
  host.querySelector<HTMLButtonElement>('[data-test="analyze"]')!.click()
  await flush()
  return host
}

function rows(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-test="row"]')].map((row) => row.textContent ?? '')
}

function choose(host: HTMLElement, test: string, value: string) {
  const select = host.querySelector<HTMLSelectElement>(`[data-test="${test}"]`)!
  select.value = value
  select.dispatchEvent(new Event('change'))
}

describe('ImportView', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    document.body.innerHTML = ''
  })

  it('analisa o repositório escolhido e mostra o topo', async () => {
    const host = await mount(SMALL)
    expect(api).toHaveBeenCalledWith('/projects/alfa/import/scan', { method: 'POST', body: { repository: 'app' } })
    const summary = host.querySelector('[data-test="summary"]')!.textContent!
    expect(summary).toContain('0123456789ab')
    expect(summary).toContain('árvore suja')
    expect(summary).toContain('agents-dir')
    expect(summary).toContain('node_modules')
    expect(summary).toContain('Links recusados (1)')
    expect(rows(host)).toHaveLength(3)
  })

  it('filtra por nota, por estado e pela busca', async () => {
    const host = await mount(SMALL)
    choose(host, 'note', 'code:broken-ref')
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('ship')

    choose(host, 'note', '')
    choose(host, 'catalog', 'none')
    await flush()
    expect(rows(host).map((row) => row.includes('notes/x.md'))).toEqual([true])

    choose(host, 'catalog', '')
    const query = host.querySelector<HTMLInputElement>('[data-test="query"]')!
    query.value = '.claude/skills'
    query.dispatchEvent(new Event('input'))
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('deploy')
  })

  it('o detalhe mostra fontes, citações, "não traduz" e quem cita', async () => {
    const host = await mount(SMALL)
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('deploy'))!.click()
    await flush()
    const detail = host.querySelector('[data-test="import-detail"]')!
    expect(detail.querySelector('[data-test="untranslatable"]')!.textContent).toContain('a skill tem triggers/')
    expect(detail.textContent).toContain('.claude/skills/deploy/SKILL.md')
    expect(detail.textContent).toContain('segredo')
    expect(detail.textContent).toContain('Citado por (1)')

    // Ir para quem cita: o detalhe troca para o command, com a citação quebrada.
    ;[...detail.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'command:ship')!.click()
    await flush()
    expect(host.querySelector('[data-test="unresolved"]')!.textContent).toContain('docs/sumiu.md')
  })

  it('reclassificar muda o tipo só na tela, sem chamar a API', async () => {
    const host = await mount(SMALL)
    ;[...host.querySelectorAll<HTMLButtonElement>('[data-test="row"]')].find((row) => row.textContent!.includes('notes/x.md'))!.click()
    await flush()
    const calls = vi.mocked(api).mock.calls.length
    choose(host, 'reclassify', 'spec')
    await flush()
    expect(vi.mocked(api).mock.calls.length).toBe(calls)
    choose(host, 'kind', 'spec')
    await flush()
    expect(rows(host)).toHaveLength(1)
    expect(rows(host)[0]).toContain('Spec')
    expect(host.querySelector('[data-test="summary"]')!.textContent).toContain('1 reclassificado(s)')
  })

  it('um inventário grande abre só a primeira página', async () => {
    const many = Array.from({ length: 730 }, (_, i) => item({ key: `spec:doc-${String(i).padStart(3, '0')}`, kind: 'spec', catalog: 'new' }))
    const host = await mount(many)
    expect(rows(host)).toHaveLength(100)
    expect(host.querySelector('[data-test="count"]')!.textContent).toContain('730 de 730')
    host.querySelector<HTMLButtonElement>('[data-test="more"]')!.click()
    await flush()
    expect(rows(host)).toHaveLength(200)
  })
})
