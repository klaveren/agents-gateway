import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { useSettingsStore } from '@/stores/settings'
import GatewayReachSetting from './GatewayReachSetting.vue'
import PermissionRules from './PermissionRules.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = () => new Promise((resolve) => setTimeout(resolve))

describe('🔌 agentes alcançam a API do gateway na tela', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockResolvedValue([])
    document.body.innerHTML = ''
  })

  it('Configurações: desligado por padrão; permitir pede confirmação e grava; desligar grava direto', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const settings = useSettingsStore()
    settings.seed({ audience: 'all', deployment: { allowAnonymous: false } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(GatewayReachSetting).use(pinia).mount(host)
    await nextTick()
    expect(host.querySelector('[data-test="gateway-reach-state"]')?.textContent?.trim()).toBe('Desligado')
    ;(host.querySelector('[data-test="gateway-reach-on"]') as HTMLElement).click()
    await nextTick()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/settings', expect.anything())
    vi.mocked(api).mockImplementation(async (path) => (path === '/settings' ? { audience: 'all', agentsReachGatewayApi: true, deployment: { allowAnonymous: false } } : []))
    ;[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Permitir' && !button.dataset.test)!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/settings', { method: 'PUT', body: { agentsReachGatewayApi: true } })
    expect(host.querySelector('[data-test="gateway-reach-state"]')?.textContent?.trim()).toBe('Permitido')
    vi.mocked(api).mockImplementation(async (path) => (path === '/settings' ? { audience: 'all', agentsReachGatewayApi: false, deployment: { allowAnonymous: false } } : []))
    vi.mocked(api).mockClear()
    ;(host.querySelector('[data-test="gateway-reach-off"]') as HTMLElement).click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/settings', { method: 'PUT', body: { agentsReachGatewayApi: false } })
  })

  it('Regras: a regra de rede avisada como "sem efeito" mostra o motivo; as outras, não', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(PermissionRules, {
      modelValue: [
        { category: 'network', pattern: 'localhost:3210', decision: 'allow' },
        { category: 'network', pattern: 'localhost:27017', decision: 'allow' },
      ],
      only: 'network',
      ineffective: [{ category: 'network', pattern: 'localhost:3210', message: 'porta do próprio gateway: desligado' }],
    })
      .use(pinia)
      .mount(host)
    await nextTick()
    const marks = [...host.querySelectorAll('[data-test="rule-no-effect"]')]
    expect(marks).toHaveLength(1)
    expect(marks[0].textContent).toContain('sem efeito')
    expect(marks[0].textContent).toContain('porta do próprio gateway')
  })
})
