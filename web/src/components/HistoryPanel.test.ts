import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api, ApiError } from '@/lib/api'
import type { IItemHistory, IRevisionDiff, TCatalogKind } from '@/lib/catalogHistory'
import HistoryPanel from './HistoryPanel.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const page: IItemHistory = {
  kind: 'agent',
  itemId: 'theo',
  current: { exists: true, hash: 'h3' },
  total: 3,
  page: 1,
  pageSize: 20,
  revisions: [
    {
      id: 13,
      kind: 'agent',
      itemId: 'theo',
      revision: 3,
      op: 'update',
      hash: 'h3',
      at: '2026-10-30T10:00:00Z',
      by: 'ana@x.com',
      source: 'api',
      widenings: ['agent/theo#allowedTools+cap:terminal'],
    },
    { id: 12, kind: 'agent', itemId: 'theo', revision: 2, op: 'update', hash: 'h2', at: '2026-10-29T10:00:00Z', by: 'bia@x.com', source: 'agent', note: 'ajuste do prompt' },
    { id: 11, kind: 'agent', itemId: 'theo', revision: 1, op: 'create', hash: 'h1', at: '2026-10-28T10:00:00Z', by: 'ana@x.com', source: 'api' },
  ],
}

const diff: IRevisionDiff = {
  kind: 'agent',
  itemId: 'theo',
  from: { revision: 2, exists: true },
  to: { revision: 3, exists: true },
  equal: false,
  added: 1,
  removed: 1,
  unified: '',
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { op: 'equal', text: 'name: Theo', oldLine: 1, newLine: 1 },
        { op: 'remove', text: 'allowedTools: []', oldLine: 2 },
        { op: 'add', text: 'allowedTools: [cap:terminal]', newLine: 2 },
      ],
    },
  ],
}

type TRestore = (body: Record<string, unknown>) => unknown
let restoreHandler: TRestore
let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(props: { kind: TCatalogKind; id: string; readonly?: boolean } = { kind: 'agent', id: 'theo' }, onRestored = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(HistoryPanel, { ...props, onRestored }) })
  app.mount(host)
  await flush()
  return host
}

const restoreCalls = () =>
  vi
    .mocked(api)
    .mock.calls.filter(([path]) => path === '/catalog/history/restore')
    .map(([, request]) => request?.body as Record<string, unknown>)

async function click(element: Element | null | undefined) {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}

/** Escolhe a rev 2, clica em Restaurar e confirma no diálogo. */
async function restoreRev2(host: HTMLElement) {
  await click(host.querySelector('[data-revision="2"]'))
  await click(host.querySelector('[data-test="restore"]'))
  const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent?.trim() === 'Restaurar')
  await click(confirm)
}

describe('HistoryPanel', () => {
  beforeEach(() => {
    restoreHandler = () => ({
      kind: 'agent',
      itemId: 'theo',
      restoredFrom: 2,
      unchanged: false,
      exists: true,
      revision: { ...page.revisions[1], revision: 4, op: 'restore' },
      alsoChanged: [],
      widenings: [],
      missingSecrets: [],
    })
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, request?: { body?: unknown }) => {
      if (path === '/catalog/history') return page
      if (path === '/catalog/history/diff') return diff
      if (path === '/catalog/history/restore') return restoreHandler(request?.body as Record<string, unknown>)
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('lista as revisões com op, quando, quem, origem, nota e o selo de ampliação aceita', async () => {
    const host = await mount()
    const rows = host.querySelectorAll('[data-test="revisions"] li')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('rev 3')
    expect(rows[0].textContent).toContain('alterado')
    expect(rows[0].textContent).toContain('ana@x.com')
    expect(rows[0].textContent).toContain('tela ou API')
    expect(rows[0].querySelector('[data-test="widening-badge"]')?.textContent).toContain('ampliação aceita (1)')
    expect(rows[1].textContent).toContain('ajuste do prompt')
    expect(rows[1].textContent).toContain('agente')
    expect(rows[1].querySelector('[data-test="widening-badge"]')).toBeNull()
    expect(rows[2].textContent).toContain('criado')
    expect(vi.mocked(api)).toHaveBeenCalledWith('/catalog/history', { query: { kind: 'agent', id: 'theo', page: 1, pageSize: 20 } })
  })

  it('renderiza o diff com símbolo e cor, contra a anterior e contra o atual', async () => {
    const host = await mount()
    const lines = host.querySelectorAll('[data-test="diff"] [data-op]')
    expect([...lines].map((line) => line.getAttribute('data-op'))).toEqual(['equal', 'remove', 'add'])
    expect(lines[1].textContent).toContain('−')
    expect(lines[1].textContent).toContain('allowedTools: []')
    expect(lines[1].className).toContain('rose')
    expect(lines[2].textContent).toContain('+')
    expect(lines[2].className).toContain('emerald')
    expect(vi.mocked(api)).toHaveBeenCalledWith('/catalog/history/diff', { query: { kind: 'agent', id: 'theo', from: 2, to: 3 } })

    await click(host.querySelector('[data-test="compare-current"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/catalog/history/diff', { query: { kind: 'agent', id: 'theo', from: 3, to: 'current' } })
  })

  it('a última revisão igual ao atual não oferece restaurar', async () => {
    const host = await mount()
    expect(host.querySelector('[data-test="restore"]')).toBeNull()
    expect(host.textContent).toContain('É a versão atual.')
  })

  it('restaurar: manda expectedRevision = a última que a tela viu, avisa e relê', async () => {
    const restored = vi.fn()
    const host = await mount(undefined, restored)
    await restoreRev2(host)
    expect(restoreCalls()).toEqual([{ kind: 'agent', id: 'theo', revision: 2, expectedRevision: 3 }])
    expect(host.querySelector('[data-test="restored"]')?.textContent).toContain('Restaurado da rev 2 (nova rev 4)')
    expect(restored).toHaveBeenCalledOnce()
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/catalog/history')).toHaveLength(2)
  })

  it('409 de conflito: avisa e recarrega a lista', async () => {
    restoreHandler = () => {
      throw new ApiError(409, 'revision_conflict', 'agent/theo changed', { current: { revision: 4, exists: true } })
    }
    const restored = vi.fn()
    const host = await mount(undefined, restored)
    await restoreRev2(host)
    expect(host.querySelector('[data-test="conflict"]')?.textContent).toContain('Alguém mudou este item')
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/catalog/history')).toHaveLength(2)
    expect(restored).not.toHaveBeenCalled()
  })

  it('409 de ampliação: uma caixa por item, botão desligado até marcar todas, e reenvia com confirm', async () => {
    const widenings = [
      { key: 'agent/theo#allowedTools+cap:terminal', description: 'O agente theo ganha a ferramenta Terminal' },
      { key: 'agent/theo#adminOnly-', description: 'O agente theo deixa de ser só de administradores' },
    ]
    restoreHandler = (body) => {
      if (!body.confirm) throw new ApiError(409, 'widening_confirmation_required', 'This change widens access', { widenings })
      return { kind: 'agent', itemId: 'theo', restoredFrom: 2, unchanged: false, exists: true, alsoChanged: [], widenings, missingSecrets: [] }
    }
    const host = await mount()
    await restoreRev2(host)

    const panel = host.querySelector('[data-test="widening-confirm"]')
    expect(panel?.textContent).toContain('O agente theo ganha a ferramenta Terminal')
    expect(panel?.textContent).toContain('O agente theo deixa de ser só de administradores')
    const submit = () => host.querySelector<HTMLButtonElement>('[data-test="widening-submit"]')!
    const boxes = host.querySelectorAll<HTMLInputElement>('[data-test="widening-confirm"] input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect(submit().disabled).toBe(true)

    await click(boxes[0])
    expect(submit().disabled).toBe(true)
    await click(boxes[1])
    expect(submit().disabled).toBe(false)

    await click(submit())
    expect(restoreCalls()).toEqual([
      { kind: 'agent', id: 'theo', revision: 2, expectedRevision: 3 },
      { kind: 'agent', id: 'theo', revision: 2, expectedRevision: 3, confirm: widenings.map((item) => item.key) },
    ])
    expect(host.querySelector('[data-test="widening-confirm"]')).toBeNull()
    expect(host.querySelector('[data-test="restored"]')).not.toBeNull()
  })

  it('422: mostra os problemas, um por linha', async () => {
    restoreHandler = () => {
      throw new ApiError(422, 'validation_error', 'The version cannot be restored', [
        { field: 'providers', message: 'provider "velho" não existe mais' },
        { field: 'allowedTools', message: 'mcp:crm/* não existe' },
      ])
    }
    const host = await mount()
    await restoreRev2(host)
    const issues = host.querySelectorAll('[data-test="issues"] li')
    expect(issues).toHaveLength(2)
    expect(issues[0].textContent).toContain('providers')
    expect(issues[0].textContent).toContain('provider "velho" não existe mais')
  })

  it('MCP: mostra os segredos que faltam no cofre depois de restaurar', async () => {
    restoreHandler = () => ({ kind: 'mcp', itemId: 'alfa.crm', restoredFrom: 2, unchanged: false, exists: true, alsoChanged: [], widenings: [], missingSecrets: ['CRM_TOKEN'] })
    const host = await mount({ kind: 'mcp', id: 'alfa.crm' })
    await restoreRev2(host)
    expect(host.querySelector('[data-test="missing-secrets"]')?.textContent).toContain('CRM_TOKEN')
  })

  it('só leitura (o membro): sem "Restaurar esta versão"', async () => {
    const host = await mount({ kind: 'mcp', id: 'alfa.crm', readonly: true })
    await click(host.querySelector('[data-revision="2"]'))
    expect(host.querySelector('[data-test="restore"]')).toBeNull()
    expect(host.textContent).toContain('Só quem administra restaura versões.')
  })
})
