import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { NO_MODEL_GROUP } from '@/lib/modelGroups'
import { useAuthStore } from '@/stores/auth'
import { useSettingsStore } from '@/stores/settings'
import AgentModelGroup from './AgentModelGroup.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const PADRAO = { id: 'padrao', name: 'Padrão', steps: [{ provider: 'claude', model: 'sonnet' }], switchOn: ['quota'] }
const RAPIDO = { id: 'rapido', name: 'Rápido', steps: [{ provider: 'claude', model: 'haiku' }] }

async function mount(initial: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
  const puts: unknown[] = []
  vi.mocked(api).mockImplementation(async (url: string, init?: { method?: string; body?: unknown }) => {
    if (url === '/settings' && init?.method === 'PUT') {
      puts.push(init.body)
      return {}
    }
    if (url === '/settings') return { audience: 'all', modelGroups: [PADRAO, RAPIDO], defaultModelGroup: 'padrao' }
    if (url === '/agents') return [{ id: 'a1', name: 'Um', providers: [], modes: ['chat'], allowedTools: [], modelGroup: 'rapido' }]
    if (url === '/providers') return [{ id: 'claude', name: 'Claude', enabled: true, subscription: false, credential: { configured: true } }]
    if (url === '/providers/claude/models')
      return [
        { modelId: 'sonnet', enabled: true },
        { modelId: 'haiku', enabled: true },
      ]
    return []
  })
  await useSettingsStore().ensure()
  const choice = ref(initial)
  const part = ref<{ dirty: boolean; commit: () => Promise<void> }>()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => h('div') } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AgentModelGroup, { ref: part, modelValue: choice.value, 'onUpdate:modelValue': (value: string) => (choice.value = value) }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, puts, choice, part }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('AgentModelGroup', () => {
  it('"Padrão" mostra os modelos do grupo padrão; o escolhido, os dele', async () => {
    const standard = await mount('')
    expect(standard.host.querySelector('[data-test=group-models]')?.textContent).toContain('Modelos da sequência Padrão')
    app?.unmount()
    const chosen = await mount('rapido')
    expect(chosen.host.querySelector('[data-test=group-models]')?.textContent).toContain('Modelos da sequência Rápido')
    expect(chosen.host.textContent).toContain('usado por 1 agente')
  })

  it('o "Salvar agente" grava a sequência (commit): só ela, com as outras como estão; sem mudança, nada', async () => {
    const { host, puts, part } = await mount('rapido')
    expect(part.value?.dirty).toBe(false)
    await part.value?.commit()
    expect(puts).toEqual([])
    const cooldown = host.querySelector<HTMLInputElement>('input[aria-label="Tempo de espera"]')!
    cooldown.value = '30'
    cooldown.dispatchEvent(new Event('input'))
    await flush()
    expect(part.value?.dirty).toBe(true)
    expect(host.textContent).toContain('Mudança não salva')
    await part.value?.commit()
    await flush()
    expect(puts).toEqual([{ modelGroups: [PADRAO, { ...RAPIDO, switchOn: expect.any(Array), cooldownMinutes: 30 }] }])
  })

  it('"Nenhum": sem bloco de modelos, com o aviso', async () => {
    const { host } = await mount(NO_MODEL_GROUP)
    expect(host.querySelector('[data-test=group-models]')).toBeNull()
    expect(host.textContent).toContain('Sem troca automática, o agente fica no modelo escolhido')
  })
})
