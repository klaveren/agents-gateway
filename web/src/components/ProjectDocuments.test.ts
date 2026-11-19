import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import ProjectDocuments from './ProjectDocuments.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

let app: App | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('ProjectDocuments', () => {
  it('📄 mostra o modelo gravado, a prévia acompanha, e salvar manda os três campos', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const pinia = createPinia()
    setActivePinia(pinia)
    useProjectsStore().list = [{ id: 'alfa', name: 'Alfa', documentTemplate: { organization: 'Infoccus', footer: 'CNPJ 1' } }] as never
    vi.mocked(api).mockResolvedValue({ id: 'alfa', name: 'Alfa', documentTemplate: { organization: 'Infoccus', footer: 'CNPJ 2', color: '#7c3aed' } })
    app = createApp({ render: () => h(ProjectDocuments, { projectId: 'alfa' }) })
    app.use(pinia)
    app.mount(host)
    await nextTick()
    const preview = host.querySelector('[data-test="project-documents-preview"]')!
    expect(preview.textContent).toContain('Infoccus')
    expect(preview.textContent).toContain('CNPJ 1')
    const [, footer] = [...host.querySelectorAll<HTMLInputElement>('input:not([type="color"])')]
    footer.value = 'CNPJ 2'
    footer.dispatchEvent(new Event('input'))
    await nextTick()
    expect(preview.textContent).toContain('CNPJ 2')
    host.querySelector<HTMLButtonElement>('[data-test="project-documents-save"]')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api).toHaveBeenCalledWith('/projects/alfa/document-template', { method: 'PUT', body: { organization: 'Infoccus', footer: 'CNPJ 2', color: '' } })
  })
})
