import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import ProjectModels from './ProjectModels.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const PROVIDERS = [{ id: 'claude', name: 'Claude', protocol: 'claude', official: true, enabled: true, credential: { configured: true, source: 'stored' } }]
const MODELS = [
  { modelId: 'opus', enabled: true, available: true },
  { modelId: 'haiku', enabled: true, available: true },
  { modelId: 'velho', enabled: false, available: true },
]

let app: App | undefined
const flush = async () => {
  for (let index = 0; index < 6; index++) await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function mount(view: unknown, props: { gatewayAdmin: boolean; projectAdmin: boolean }) {
  vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return {}
    if (path === '/providers') return PROVIDERS
    if (path === '/providers/claude/models') return MODELS
    if (path === '/projects/alfa/model-groups') return { groups: [] }
    if (path === '/model-groups') return { groups: [{ id: 'global', name: 'Global' }] }
    return view
  })
  const host = document.createElement('div')
  document.body.append(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp({ render: () => h(ProjectModels, { projectId: 'alfa', ...props }) })
  app.use(pinia)
  app.mount(host)
  return host
}

beforeEach(() => vi.mocked(api).mockReset())
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('ProjectModels', () => {
  it('o admin do gateway troca "todos" por uma lista dos modelos ligados e salva', async () => {
    const host = mount({ allowed: null, byRole: {}, byUser: {}, effective: null }, { gatewayAdmin: true, projectAdmin: false })
    await flush()
    const gateway = host.querySelector('[data-test="project-models-gateway"]')!
    const all = gateway.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(all.checked).toBe(true)
    all.click()
    await nextTick()
    const boxes = [...gateway.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].slice(1)
    expect(boxes.length).toBe(2)
    boxes[0].click()
    await nextTick()
    host.querySelector<HTMLButtonElement>('[data-test="project-models-save"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/models', { method: 'PUT', body: { allowed: ['claude/haiku'] } })
  })

  it('o admin do projeto só vê a parte dos papéis, com os modelos que o projeto recebeu, e salva mantendo as listas das pessoas', async () => {
    const host = mount({ allowed: ['claude/opus'], byRole: {}, byUser: { u_bia: ['claude/opus'] }, effective: ['claude/opus'] }, { gatewayAdmin: false, projectAdmin: true })
    await flush()
    expect(host.querySelector('[data-test="project-models-gateway"]')).toBeNull()
    const roles = host.querySelector('[data-test="project-models-roles"]')!
    roles.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await nextTick()
    expect(roles.textContent).toContain('claude/opus')
    expect(roles.textContent).not.toContain('claude/haiku')
    host.querySelector<HTMLButtonElement>('[data-test="project-models-roles-save"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/member-models', { method: 'PUT', body: { byRole: { member: ['claude/opus'] }, byUser: { u_bia: ['claude/opus'] } } })
  })
  it('🔁 o fallback do projeto: cria um grupo com os modelos do projeto, escolhe o padrão e salva', async () => {
    const host = mount(
      { allowed: ['claude/opus', 'claude/haiku'], byRole: {}, byUser: {}, effective: ['claude/opus', 'claude/haiku'] },
      { gatewayAdmin: false, projectAdmin: true },
    )
    await flush()
    const section = host.querySelector('[data-test="project-model-groups"]')!
    expect([...section.querySelectorAll('[data-test="project-default-group"] option')].map((option) => option.textContent?.trim())).toEqual([
      'O do gateway',
      'Não troca',
      'Global (gateway)',
    ])
    host.querySelector<HTMLButtonElement>('[data-test="project-group-add"]')!.click()
    await nextTick()
    const group = section.querySelector('[data-test="project-group"]')!
    const [name, id] = [...group.querySelectorAll<HTMLInputElement>('input')]
    name.value = 'Barato'
    name.dispatchEvent(new Event('input'))
    id.value = 'barato'
    id.dispatchEvent(new Event('input'))
    const pick = group.querySelector<HTMLSelectElement>('select')!
    pick.value = 'claude/haiku'
    pick.dispatchEvent(new Event('change'))
    await nextTick()
    ;[...group.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Acrescentar')!.click()
    await nextTick()
    const def = section.querySelector<HTMLSelectElement>('[data-test="project-default-group"]')!
    def.value = 'barato'
    def.dispatchEvent(new Event('change'))
    host.querySelector<HTMLButtonElement>('[data-test="project-groups-save"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/model-groups', {
      method: 'PUT',
      body: { groups: [{ id: 'barato', name: 'Barato', steps: [{ provider: 'claude', model: 'haiku' }] }], defaultModelGroup: 'barato' },
    })
  })
})
