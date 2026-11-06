import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IProjectDoc, IResource } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import DocsView from './DocsView.vue'
import ResourcesView from './ResourcesView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const PROJECTS = [
  { id: 'alfa', name: 'Alfa', role: 'admin' },
  { id: 'beta', name: 'Beta', role: 'admin' },
  { id: 'gama', name: 'Gama', role: 'member' },
  { id: 'delta', name: 'Delta', role: 'admin' },
].map((project) => ({ ...project, createdAt: '', updatedAt: '' }))

const skill = (overrides: Partial<IResource> = {}): IResource => ({ id: 'deploy', kind: 'skill', projectId: 'alfa', description: 'Deploy', body: 'b', docIds: [], createdAt: '', updatedAt: '', ...overrides })
const doc = (overrides: Partial<IProjectDoc> = {}): IProjectDoc => ({ id: 'spec-api', kind: 'spec', projectId: 'alfa', title: 'API', summary: 's', body: 'b', createdAt: '', updatedAt: '', ...overrides })

/** `current`: o projeto escolhido no topo; `data`: o que o servidor responde por caminho (a lista, o item). */
async function mount(component: Component, props: Record<string, unknown>, current: string, data: Record<string, unknown>) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = false
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }) => {
    if (path === '/projects') return PROJECTS
    if (init?.method === 'PUT' && path.endsWith('/shares')) return { ...(data[path.replace('/shares', '')] as object), sharedWith: (init.body as { projects: string[] }).projects }
    const key = init?.query?.project ? `${path}?project=${init.query.project}` : path
    return data[key] ?? data[path] ?? []
  }) as never)
  const projects = useProjectsStore()
  projects.current = current
  await projects.load()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component }] })
  await router.push('/')
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, props) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const q = (host: HTMLElement, test: string) => host.querySelector<HTMLElement>(`[data-test="${test}"]`)
const boxes = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('[data-test="share-projects"] input[type="checkbox"]')]

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('aba Compartilhar', () => {
  it('skill: lista só os projetos que a pessoa administra (menos o do item), marcados pelo sharedWith, e manda a lista inteira', async () => {
    const host = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'alfa', { '/resources/deploy': skill({ sharedWith: ['beta'] }) })
    await click(q(host, 'tab-share'))
    expect(boxes(host).map((box) => [box.dataset.project, box.checked])).toEqual([
      ['beta', true],
      ['delta', false],
    ])
    expect(host.textContent).toContain('O outro projeto usa só para leitura; a manutenção continua aqui. Segredos não vão junto: cada projeto configura os seus.')
    await click(boxes(host)[1])
    await click(host.querySelector('[data-test="save-footer"] button'))
    expect(api).toHaveBeenCalledWith('/resources/deploy/shares', { method: 'PUT', body: { projects: ['beta', 'delta'] } })
  })

  it('command também tem a aba; item global não tem', async () => {
    const command = await mount(ResourcesView, { kind: 'command', id: 'resumir' }, 'alfa', { '/resources/resumir': skill({ id: 'resumir', kind: 'command' }) })
    expect(q(command, 'tab-share')).toBeTruthy()
    app?.unmount()
    document.body.innerHTML = ''
    const global = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'alfa', { '/resources/deploy': skill({ projectId: undefined }) })
    expect(q(global, 'tab-share')).toBeNull()
  })

  it('spec e conhecimento têm a aba (manda a lista inteira para /docs/:id/shares); ADR não', async () => {
    const host = await mount(DocsView, { kind: 'spec', id: 'spec-api' }, 'alfa', { '/docs/spec-api': doc() })
    await click(q(host, 'tab-share'))
    await click(boxes(host)[0])
    await click(host.querySelector('[data-test="save-footer"] button'))
    expect(api).toHaveBeenCalledWith('/docs/spec-api/shares', { method: 'PUT', body: { projects: ['beta'] } })
    app?.unmount()
    document.body.innerHTML = ''
    const knowledge = await mount(DocsView, { kind: 'knowledge', id: 'estudo' }, 'alfa', { '/docs/estudo': doc({ id: 'estudo', kind: 'knowledge' }) })
    expect(q(knowledge, 'tab-share')).toBeTruthy()
    app?.unmount()
    document.body.innerHTML = ''
    const adr = await mount(DocsView, { kind: 'adr', id: 'adr-1' }, 'alfa', { '/docs/adr-1': doc({ id: 'adr-1', kind: 'adr' }) })
    expect(q(adr, 'tab-share')).toBeNull()
  })
})

describe('item compartilhado: só leitura', () => {
  it('skill com sharedFrom abre só leitura, com o aviso, sem Salvar, Apagar nem Compartilhar', async () => {
    const host = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'beta', { '/resources/deploy': skill({ sharedWith: ['beta'] }) })
    expect(q(host, 'shared-readonly')?.textContent).toContain('Compartilhado por Alfa: só leitura aqui; a manutenção é lá')
    expect(q(host, 'save-footer')).toBeNull()
    expect(host.textContent).not.toContain('Apagar skill')
    expect(q(host, 'tab-share')).toBeNull()
    expect(host.querySelector('fieldset')?.disabled).toBe(true)
  })

  it('spec compartilhada: só leitura com o aviso', async () => {
    const host = await mount(DocsView, { kind: 'spec', id: 'spec-api' }, 'beta', { '/docs/spec-api': doc({ sharedWith: ['beta'] }) })
    expect(q(host, 'shared-readonly')?.textContent).toContain('Compartilhado por Alfa')
    expect(q(host, 'save-footer')).toBeNull()
    expect(q(host, 'tab-share')).toBeNull()
  })

  it('quem não é membro do projeto de origem vê o id dele', async () => {
    const host = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'beta', { '/resources/deploy': skill({ projectId: 'oculto', sharedWith: ['beta'] }) })
    expect(q(host, 'shared-readonly')?.textContent).toContain('Compartilhado por oculto')
  })

  it('o selo aparece na lista de skills e de specs', async () => {
    const skills = await mount(ResourcesView, { kind: 'skill' }, 'beta', { '/resources?project=beta': [skill({ sharedFrom: 'alfa' }), skill({ id: 'propria', projectId: 'beta' })] })
    const badges = [...skills.querySelectorAll('[data-test="shared-badge"]')]
    expect(badges.map((badge) => badge.textContent?.trim())).toEqual(['compartilhado por Alfa'])
    app?.unmount()
    document.body.innerHTML = ''
    const specs = await mount(DocsView, { kind: 'spec' }, 'beta', { '/docs?project=beta': [doc({ sharedFrom: 'alfa' })] })
    expect(q(specs, 'shared-badge')?.textContent?.trim()).toBe('compartilhado por Alfa')
  })
})

describe('aba Variáveis', () => {
  it('na skill compartilhada, lê e grava com ?project= do projeto atual', async () => {
    const host = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'beta', { '/resources/deploy': skill({ sharedWith: ['beta'] }), '/resources/deploy/secrets?project=beta': [] })
    await click(q(host, 'tab-variables'))
    expect(host.textContent).toContain('Valores deste projeto (não vêm do projeto de origem)')
    expect(api).toHaveBeenCalledWith('/resources/deploy/secrets?project=beta')
    const type = (test: string, value: string) => {
      const input = q(host, test) as HTMLInputElement
      input.value = value
      input.dispatchEvent(new Event('input'))
    }
    type('secret-add-name', 'API_TOKEN')
    type('secret-add-value', 'segredo')
    await flush()
    await click(q(host, 'secret-add-submit'))
    expect(api).toHaveBeenCalledWith('/resources/deploy/secrets/API_TOKEN?project=beta', { method: 'PUT', body: { value: 'segredo' } })
  })

  it('no item do próprio projeto também manda ?project=', async () => {
    const host = await mount(ResourcesView, { kind: 'skill', id: 'deploy' }, 'alfa', { '/resources/deploy': skill() })
    await click(q(host, 'tab-variables'))
    expect(api).toHaveBeenCalledWith('/resources/deploy/secrets?project=alfa')
  })
})
