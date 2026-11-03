import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import { contextKey, filterContexts, type ILedgerContext, type ILedgerIndex, type ILedgerWriteResult, snapshotText } from '@/lib/ledger'
import { useLedgerStore } from '@/stores/ledger'
import AgentLedger from './AgentLedger.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const AGENT = { kind: 'agent' as const, agentId: 'theo', conversationId: 'c-1' }
const ADMIN = { kind: 'admin' as const, email: 'root@x.test' }
const AT = '2026-11-03T12:00:00Z'

const line = {
  id: 7,
  date: '2026-11-01',
  type: 'APRENDIZADO' as const,
  trigger: 'build no CI',
  learning: 'subir o heap para 4 GB',
  ref: 'ci.yml',
  createdAt: AT,
  createdBy: AGENT,
  updatedAt: AT,
  updatedBy: AGENT,
}

function context(overrides: Partial<ILedgerContext> = {}): ILedgerContext {
  return {
    topic: 'build-oom',
    trigger: 'quando o build estourar memória no CI',
    lineCount: 1,
    hasPlaybook: true,
    createdAt: AT,
    createdBy: AGENT,
    updatedAt: AT,
    updatedBy: AGENT,
    warnings: [],
    playbook: '## Heap\n- **4 GB**',
    lines: [line],
    ...overrides,
  }
}

function index(
  contexts: ILedgerContext[] = [
    context(),
    context({
      topic: 'deploy',
      trigger: 'RETOMAR o deploy amanhã cedo',
      lineCount: 0,
      hasPlaybook: false,
      lines: [],
      playbook: '',
      warnings: [{ code: 'state-verb', topic: 'deploy', message: 'deploy: o gatilho tem "retomar"' }],
    }),
  ],
): ILedgerIndex {
  return {
    agentId: 'theo',
    contexts: contexts.map(({ playbook: _playbook, lines: _lines, ...summary }) => summary),
    lineCount: contexts.reduce((total, item) => total + item.lines.length, 0),
    warnings: [...contexts.flatMap((item) => item.warnings), { code: 'too-many-lines', message: '41 linhas (meta: < 40)' }],
  }
}

const written = (next: ILedgerContext | undefined, action: string, topic = 'build-oom'): ILedgerWriteResult => ({
  action,
  topic,
  ...(next ? { context: next } : {}),
  index: index(next ? [next] : []),
  warnings: [],
  changed: true,
})

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AgentLedger, { agentId: 'theo' }) })
  app.use(pinia).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const type = async (element: Element | null | undefined, value: string) => {
  expect(element, 'o campo existe').toBeTruthy()
  const field = element as HTMLInputElement
  field.value = value
  field.dispatchEvent(new Event('input'))
  await flush()
}
const button = (host: ParentNode, text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent?.trim().startsWith(text))

describe('AgentLedger (guia Memória)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && path === '/agents/theo/ledger') return index()
      if (method === 'GET' && path === '/agents/theo/ledger/contexts/build-oom') return context()
      if (method === 'GET' && path === '/agents/theo/ledger/contexts/build-oom/revisions')
        return [
          {
            id: 2,
            topic: 'build-oom',
            action: 'gatilho',
            at: AT,
            by: ADMIN,
            before: { trigger: 'quando o build cair', playbook: '' },
            after: { trigger: 'quando o build estourar memória no CI', playbook: '' },
          },
          { id: 1, topic: 'build-oom', action: 'criar', at: AT, by: AGENT, after: { trigger: 'quando o build cair', playbook: '' } },
        ]
      if (method === 'GET' && path === '/agents/theo/ledger/search') return { contexts: [], lines: [{ ...line, topic: 'build-oom' }] }
      if (method === 'PUT' && path === '/agents/theo/ledger/contexts/build-oom') return written(context({ ...(init?.body as object), updatedBy: ADMIN }), 'gatilho')
      if (method === 'POST' && path === '/agents/theo/ledger/contexts/build-oom/lines')
        return written(context({ lines: [line, { ...line, id: 8, ...(init?.body as object), updatedBy: ADMIN }], lineCount: 2 }), 'linha_nova')
      if (method === 'PUT' && path === '/agents/theo/ledger/contexts/build-oom/lines/7')
        return written(context({ lines: [{ ...line, ...(init?.body as object) }] }), 'linha_editar')
      if (method === 'DELETE' && path === '/agents/theo/ledger/contexts/build-oom/lines/7') return written(context({ lines: [], lineCount: 0 }), 'linha_apagar')
      if (method === 'DELETE' && path === '/agents/theo/ledger/contexts/build-oom') return written(undefined, 'excluir')
      if (method === 'POST' && path === '/agents/theo/ledger/contexts')
        return written(context({ topic: 'wireguard', trigger: 'quando a VPN entre nós cair', lines: [], playbook: '' }), 'criar', 'wireguard')
      throw new Error(`inesperado: ${method} ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('lista os contextos com gatilho, linhas, última mudança e os selos de saúde; avisos do ledger inteiro no topo', async () => {
    const host = await mount()
    const rows = host.querySelectorAll('[data-test="ledger-contexts"] > li')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('build-oom')
    expect(rows[0].textContent).toContain('quando o build estourar memória no CI')
    expect(rows[0].textContent).toContain('1 linha(s) · playbook')
    expect(rows[0].textContent).toContain('theo · conversa c-1')
    expect(rows[1].querySelector('[data-test="ledger-badge"]')?.textContent?.trim()).toBe('estado de missão')
    expect(host.querySelector('[data-test="ledger-warnings"]')?.textContent).toContain('41 linhas')
  })

  it('o filtro: tema ou gatilho, sem acento; Enter busca nas linhas no servidor', async () => {
    const host = await mount()
    await type(host.querySelector('[data-test="ledger-filter"]'), 'MEMORIA')
    expect(host.querySelectorAll('[data-test="ledger-contexts"] > li')).toHaveLength(1)
    await click(button(host, 'Buscar nas linhas'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/search', { query: { q: 'MEMORIA' } })
    expect(host.querySelector('[data-test="ledger-found"]')?.textContent).toContain('build-oom #7 [2026-11-01] | APRENDIZADO | build no CI | subir o heap para 4 GB | ci.yml')
  })

  it('abre o contexto, pré-visualiza o playbook e salva o gatilho: a resposta entra na store (índice e contexto), sem reler', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="ledger-contexts"] button'))
    expect(host.querySelector('[data-test="ledger-lines"]')?.textContent).toContain('#7 [2026-11-01] | APRENDIZADO | build no CI')
    await click(button(host, 'Pré-visualizar'))
    expect(host.querySelector('[data-test="ledger-preview"]')?.innerHTML).toContain('<strong>4 GB</strong>')
    await click(button(host, 'Editar'))

    const save = host.querySelector<HTMLButtonElement>('[data-test="ledger-save"]')!
    expect(save.disabled).toBe(true)
    await type(host.querySelector('[data-test="ledger-trigger"]'), 'quando o build do front estourar memória')
    expect(save.disabled).toBe(false)
    const calls = vi.mocked(api).mock.calls.length
    await click(save)
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts/build-oom', { method: 'PUT', body: { trigger: 'quando o build do front estourar memória' } })
    expect(vi.mocked(api).mock.calls.length).toBe(calls + 1)
    const store = useLedgerStore()
    expect(store.contexts.get(contextKey('theo', 'build-oom'))?.trigger).toBe('quando o build do front estourar memória')
    expect(store.indexes.get('theo')?.contexts[0].updatedBy).toEqual(ADMIN)
  })

  it('linhas: acrescenta, edita e apaga (com confirmação)', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="ledger-contexts"] button'))
    await type(host.querySelector('[data-test="ledger-line-trigger"]'), 'deploy no k8s')
    await type(host.querySelector('[data-test="ledger-line-learning"]'), 'usar --wait no rollout')
    await click(host.querySelector('[data-test="ledger-line-add"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts/build-oom/lines', {
      method: 'POST',
      body: { type: 'APRENDIZADO', trigger: 'deploy no k8s', learning: 'usar --wait no rollout' },
    })
    expect(host.querySelector('[data-test="ledger-lines"]')?.textContent).toContain('#8')

    await click(button(host.querySelector('[data-test="ledger-lines"]')!, 'editar'))
    const edit = host.querySelector('[data-test="ledger-line-edit"]')!
    await type(edit.querySelectorAll('input')[2], 'subir o heap para 6 GB')
    await click(host.querySelector('[data-test="ledger-line-save"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts/build-oom/lines/7', {
      method: 'PUT',
      body: { type: 'APRENDIZADO', trigger: 'build no CI', learning: 'subir o heap para 6 GB', ref: 'ci.yml', date: '2026-11-01' },
    })
    expect(host.querySelector('[data-test="ledger-lines"]')?.textContent).toContain('subir o heap para 6 GB')

    await click(button(host.querySelector('[data-test="ledger-lines"]')!, 'apagar'))
    expect(document.body.textContent).toContain('Apagar a linha #7?')
    await click(button(document.body.querySelector('[role="alertdialog"]')!, 'Apagar'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts/build-oom/lines/7', { method: 'DELETE' })
    expect(host.querySelector('[data-test="ledger-lines"]')?.textContent).toContain('Sem linhas.')
  })

  it('o histórico do contexto: quem (agente ou admin), o quê, antes e depois', async () => {
    const host = await mount()
    await click(host.querySelector('[data-test="ledger-contexts"] button'))
    await click(host.querySelector('[data-test="ledger-history-toggle"]'))
    const items = host.querySelectorAll('[data-test="ledger-history"] > li')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('root@x.test mudou o gatilho')
    expect(items[0].textContent).toContain('− Gatilho: quando o build cair')
    expect(items[0].textContent).toContain('+ Gatilho: quando o build estourar memória no CI')
    expect(items[1].textContent).toContain('theo · conversa c-1 criou o contexto')
  })

  it('criar um contexto e excluir outro', async () => {
    const host = await mount()
    await click(button(host, '+ Novo contexto'))
    await type(host.querySelector('[data-test="ledger-topic"]'), 'WireGuard')
    await type(host.querySelector('[data-test="ledger-trigger"]'), 'quando a VPN entre nós cair')
    await click(host.querySelector('[data-test="ledger-create"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts', { method: 'POST', body: { topic: 'WireGuard', trigger: 'quando a VPN entre nós cair' } })
    expect(host.querySelector('[data-test="ledger-context"] h3')?.textContent).toBe('Contexto wireguard')

    app?.unmount()
    const again = await mount()
    await click(again.querySelector('[data-test="ledger-contexts"] button'))
    await click(button(again, 'Excluir contexto'))
    await click(button(document.body.querySelector('[role="alertdialog"]')!, 'Apagar'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/ledger/contexts/build-oom', { method: 'DELETE' })
    expect(again.querySelector('[data-test="ledger-context"]')).toBeNull()
    expect(useLedgerStore().indexes.get('theo')?.contexts).toEqual([])
  })

  it('Exportar baixa o .tar.gz com o nome que o servidor deu', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Blob(['tar']), { status: 200, headers: { 'content-disposition': 'attachment; filename="theo-ledger-2026-11-03.tar.gz"' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const created = vi.fn(() => 'blob:x')
    URL.createObjectURL = created as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn()
    let downloaded = ''
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloaded = this.download
    }
    try {
      const host = await mount()
      await click(host.querySelector('[data-test="ledger-export"]'))
      expect(fetchMock).toHaveBeenCalledWith('/v1/agents/theo/ledger/export', expect.objectContaining({ headers: expect.objectContaining({ 'X-Gateway-Client': 'web' }) }))
      expect(downloaded).toBe('theo-ledger-2026-11-03.tar.gz')
    } finally {
      HTMLAnchorElement.prototype.click = original
    }
  })
})

describe('lib/ledger', () => {
  it('o filtro casa todas as palavras, sem acento; a revisão de exclusão mostra as linhas que saíram', () => {
    const list = [
      { topic: 'build-oom', trigger: 'quando o build estourar memória' },
      { topic: 'deploy', trigger: 'quando subir para produção' },
    ]
    expect(filterContexts(list, 'producao subir').map((item) => item.topic)).toEqual(['deploy'])
    expect(filterContexts(list, '  ')).toHaveLength(2)
    expect(
      snapshotText({ trigger: 'quando x acontecer', playbook: '', lines: [{ id: 1, date: '2026-11-01', type: 'POSTURA', trigger: 'review', learning: 'perguntar', ref: '' }] }),
    ).toBe('Gatilho: quando x acontecer\n#1 [2026-11-01] | POSTURA | review | perguntar')
  })
})
