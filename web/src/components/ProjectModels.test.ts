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

const PROVIDERS = [
  { id: 'claude', name: 'Claude', protocol: 'claude', official: true, enabled: true, credential: { configured: true, source: 'stored' } },
  {
    id: 'alfa--openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    projectId: 'alfa',
    official: false,
    enabled: true,
    credential: { configured: false, source: 'none' },
  },
]
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
    if (path === '/providers/alfa--openai/models') return [{ modelId: 'gpt-x', enabled: true, available: true }]
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
    expect(api).toHaveBeenCalledWith('/projects/alfa/member-models', {
      method: 'PUT',
      body: { byRole: { member: ['claude/opus', 'alfa--openai/gpt-x'] }, byUser: { u_bia: ['claude/opus'] } },
    })
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
  it('🔐 providers do projeto: o do projeto aparece com a chave e os modelos, fora da lista do gateway e dentro da base dos papéis', async () => {
    const host = mount({ allowed: ['claude/opus'], byRole: {}, byUser: {}, effective: ['claude/opus'] }, { gatewayAdmin: true, projectAdmin: true })
    await flush()
    expect(host.querySelector('[data-test="project-models-gateway"]')?.textContent).not.toContain('gpt-x')
    const own = host.querySelector('[data-test="project-provider"]')!
    expect(own.textContent).toContain('Sem chave')
    expect(own.textContent).toContain('https://api.openai.com/v1')
    const roles = host.querySelector('[data-test="project-models-roles"]')!
    roles.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await nextTick()
    expect(roles.textContent).toContain('alfa--openai/gpt-x')
    // Só os tipos que o projeto ainda não tem.
    expect([...host.querySelectorAll('[data-test="project-provider-add"] option')].map((option) => option.textContent?.trim())).toEqual([
      'Acrescentar provider…',
      'Anthropic',
      'Google',
      'OpenRouter',
    ])
  })
  it('💰 o teto do mês: mostra o gravado e salva (vazio = sem teto)', async () => {
    const host = mount({ allowed: null, byRole: {}, byUser: {}, caps: { monthlyCostUsd: 50 }, effective: null }, { gatewayAdmin: false, projectAdmin: true })
    await flush()
    const section = host.querySelector('[data-test="project-caps"]')!
    const [cost, tokens] = [...section.querySelectorAll<HTMLInputElement>('input')]
    expect([cost.value, tokens.value]).toEqual(['50', ''])
    tokens.value = '2000000'
    tokens.dispatchEvent(new Event('input'))
    cost.value = ''
    cost.dispatchEvent(new Event('input'))
    host.querySelector<HTMLButtonElement>('[data-test="project-caps-save"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/alfa/caps', { method: 'PUT', body: { monthlyCostUsd: null, monthlyTokens: 2000000 } })
  })
})
