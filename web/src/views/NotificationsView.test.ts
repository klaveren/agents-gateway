import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import type { IPermissionRequest } from '@/lib/permissionRequests'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import AccountMenu from '@/components/AccountMenu.vue'
import NotificationsView from './NotificationsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const request = (id: string, overrides: Partial<IPermissionRequest> = {}): IPermissionRequest => ({
  id,
  kind: 'agent-rules',
  agentId: 'theo',
  agentName: 'Theo',
  add: [{ category: 'terminal', pattern: `cmd ${id}`, decision: 'allow' }],
  remove: [],
  widenings: [{ key: `k:${id}`, description: `abre ${id}` }],
  requestedWidenings: [],
  changed: false,
  reason: 'preciso disto',
  requestedBy: { by: 'root@x.test', agentId: 'theo', conversationId: 'c-42' },
  createdAt: '2026-11-03T12:00:00Z',
  expiresAt: '2026-11-10T12:00:00Z',
  status: 'pending',
  ...overrides,
})

let app: App | undefined
let all: IPermissionRequest[]
let order: string[]

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

/** `admin` = administra algum projeto; `gateway` = admin do gateway (sem papel em projeto nenhum). */
async function mount(component: object, admin = true, gateway = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = { name: 'Ana Souza', email: 'ana@x.test' } as never
  auth.isAdmin = gateway
  useProjectsStore().list = [{ id: 'alfa', name: 'Alfa', role: admin ? 'admin' : 'member', createdAt: '', updatedAt: '' }]
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, { placement: 'side' }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const tick = async (box: Element | null | undefined, on = true) => {
  const input = box as HTMLInputElement
  input.checked = on
  input.dispatchEvent(new Event('change'))
  await flush()
}
const item = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-test="request-item"][data-request="${id}"]`)!

const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]')
const confirmDialog = () => click(dialog()?.querySelector('.btn:last-child'))
const listed = () => [...(dialog()?.querySelectorAll('[data-test="bulk-list"] li') ?? [])].map((line) => line.getAttribute('data-request'))
const approveBody = (id: string) => vi.mocked(api).mock.calls.find(([path]) => path === `/permission-requests/${id}/approve`)?.[1]?.body

describe('NotificationsView', () => {
  beforeEach(() => {
    order = []
    all = [
      request('a1', { batchId: 'b1', createdAt: '2026-11-03T12:00:00Z' }),
      request('a2', {
        batchId: 'b1',
        createdAt: '2026-11-03T12:00:01Z',
        widenings: [
          { key: 'k:a2:x', description: 'x' },
          { key: 'k:a2:y', description: 'y' },
        ],
      }),
      request('s1', {
        agentId: undefined,
        agentName: undefined,
        kind: 'project-rules',
        projectId: 'alfa',
        projectName: 'Alfa',
        widenings: [],
        createdAt: '2026-11-02T12:00:00Z',
        requestedBy: { by: 'u', conversationId: 'c-1' },
      }),
      request('e1', { status: 'expired' }),
    ]
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, init?: { body?: unknown }) => {
      if (path === '/permission-requests') return all
      const [, , id, action] = path.split('/')
      if (action === 'approve') {
        order.push(`approve:${id}`)
        if (id === 'a2') throw new ApiError(409, 'widening_confirmation_required', 'x', { widenings: [{ key: 'k:novo', description: 'novo' }] })
        return { request: { ...all.find((r) => r.id === id)!, status: 'approved' }, body: init?.body }
      }
      if (action === 'reject') {
        order.push(`reject:${id}`)
        return { ...all.find((r) => r.id === id)!, status: 'rejected' }
      }
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('uma lista por alvo, com o pedido e o motivo uma vez por chamada; o vencido fica na guia dele', async () => {
    const host = await mount(NotificationsView)
    const groups = [...host.querySelectorAll('[data-test="request-group"]')]
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual(['agent:theo', 'project:alfa'])
    expect(groups.map((group) => group.querySelector('[data-test="group-title"]')?.textContent)).toEqual(['Agente Theo', 'Projeto Alfa'])
    expect([...groups[0].querySelectorAll('[data-test="request-item"]')].map((line) => line.getAttribute('data-request'))).toEqual(['a2', 'a1'])
    // a1 e a2 vieram da mesma chamada: o pedido e o motivo aparecem uma vez
    expect(groups[0].querySelectorAll('[data-test="request-ask"]')).toHaveLength(1)
    expect(groups[0].querySelector('[data-test="request-conversation"]')?.getAttribute('href')).toBe('/c/c-42')
    expect(groups[0].querySelector('[data-test="request-kind"]')?.textContent).toBe('Regra')
    expect(host.querySelector('[data-test="pending-total"]')?.textContent).toContain('3 pedidos')

    expect(host.querySelector('[data-test="expired-section"]')).toBeNull()
    expect(host.querySelector('[data-test="tab-expired"]')?.textContent).toContain('1')
    await click(host.querySelector('[data-test="tab-expired"]'))
    expect(host.querySelector('[data-test="request-group"]')).toBeNull()
    const expired = host.querySelector('[data-test="expired-section"]')!
    expect(expired.querySelectorAll('[data-test="expired-item"]')).toHaveLength(1)
    expect(expired.querySelector('[data-test="widening-confirm"]')).toBeNull()
    await click(expired.querySelector('[data-test="request-discard"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/e1/reject', { method: 'POST', body: {} })
    // sem vencido, a guia some e a tela volta aos pendentes
    expect(host.querySelector('[data-test="tab-expired"]')).toBeNull()
    expect(host.querySelectorAll('[data-test="request-group"]')).toHaveLength(2)
  })

  it('duas chamadas do mesmo agente: cada uma abre com o seu pedido e o seu motivo', async () => {
    all = [request('a1', { batchId: 'b1', reason: 'primeiro' }), request('a3', { batchId: 'b2', reason: 'segundo', createdAt: '2026-11-04T12:00:00Z' })]
    const host = await mount(NotificationsView)
    expect(host.querySelectorAll('[data-test="request-group"]')).toHaveLength(1)
    expect([...host.querySelectorAll('[data-test="request-reason"]')].map((line) => line.textContent)).toEqual(['segundo', 'primeiro'])
  })

  it('vazio: "Nada esperando por você."', async () => {
    all = []
    const host = await mount(NotificationsView)
    expect(host.querySelector('[data-test="notifications-empty"]')?.textContent).toContain('Nada esperando por você.')
    expect(host.querySelector('[data-test="bulk-bar"]')).toBeNull()
  })

  it('aprovar um item manda as chaves dele e só liga com todas as caixas dele marcadas', async () => {
    const host = await mount(NotificationsView)
    const approve = item(host, 'a2').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!
    const [x, y] = item(host, 'a2').querySelectorAll('input[data-key]')
    expect(approve.disabled).toBe(true)
    await tick(x)
    expect(approve.disabled).toBe(true)
    await tick(y)
    expect(approve.disabled).toBe(false)
    // o irmão da mesma chamada não foi tocado
    expect(item(host, 'a1').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(true)
    // sem ampliação, não há o que marcar
    expect(item(host, 's1').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(false)
    await click(approve)
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/a2/approve', { method: 'POST', body: { confirm: ['k:a2:x', 'k:a2:y'] } })
  })

  it('recusar um item não pede caixa nenhuma e o tira da lista', async () => {
    const host = await mount(NotificationsView)
    await click(item(host, 'a1').querySelector('[data-test="item-reject"]'))
    expect(order).toEqual(['reject:a1'])
    expect(host.querySelector('[data-request="a1"]')).toBeNull()
    expect(item(host, 'a2')).toBeTruthy()
  })

  it('"Aprovar todos" mostra a lista antes; confirmada, aprova um por vez com as chaves de cada um, e a falha fica no item', async () => {
    const host = await mount(NotificationsView)
    const all3 = host.querySelector<HTMLButtonElement>('[data-test="approve-all"]')!
    expect(all3.textContent).toContain('Aprovar todos (3)')
    await click(all3)
    expect(dialog()?.textContent).toContain('Aprovar 3 pedidos?')
    expect(dialog()?.textContent).toContain('é exatamente isto que passa a valer')
    expect(listed()).toEqual(['a2', 'a1', 's1'])
    expect(dialog()?.textContent).toContain('Agente Theo (2)')
    expect(dialog()?.textContent).toContain('x; y')
    expect(dialog()?.textContent).toContain('abre a1')
    expect(dialog()?.textContent).toContain('Acrescentar: permitir terminal "cmd s1"')
    expect(order).toEqual([])

    await confirmDialog()
    expect(dialog()).toBeNull()
    expect(order).toEqual(['approve:a2', 'approve:a1', 'approve:s1'])
    expect(approveBody('a1')).toEqual({ confirm: ['k:a1'] })
    expect(approveBody('a2')).toEqual({ confirm: ['k:a2:x', 'k:a2:y'] })
    expect(approveBody('s1')).toEqual({ confirm: [] })
    expect(host.querySelector('[data-request="a1"]')).toBeNull()
    expect(host.querySelector('[data-request="s1"]')).toBeNull()
    // o que o servidor recalculou fica, com o erro nele e a lista nova por confirmar
    expect(item(host, 'a2').querySelector('[data-test="request-error"]')?.textContent).toContain('a lista foi recalculada')
    expect([...item(host, 'a2').querySelectorAll('input[data-key]')].map((box) => box.getAttribute('data-key'))).toEqual(['k:novo'])
    expect(item(host, 'a2').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(true)
    const outcome = host.querySelector('[data-test="bulk-outcome"]')?.textContent?.replace(/\s+/g, ' ').trim()
    expect(outcome).toBe('2 aprovados. 1 não passou: o motivo está em cada um.')
  })

  it('cancelar a confirmação não aprova nada', async () => {
    const host = await mount(NotificationsView)
    await click(host.querySelector('[data-test="approve-all"]'))
    await click(dialog()?.querySelector('.btn:first-child'))
    expect(dialog()).toBeNull()
    expect(order).toEqual([])
    expect(host.querySelectorAll('[data-test="request-item"]')).toHaveLength(3)
  })

  it('"Aprovar todos" de uma lista leva só os pedidos dela; a lista de um pedido só não tem o botão', async () => {
    const host = await mount(NotificationsView)
    expect(host.querySelector('[data-group="project:alfa"] [data-test="group-approve-all"]')).toBeNull()
    const button = host.querySelector<HTMLButtonElement>('[data-group="agent:theo"] [data-test="group-approve-all"]')!
    expect(button.textContent).toContain('Aprovar todos (2)')
    await click(button)
    expect(dialog()?.textContent).toContain('Aprovar 2 pedidos?')
    expect(listed()).toEqual(['a2', 'a1'])
    await confirmDialog()
    expect(order).toEqual(['approve:a2', 'approve:a1'])
    expect(item(host, 's1')).toBeTruthy()
  })

  it('"Recusar todos" lista, confirma e recusa cada um', async () => {
    const host = await mount(NotificationsView)
    await click(host.querySelector('[data-test="reject-all"]'))
    expect(dialog()?.textContent).toContain('Recusar 3 pedidos?')
    expect(dialog()?.textContent).toContain('Nada desta lista passa a valer.')
    expect(order).toEqual([])
    await confirmDialog()
    expect(order).toEqual(['reject:a2', 'reject:a1', 'reject:s1'])
    expect(host.querySelector('[data-test="notifications-empty"]')).toBeTruthy()
    expect(host.querySelector('[data-test="bulk-outcome"]')?.textContent?.trim()).toBe('3 recusados.')
  })

  it('lista com mais de dez pedidos: pagina, e o "Aprovar todos" leva os de todas as páginas', async () => {
    all = Array.from({ length: 12 }, (_, index) => request(`n${index}`, { createdAt: `2026-11-03T12:00:${String(59 - index).padStart(2, '0')}Z` }))
    const host = await mount(NotificationsView)
    expect(host.querySelectorAll('[data-test="request-item"]')).toHaveLength(10)
    expect(host.querySelector('[data-test="group-count"]')?.textContent).toBe('12')
    await click(host.querySelector('[data-group="agent:theo"] [data-test="pager-next"]'))
    expect([...host.querySelectorAll('[data-test="request-item"]')].map((line) => line.getAttribute('data-request'))).toEqual(['n10', 'n11'])
    await click(host.querySelector('[data-test="approve-all"]'))
    expect(listed()).toHaveLength(12)
    await confirmDialog()
    expect(order).toHaveLength(12)
    expect(host.querySelector('[data-test="notifications-empty"]')).toBeTruthy()
    expect(host.querySelector('[data-test="bulk-outcome"]')?.textContent?.trim()).toBe('12 aprovados.')
  })

  it('ferramenta ligada só nesta máquina: diz o que é, onde vale, e a lista do "Aprovar todos" repete', async () => {
    all = [
      request('l1', {
        kind: 'agent-local',
        add: [],
        entries: { field: 'allowedTools', add: ['mcp:github'] },
        widenings: [{ key: 'agent/theo#allowedTools+mcp:github', description: 'Liga o MCP github' }],
      }),
      request('l2', { kind: 'agent-local', add: [], entries: { field: 'allowedTools', add: ['agent:zeus'] }, widenings: [], createdAt: '2026-11-03T11:00:00Z' }),
    ]
    const host = await mount(NotificationsView)
    expect(item(host, 'l1').querySelector('[data-test="request-kind"]')?.textContent).toBe('MCP')
    expect(item(host, 'l2').querySelector('[data-test="request-kind"]')?.textContent).toBe('Delegação')
    expect(item(host, 'l1').querySelector('[data-test="request-local"]')?.textContent).toBe('só nesta máquina')
    expect(item(host, 'l1').querySelector('[data-test="request-entries"]')?.textContent).toBe('Ligar só nesta máquina: mcp:github')
    await click(host.querySelector('[data-test="approve-all"]'))
    expect(dialog()?.textContent).toContain('Liga o MCP github — só nesta máquina')
    expect(dialog()?.textContent).toContain('Ligar só nesta máquina: agent:zeus')
  })

  it('vencidos: "Descartar todos" lista e descarta cada um', async () => {
    all = [request('e1', { status: 'expired' }), request('e2', { status: 'expired', createdAt: '2026-11-01T12:00:00Z' }), request('a1')]
    const host = await mount(NotificationsView)
    await click(host.querySelector('[data-test="tab-expired"]'))
    await click(host.querySelector('[data-test="discard-all"]'))
    expect(dialog()?.textContent).toContain('Descartar 2 pedidos?')
    expect(listed()).toEqual(['e1', 'e2'])
    await confirmDialog()
    expect(order).toEqual(['reject:e1', 'reject:e2'])
    expect(host.querySelector('[data-test="bulk-outcome"]')?.textContent?.trim()).toBe('2 descartados.')
    expect(item(host, 'a1')).toBeTruthy()
  })

  describe('pedido de variável secreta', () => {
    const secret = (id: string) =>
      request(id, {
        kind: 'secret',
        add: [],
        secret: { scope: 'skill', scopeId: 'gitlab', name: 'GITLAB_TOKEN', description: 'token da API' },
        widenings: [{ key: 'secret/skill/gitlab#GITLAB_TOKEN', description: 'Variável secreta GITLAB_TOKEN' }],
        createdAt: '2026-11-04T12:00:00Z',
      })
    const typeValue = async (host: HTMLElement, id: string, value: string) => {
      const input = item(host, id).querySelector<HTMLInputElement>('[data-test="secret-value"]')!
      input.value = value
      input.dispatchEvent(new Event('input'))
      await flush()
    }

    it('pedido de um projeto que recebe o compartilhamento diz "valor do projeto <nome>"; o da origem não diz', async () => {
      all = [
        request('p1', {
          kind: 'secret',
          add: [],
          secret: { scope: 'skill', scopeId: 'gitlab', name: 'T', project: 'alfa' },
          widenings: [{ key: 'secret/skill/gitlab#T', description: 'x' }],
          createdAt: '2026-11-04T12:00:00Z',
        }),
        secret('v1'),
      ]
      const host = await mount(NotificationsView)
      expect(item(host, 'p1').querySelector('[data-test="secret-project"]')?.textContent?.trim()).toBe('valor do projeto Alfa')
      expect(item(host, 'v1').querySelector('[data-test="secret-project"]')).toBeNull()
      // a variável da skill tem a lista dela
      expect(host.querySelector('[data-test="group-title"]')?.textContent).toBe('Skill gitlab')
    })

    it('mostra nome, escopo, descrição e motivo; Aprovar só liga com a caixa E o valor; manda { confirm, value } e limpa', async () => {
      all = [secret('v1')]
      const host = await mount(NotificationsView)
      expect(item(host, 'v1').querySelector('[data-test="request-kind"]')?.textContent).toBe('Variável secreta')
      expect(item(host, 'v1').textContent).toContain('Variável secreta pedida: GITLAB_TOKEN para skill gitlab')
      expect(item(host, 'v1').textContent).toContain('token da API')
      expect(host.textContent).toContain('preciso disto')
      expect(item(host, 'v1').querySelector<HTMLInputElement>('[data-test="secret-value"]')!.type).toBe('password')
      const approve = item(host, 'v1').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!
      await tick(item(host, 'v1').querySelector('input[data-key]'))
      expect(approve.disabled).toBe(true)
      await typeValue(host, 'v1', 's3gredo')
      expect(approve.disabled).toBe(false)
      await tick(item(host, 'v1').querySelector('input[data-key]'), false)
      expect(approve.disabled).toBe(true)
      await tick(item(host, 'v1').querySelector('input[data-key]'))
      await click(approve)
      expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/v1/approve', { method: 'POST', body: { confirm: ['secret/skill/gitlab#GITLAB_TOKEN'], value: 's3gredo' } })
      expect(host.innerHTML).not.toContain('s3gredo')
    })

    it('fica fora do "Aprovar todos" (só vale com o valor digitado), e a confirmação avisa; entra no "Recusar todos"', async () => {
      all = [secret('v1'), request('a1')]
      const host = await mount(NotificationsView)
      expect(host.querySelector('[data-test="approve-all"]')!.textContent).toContain('Aprovar todos (1)')
      await click(host.querySelector('[data-test="approve-all"]'))
      expect(dialog()?.textContent).toContain('Aprovar 1 pedido?')
      expect(listed()).toEqual(['a1'])
      expect(dialog()?.querySelector('[data-test="bulk-skipped"]')?.textContent).toContain('1 variável secreta fica de fora')
      await confirmDialog()
      expect(order).toEqual(['approve:a1'])
      expect(item(host, 'v1')).toBeTruthy()

      await click(host.querySelector('[data-test="reject-all"]'))
      expect(listed()).toEqual(['v1'])
      expect(dialog()?.querySelector('[data-test="bulk-skipped"]')).toBeNull()
    })

    it('só variável secreta esperando: o "Aprovar todos" fica desligado', async () => {
      all = [secret('v1')]
      const host = await mount(NotificationsView)
      expect(host.querySelector<HTMLButtonElement>('[data-test="approve-all"]')!.disabled).toBe(true)
    })
  })
})

describe('NotificationsView: quem entra', () => {
  beforeEach(() => {
    all = [request('a1')]
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async () => all)
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('o admin do gateway sem papel em projeto e o membro não veem a tela', async () => {
    const gateway = await mount(NotificationsView, false, true)
    expect(gateway.textContent).toContain('Só quem administra um projeto vê as notificações.')
    app?.unmount()
    const member = await mount(NotificationsView, false)
    expect(member.textContent).toContain('Só quem administra um projeto vê as notificações.')
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })
})

describe('AccountMenu: selo e item Notificações', () => {
  beforeEach(() => {
    all = [request('a1'), request('a2'), request('e1', { status: 'expired' })]
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/permission-requests') return all
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('admin: o selo conta só os pendentes e o menu leva a /notifications', async () => {
    const host = await mount(AccountMenu)
    expect(host.querySelector('[data-test="notifications-badge"]')?.textContent).toBe('2')
    await click(host.querySelector('button'))
    const link = host.querySelector('[data-test="notifications-item"]')
    expect(link?.getAttribute('href')).toBe('/notifications')
    expect(link?.textContent).toContain('Notificações')
    expect(host.querySelector('[data-test="notifications-pill"]')?.textContent).toBe('2')
  })

  it('admin do gateway sem papel em projeto: sem selo, sem item e sem ler a lista', async () => {
    vi.mocked(api).mockClear()
    const host = await mount(AccountMenu, false, true)
    await click(host.querySelector('button'))
    expect(host.querySelector('[data-test="notifications-item"]')).toBeNull()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('sem pendente, sem selo; quem não é admin não vê o selo, o item nem lê a lista', async () => {
    all = [request('e1', { status: 'expired' })]
    const host = await mount(AccountMenu)
    expect(host.querySelector('[data-test="notifications-badge"]')).toBeNull()
    app?.unmount()
    all = [request('a1')]
    vi.mocked(api).mockClear()
    const plain = await mount(AccountMenu, false)
    await click(plain.querySelector('button'))
    expect(plain.querySelector('[data-test="notifications-badge"]')).toBeNull()
    expect(plain.querySelector('[data-test="notifications-item"]')).toBeNull()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })
})
