import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import ModelGroupsView from './ModelGroupsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const PADRAO = { id: 'padrao', name: 'Padrão', steps: [{ provider: 'claude', model: 'sonnet' }], switchOn: ['quota'] }
const RAPIDO = {
  id: 'rapido',
  name: 'Rápido',
  steps: [
    { provider: 'openai', model: 'mini' },
    { provider: 'claude', model: 'haiku' },
  ],
}

interface ICall {
  path: string
  init?: { method?: string; body?: unknown }
}

async function mount(path: string, options: { groups?: unknown[]; defaultGroup?: string; putError?: ApiError } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
  const calls: ICall[] = []
  vi.mocked(api).mockImplementation(async (url: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path: url, init })
    if (url === '/settings' && init?.method === 'PUT') {
      if (options.putError) throw options.putError
      return {}
    }
    if (url === '/settings') return { audience: 'all', modelGroups: options.groups ?? [PADRAO, RAPIDO], defaultModelGroup: options.defaultGroup ?? 'padrao' }
    if (url === '/agents') return [{ id: 'a1', name: 'Agente Um', providers: [], modes: ['chat'], allowedTools: [], modelGroup: 'rapido' }]
    if (url === '/providers')
      return [
        { id: 'claude', name: 'Claude', enabled: true, subscription: false, credential: { configured: true } },
        { id: 'openai', name: 'OpenAI', enabled: true, subscription: false, credential: { configured: true } },
      ]
    if (url === '/providers/claude/models')
      return [
        { modelId: 'sonnet', enabled: true },
        { modelId: 'haiku', enabled: true },
      ]
    if (url === '/providers/openai/models') return [{ modelId: 'mini', enabled: true }]
    return []
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/model-groups', name: 'model-groups', component: ModelGroupsView },
      { path: '/model-groups/new', name: 'model-group-new', component: ModelGroupsView },
      { path: '/model-groups/:id', name: 'model-group', component: ModelGroupsView, props: true },
      { path: '/agents/:id', component: { render: () => h('div') } },
    ],
  })
  await router.push(path)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(RouterView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, calls, router }
}

const putOf = (calls: ICall[]) => calls.find((call) => call.path === '/settings' && call.init?.method === 'PUT')
const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)

function fill(element: Element | null, value: string) {
  expect(element, 'o campo existe').toBeTruthy()
  const input = element as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('ModelGroupsView', () => {
  it('lista o nome, o id, os passos, o selo de padrão e quantos agentes usam o grupo', async () => {
    const { host } = await mount('/model-groups')
    const text = host.textContent ?? ''
    expect(text).toContain('Padrão')
    expect(text).toContain('padrao · 1 passo · 0 agentes + os sem sequência')
    expect(text).toContain('padrão')
    expect(text).toContain('rapido · 2 passos · 1 agente')
  })

  it('criar manda a lista INTEIRA com o grupo novo, com os padrões de troca marcados', async () => {
    const { host, calls } = await mount('/model-groups/new')
    const checked = [...host.querySelectorAll<HTMLInputElement>('fieldset input[type=checkbox]')].map((box) => box.checked)
    expect(checked).toEqual([true, true, true, false, false])
    fill(host.querySelector('input[aria-label="Identificador"]'), 'novo')
    fill(host.querySelector('input[aria-label="Nome"]'), 'Novo grupo')
    await flush()
    const select = [...host.querySelectorAll('select')].find((item) => item.textContent?.includes('Adicionar passo'))!
    select.value = 'claude::haiku'
    select.dispatchEvent(new Event('change'))
    await flush()
    ;[...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Adicionar')!.click()
    await flush()
    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()
    const body = putOf(calls)?.init?.body as { modelGroups: Array<{ id: string }> }
    expect(body.modelGroups.map((group) => group.id)).toEqual(['padrao', 'rapido', 'novo'])
    expect(body.modelGroups[2]).toMatchObject({ id: 'novo', name: 'Novo grupo', steps: [{ provider: 'claude', model: 'haiku' }], switchOn: ['quota', 'rate_limit', 'model'] })
  })

  it('"Tornar padrão" grava defaultModelGroup', async () => {
    const { calls } = await mount('/model-groups/rapido')
    button('Tornar padrão')!.click()
    await flush()
    expect(putOf(calls)?.init?.body).toEqual({ defaultModelGroup: 'rapido' })
  })

  it('apagar um grupo em uso mostra a mensagem do servidor e mantém o diálogo', async () => {
    const putError = new ApiError(422, 'validation', 'invalid', [{ field: 'modelGroups', message: 'rapido is used by agent a1' }])
    const { calls } = await mount('/model-groups/rapido', { putError })
    button('Apagar')!.click()
    await flush()
    document.querySelector<HTMLButtonElement>('[role=alertdialog] button.btn:last-child')!.click()
    await flush()
    expect((putOf(calls)?.init?.body as { modelGroups: unknown[] }).modelGroups).toHaveLength(1)
    expect(document.querySelector('[role=alertdialog]')?.textContent).toContain('rapido is used by agent a1')
  })

  it('mostra os agentes que usam o grupo', async () => {
    const { host } = await mount('/model-groups/rapido')
    expect(host.textContent).toContain('Agente Um')
  })
})
