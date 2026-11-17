import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import ProjectServices from './ProjectServices.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = () => new Promise((resolve) => setTimeout(resolve))

describe('a guia Serviços do projeto', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    document.body.innerHTML = ''
  })

  it('mostra os serviços gravados e salva relendo as regras: o que outra pessoa gravou no meio fica', async () => {
    const first = { rules: [{ category: 'network', pattern: '10.10.0.3:6379', decision: 'allow', note: 'Redis' }], system: [] }
    const fresh = { rules: [...first.rules, { category: 'terminal', pattern: 'npm *', decision: 'allow' }], system: [] }
    vi.mocked(api)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(fresh)
      .mockImplementationOnce(async (_path, init) => ({ rules: (init as { body: { rules: unknown[] } }).body.rules }))
    setActivePinia(createPinia())
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(ProjectServices, { projectId: 'logiccus' }).use(createPinia()).mount(host)
    await flush()
    await nextTick()

    const rows = host.querySelectorAll('[data-test="service-row"]')
    expect(rows).toHaveLength(1)
    expect((rows[0]!.querySelectorAll('input')[1] as HTMLInputElement).value).toBe('10.10.0.3')

    ;(host.querySelector('[data-test="service-add"]') as HTMLElement).click()
    await nextTick()
    const inputs = host.querySelectorAll('[data-test="service-row"]')[1]!.querySelectorAll('input')
    for (const [index, value] of ['Kafka', '10.10.0.3', '9092'].entries()) {
      ;(inputs[index] as HTMLInputElement).value = value
      inputs[index]!.dispatchEvent(new Event('input'))
    }
    await nextTick()
    ;(host.querySelector('[data-test="service-save"]') as HTMLButtonElement).click()
    await flush()

    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/permissions', {
      method: 'PUT',
      body: {
        rules: [
          { category: 'terminal', pattern: 'npm *', decision: 'allow' },
          { category: 'network', pattern: '10.10.0.3:6379', decision: 'allow', note: 'Redis' },
          { category: 'network', pattern: '10.10.0.3:9092', decision: 'allow', note: 'Kafka' },
        ],
      },
    })
    expect(host.textContent).toContain('Serviços salvos')
  })
})
