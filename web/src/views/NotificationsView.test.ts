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
const buttons = (host: HTMLElement, text: string) => [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)

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
      if (action === 'reject') return { ...all.find((r) => r.id === id)!, status: 'rejected' }
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('agrupa por batchId (sem ele, o pedido é o próprio lote) e põe o vencido numa seção à parte', async () => {
    const host = await mount(NotificationsView)
    const groups = [...host.querySelectorAll('[data-test="request-group"]')]
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual(['batch:b1', 'solo:s1'])
    expect(groups[0].querySelectorAll('[data-test="request-item"]')).toHaveLength(2)
    expect(groups[0].querySelector('[data-test="request-conversation"]')?.getAttribute('href')).toBe('/c/c-42')
    expect(groups[1].textContent).toContain('projeto Alfa')
    const expired = host.querySelector('[data-test="expired-section"]')!
    expect(expired.querySelectorAll('[data-test="expired-item"]')).toHaveLength(1)
    expect(expired.querySelector('[data-test="widening-confirm"]')).toBeNull()
    await click(expired.querySelector('[data-test="request-discard"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/e1/reject', { method: 'POST', body: {} })
  })

  it('vazio: "Nada esperando por você."', async () => {
    all = []
    const host = await mount(NotificationsView)
    expect(host.querySelector('[data-test="notifications-empty"]')?.textContent).toContain('Nada esperando por você.')
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
    // o irmão do lote não foi tocado
    expect(item(host, 'a1').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(true)
    await click(approve)
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/a2/approve', { method: 'POST', body: { confirm: ['k:a2:x', 'k:a2:y'] } })
  })

  it('em lote: só aprova o que está todo marcado, um de cada vez, depois de confirmar; a falha aparece no item', async () => {
    const host = await mount(NotificationsView)
    // a1 inteiro marcado, a2 só com uma caixa, s1 (sem ampliação) escolhido
    await tick(item(host, 'a1').querySelector('input[data-key]'))
    await tick(item(host, 'a2').querySelector('input[data-key]'))
    await tick(item(host, 's1').querySelector('[data-test="item-select"]'))
    const bulk = host.querySelector<HTMLButtonElement>('[data-test="approve-selected"]')!
    expect(bulk.textContent).toContain('Aprovar marcados (2)')
    await click(bulk)
    expect(document.body.textContent).toContain('Aprovar 2 pedidos?')
    expect(document.body.textContent).toContain('Isto amplia o acesso dos agentes listados.')
    expect(order).toEqual([])
    await click(buttons(document.body as unknown as HTMLElement, 'Aprovar').find((b) => b.classList.contains('btn') && b.closest('[role="alertdialog"]')))
    expect(order).toEqual(['approve:a1', 'approve:s1'])
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/s1/approve', { method: 'POST', body: { confirm: [] } })
    expect(host.querySelector('[data-request="a1"]')).toBeNull()
  })

  it('a falha de um item do lote mostra o erro nele (409 recalcula e desmarca) e segue com os outros', async () => {
    const host = await mount(NotificationsView)
    await tick(host.querySelector('[data-test="select-all"]'))
    expect(host.querySelector('[data-test="approve-selected"]')!.textContent).toContain('(3)')
    await click(host.querySelector('[data-test="approve-selected"]'))
    await click(document.body.querySelector('[role="alertdialog"] .btn:last-child'))
    expect(order.sort()).toEqual(['approve:a1', 'approve:a2', 'approve:s1'])
    expect(item(host, 'a2').querySelector('[data-test="request-error"]')?.textContent).toContain('a lista foi recalculada')
    expect(item(host, 'a2').querySelectorAll('input[data-key]')).toHaveLength(1)
    expect(item(host, 'a2').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(true)
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

    it('mostra nome, escopo, descrição e motivo; Aprovar só liga com a caixa E o valor; manda { confirm, value } e limpa', async () => {
      all = [secret('v1')]
      const host = await mount(NotificationsView)
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

    it('em lote, o secreto sem valor não conta como marcado', async () => {
      all = [secret('v1'), request('a1')]
      const host = await mount(NotificationsView)
      await tick(host.querySelector('[data-test="select-all"]'))
      expect(host.querySelector('[data-test="approve-selected"]')!.textContent).toContain('(1)')
      await typeValue(host, 'v1', 'abc')
      expect(host.querySelector('[data-test="approve-selected"]')!.textContent).toContain('(2)')
      await typeValue(host, 'v1', '')
      expect(host.querySelector('[data-test="approve-selected"]')!.textContent).toContain('(1)')
    })
  })

  it('"Marcar todos do lote" marca só o lote', async () => {
    const host = await mount(NotificationsView)
    await tick(host.querySelector('[data-group="batch:b1"] [data-test="group-toggle"]'))
    expect(host.querySelector('[data-test="approve-selected"]')!.textContent).toContain('(2)')
    expect(item(host, 'a1').querySelector<HTMLButtonElement>('[data-test="item-approve"]')!.disabled).toBe(false)
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
