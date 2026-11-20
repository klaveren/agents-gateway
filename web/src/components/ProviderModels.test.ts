import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import type { IProviderStatus } from '@/lib/types'
import ProviderModels from './ProviderModels.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), apiBlob: vi.fn() }))

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('ProviderModels — selo "gera voz"', () => {
  it('🔊 aparece só no modelo que gera voz (e o de imagem segue com o dele)', async () => {
    setActivePinia(createPinia())
    const model = (modelId: string, extra: object = {}) => ({ modelId, enabled: true, available: true, updatedAt: '', ...extra })
    vi.mocked(api).mockImplementation((async () => [
      model('qwen-audio-3.0-tts-plus', { speech: { output: true, source: 'heuristic' } }),
      model('qwen-plus', { speech: { output: false, source: 'heuristic' } }),
      model('gpt-image-2'),
    ]) as never)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const provider = { id: 'qwen', name: 'Qwen', protocol: 'openai', official: false, enabled: true, credential: { configured: true, source: 'stored' } } as unknown as IProviderStatus
    app = createApp({ render: () => h(ProviderModels, { provider }) })
    app.use(createPinia()).mount(host)
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve)).then(nextTick)
    expect(host.querySelectorAll('[data-test="model-speech"]').length).toBe(1)
    expect(host.querySelector('[data-test="model-speech"]')?.textContent).toContain('gera voz')
    expect(host.querySelectorAll('[data-test="model-image"]').length).toBe(1)
  })
})
