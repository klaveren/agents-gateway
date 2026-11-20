import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import ProfileView from './ProfileView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), apiBlob: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(voice: unknown) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { name: 'Ana', email: 'ana@x.test', role: 'member' } as never
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/me/voice') return voice
    return []
  }) as never)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ProfileView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('ProfileView — Voz', () => {
  it('mostra a seção com as preferências e o botão Testar', async () => {
    const host = await mount({ enabled: true, voice: 'Cherry', rate: 1.2, minLevel: 'attention', engine: { available: true, defaultVoice: 'Ethan' } })
    expect(host.querySelector('[data-test="voice-section"]')).toBeTruthy()
    expect(host.textContent).toContain('Ler minhas mensagens em voz alta')
    expect((host.querySelector('[data-test="voice-enabled"]') as HTMLInputElement).checked).toBe(true)
    expect((host.querySelector('[data-test="voice-level"]') as HTMLSelectElement).value).toBe('attention')
    expect((host.querySelector('[data-test="voice-name"]') as HTMLInputElement).value).toBe('Cherry')
    expect((host.querySelector('[data-test="voice-rate"]') as HTMLInputElement).value).toBe('1.2')
    expect((host.querySelector('[data-test="voice-test"]') as HTMLButtonElement).disabled).toBe(false)
    expect(host.querySelector('[data-test="voice-unavailable"]')).toBeNull()
  })

  it('sem motor: nota do administrador e o liga/desliga travado', async () => {
    const host = await mount({ enabled: false, rate: 1, minLevel: 'info', engine: { available: false } })
    expect(host.querySelector('[data-test="voice-unavailable"]')?.textContent).toContain('A voz ainda não foi configurada pelo administrador (Ajustes → Voz).')
    expect((host.querySelector('[data-test="voice-enabled"]') as HTMLInputElement).disabled).toBe(true)
  })
})
