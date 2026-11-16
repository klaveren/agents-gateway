import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import EnvFilesToggle from './EnvFilesToggle.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

describe('EnvFilesToggle — a leitura dos .env pelo projeto', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  it('⚠️ ligar pede confirmação e manda `read: true`; ligado, fechar manda `read: false` sem perguntar', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const projects = useProjectsStore()
    projects.list = [{ id: 'logiccus', name: 'Logiccus', role: 'admin', createdAt: '', updatedAt: '' }]
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(EnvFilesToggle, { projectId: 'logiccus' }).use(pinia).mount(host)
    await nextTick()
    expect(host.querySelector('[data-test="env-files-state"]')?.textContent?.trim()).toBe('Fechados')

    ;(host.querySelector('[data-test="env-files-open"]') as HTMLElement).click()
    await nextTick()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], readEnvFiles: true } as never)
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Deixar ler')!
    confirm.click()
    await new Promise((resolve) => setTimeout(resolve))
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { read: true } })
    await nextTick()
    expect(host.querySelector('[data-test="env-files-state"]')?.textContent?.trim()).toBe('Os agentes leem')

    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], readEnvFiles: undefined } as never)
    ;(host.querySelector('[data-test="env-files-close"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve))
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { read: false } })
    document.body.innerHTML = ''
  })
})
