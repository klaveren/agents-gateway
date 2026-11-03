import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { type IPermissionRequest, pendingCount } from '@/lib/permissionRequests'
import { usePermissionRequestsStore } from '@/stores/permissionRequests'
import PermissionRequests from './PermissionRequests.vue'
import PermissionRequestsBadge from './PermissionRequestsBadge.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const request = (overrides: Partial<IPermissionRequest> = {}): IPermissionRequest => ({
  id: 'pr-1',
  kind: 'agent-rules',
  agentId: 'theo',
  agentName: 'Theo',
  add: [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }],
  remove: [{ category: 'terminal', pattern: 'git push *', decision: 'deny' }],
  widenings: [
    { key: 'agent/theo#permissions+allow:terminal:npm test', description: 'Agente theo: permite terminal "npm test"' },
    { key: 'agent/theo#permissions-deny:terminal:git push *', description: 'Agente theo: remove a negação de terminal "git push *"' },
  ],
  requestedWidenings: [],
  changed: false,
  reason: 'rodar os testes',
  requestedBy: { by: 'root@x.test', agentId: 'theo', conversationId: 'c-42' },
  createdAt: '2026-11-03T12:00:00Z',
  expiresAt: '2026-11-10T12:00:00Z',
  status: 'pending',
  ...overrides,
})

let app: App | undefined
let lists: Record<string, IPermissionRequest[]>

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(props: { agentId?: string; projectId?: string }, onApproved = vi.fn()) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(PermissionRequests, { ...props, onApproved }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}

const check = async (host: HTMLElement) => {
  for (const box of host.querySelectorAll<HTMLInputElement>('[data-test="widening-confirm"] input[type="checkbox"]')) {
    box.checked = true
    box.dispatchEvent(new Event('change'))
  }
  await flush()
}

describe('PermissionRequests (Pedidos pendentes)', () => {
  beforeEach(() => {
    lists = {
      '/agents/theo/permission-requests': [request()],
      '/projects/alfa/permission-requests': [request({ id: 'pr-9', kind: 'project-rules', agentId: undefined, projectId: 'alfa' })],
    }
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, init?: { body?: unknown }) => {
      if (path in lists) return lists[path]
      if (path === '/permission-requests/pr-1/approve')
        return { request: request({ status: 'approved' }), permissions: [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }], body: init?.body }
      if (path === '/permission-requests/pr-1/reject') return request({ status: 'rejected' })
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('mostra quem pediu (com a conversa), o motivo, as regras e uma caixa por ampliação; Aprovar só com todas marcadas', async () => {
    const host = await mount({ agentId: 'theo' })
    expect(host.textContent).toContain('Pedidos pendentes (1)')
    expect(host.querySelector('[data-test="request-reason"]')?.textContent).toBe('rodar os testes')
    expect(host.querySelector('[data-test="request-conversation"]')?.getAttribute('href')).toBe('/c/c-42')
    expect(host.textContent).toContain('Acrescentar: permitir terminal "npm test"')
    expect(host.textContent).toContain('Tirar: negar terminal "git push *"')
    const submit = host.querySelector<HTMLButtonElement>('[data-test="widening-submit"]')!
    expect(submit.disabled).toBe(true)
    const [first] = host.querySelectorAll<HTMLInputElement>('[data-test="widening-confirm"] input[type="checkbox"]')
    first.checked = true
    first.dispatchEvent(new Event('change'))
    await flush()
    expect(submit.disabled).toBe(true)
  })

  it('aprovar manda exatamente as chaves, tira o pedido da lista e avisa com as regras gravadas', async () => {
    const onApproved = vi.fn()
    const host = await mount({ agentId: 'theo' }, onApproved)
    await check(host)
    await click(host.querySelector('[data-test="widening-submit"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/pr-1/approve', {
      method: 'POST',
      body: { confirm: ['agent/theo#permissions+allow:terminal:npm test', 'agent/theo#permissions-deny:terminal:git push *'] },
    })
    expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ id: 'pr-1', status: 'approved' }), [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }])
    expect(host.querySelector('[data-test="permission-requests"]')).toBeNull()
  })

  it('o agente mudou no meio (409): a lista recalculada entra e as caixas voltam desmarcadas', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path in lists) return lists[path]
      throw new ApiError(409, 'widening_confirmation_required', 'confirm', { widenings: [request().widenings[1]] })
    })
    const host = await mount({ agentId: 'theo' })
    await check(host)
    await click(host.querySelector('[data-test="widening-submit"]'))
    expect(host.querySelector('[data-test="request-error"]')?.textContent).toContain('a lista foi recalculada')
    expect(host.querySelectorAll('[data-test="widening-confirm"] input[type="checkbox"]')).toHaveLength(1)
    expect(host.textContent).toContain('mudaram desde o pedido')
  })

  it('recusar não pede caixa marcada; o vencido só se descarta', async () => {
    const host = await mount({ agentId: 'theo' })
    await click(host.querySelector('[data-test="widening-cancel"]'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/permission-requests/pr-1/reject', { method: 'POST', body: {} })

    app?.unmount()
    lists['/agents/theo/permission-requests'] = [request({ status: 'expired' })]
    const expired = await mount({ agentId: 'theo' })
    expect(expired.querySelector('[data-test="request-expired"]')).toBeTruthy()
    expect(expired.querySelector('[data-test="widening-submit"]')).toBeNull()
    expect(expired.textContent).toContain('Pedidos pendentes (0)')
  })

  it('as regras de um projeto: a lista do projeto', async () => {
    const host = await mount({ projectId: 'alfa' })
    expect(vi.mocked(api)).toHaveBeenCalledWith('/projects/alfa/permission-requests')
    expect(host.querySelector('[data-request="pr-9"]')).toBeTruthy()
    expect(host.textContent).toContain('dos agentes deste projeto')
  })

  it('aprovar atualiza também a lista de todos (o selo da lista de agentes)', async () => {
    lists['/permission-requests'] = [request()]
    const host = await mount({ agentId: 'theo' })
    const store = usePermissionRequestsStore()
    await store.lists.ensure('')
    expect(pendingCount(store.lists.get(''), { agentId: 'theo' })).toBe(1)
    await check(host)
    await click(host.querySelector('[data-test="widening-submit"]'))
    expect(pendingCount(store.lists.get(''), { agentId: 'theo' })).toBe(0)
  })
})

describe('PermissionRequestsBadge e pendingCount', () => {
  it('conta só os pendentes do alvo (vencido e de outro não contam); sem pendente, sem selo', async () => {
    const all = [
      request(),
      request({ id: 'b', status: 'expired' }),
      request({ id: 'c', agentId: 'ana' }),
      request({ id: 'd', kind: 'project-rules', agentId: undefined, projectId: 'alfa' }),
    ]
    expect(pendingCount(all, { agentId: 'theo' })).toBe(1)
    expect(pendingCount(all, { projectId: 'alfa' })).toBe(1)
    const host = document.createElement('div')
    const badge = createApp({ render: () => h('div', [h(PermissionRequestsBadge, { count: 2 }), h(PermissionRequestsBadge, { count: 0 })]) })
    badge.mount(host)
    await nextTick()
    const shown = host.querySelectorAll('[data-test="permission-requests-badge"]')
    expect(shown).toHaveLength(1)
    expect(shown[0].textContent).toBe('2 pedidos')
    badge.unmount()
  })
})
