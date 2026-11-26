import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import AgentGroupAlert from './AgentGroupAlert.vue'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const flush = async () => {
  for (let index = 0; index < 4; index++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

let app: ReturnType<typeof createApp> | undefined
afterEach(() => app?.unmount())

function mount(group: string) {
  const host = document.createElement('div')
  app = createApp(AgentGroupAlert, { projectId: 'logiccus', group })
  app.mount(host)
  return host
}

/** ⚠️ O alerta do agente cujo grupo não está configurado nesta máquina. */
describe('AgentGroupAlert', () => {
  it('mostra quando o grupo do agente falta aqui; some quando existe ou quando não dá para ler', async () => {
    vi.mocked(api).mockResolvedValue({ missing: [{ id: 'executor-low', agents: ['maya'] }] })
    const missing = mount('executor-low')
    await flush()
    expect(missing.querySelector('[data-test="agent-group-missing"]')?.textContent).toContain('executor-low')
    expect(api).toHaveBeenCalledWith('/projects/logiccus/model-groups')
    app?.unmount()

    const present = mount('planner-high')
    await flush()
    expect(present.querySelector('[data-test="agent-group-missing"]')).toBeNull()
    app?.unmount()

    vi.mocked(api).mockRejectedValue(new Error('not found'))
    const hidden = mount('executor-low')
    await flush()
    expect(hidden.querySelector('[data-test="agent-group-missing"]')).toBeNull()
  })
})
