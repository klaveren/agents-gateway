import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import RepositoriesView from './RepositoriesView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

type TCall = { path: string; init?: { method?: string; body?: unknown } }
type TReply = (path: string, init?: { method?: string; body?: unknown }) => unknown

const listed = [
  {
    name: 'api',
    branch: 'automation',
    origin: 'https://github.com/empresa/api.git',
    worktrees: [{ name: 'api-fix', branch: 'henrique/fix', path: 'repositories/_worktrees/api-fix' }],
  },
  { name: 'notas', branch: 'develop', worktrees: [] },
]

async function mount(options: { admin?: boolean; role?: string; hash?: string; reply?: TReply } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = options.admin ?? false
  const calls: TCall[] = []
  vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init })
    const custom = options.reply?.(path, init)
    if (custom !== undefined) return custom
    if (path === '/projects') return [{ id: 'p1', name: 'Projeto 1', role: options.role ?? 'admin' }]
    if (path === '/projects/p1/repositories' && !init?.method) return listed
    if (path === '/projects/p1/accounts')
      return {
        accounts: [
          { id: 'github-empresa', kind: 'github-token', label: 'GitHub da empresa', public: {}, exposesSecret: false, updatedAt: '' },
          { id: 'ssh-prod', kind: 'ssh-key', label: 'SSH', public: {}, exposesSecret: false, updatedAt: '' },
        ],
      }
    if (path === '/settings' && !init?.method) return { audience: 'all', baseBranch: 'automation', protectedBranches: ['automation', 'main'], branchPrefix: 'henrique/' }
    return {}
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/repositories', component: RepositoriesView }] })
  await router.push(`/repositories${options.hash ?? ''}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(RepositoriesView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, calls }
}

function fill(element: Element | null, value: string) {
  expect(element, 'o campo existe').toBeTruthy()
  const input = element as HTMLInputElement | HTMLSelectElement
  input.value = value
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'))
}
const test = (host: ParentNode, name: string) => host.querySelector<HTMLElement>(`[data-test="${name}"]`)
/** O botão do diálogo de confirmação (ele mora no `body`, fora da tela). */
const confirm = (text: string) => [...document.querySelectorAll('[role="alertdialog"] button')].find((item) => item.textContent?.trim() === text) as HTMLButtonElement | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('RepositoriesView — os repositórios do projeto', () => {
  it('lista a branch, a origem e as worktrees; o git sem remoto aparece como local', async () => {
    const { host } = await mount()
    const api = test(host, 'repository-api')!
    expect(api.textContent).toContain('automation')
    expect(api.textContent).toContain('https://github.com/empresa/api.git')
    expect(api.textContent).toContain('1 worktree: api-fix')
    const notas = test(host, 'repository-notas')!
    expect(notas.textContent).toContain('local')
    expect(notas.textContent).toContain('sem worktrees')
    // Só o admin do projeto: sem a guia das regras, que é do admin do gateway.
    expect(test(host, 'tab-rules')).toBeNull()
  })

  it('cria o git local só com o nome; o 422 marca o campo', async () => {
    let refuse = true
    const { host, calls } = await mount({
      reply: (path, init) => {
        if (path !== '/projects/p1/repositories' || init?.method !== 'POST') return undefined
        if (refuse) throw new ApiError(422, 'validation_error', 'Validation failed', [{ field: 'name', message: 'já existe um repositório com esse nome' }])
        return { name: 'rascunho', branch: 'automation', worktrees: [] }
      },
    })
    test(host, 'new-repository')!.click()
    await flush()
    test(host, 'mode-local')!.click()
    test(host, 'mode-local')!.dispatchEvent(new Event('change'))
    await flush()
    expect(test(host, 'repository-url')).toBeNull()
    fill(test(host, 'repository-name'), ' rascunho ')
    test(host, 'repository-form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(test(host, 'repository-form')!.textContent).toContain('já existe um repositório com esse nome')

    refuse = false
    test(host, 'repository-form')!.dispatchEvent(new Event('submit'))
    await flush()
    const posts = calls.filter((call) => call.init?.method === 'POST')
    expect(posts.at(-1)?.init?.body).toEqual({ name: 'rascunho' })
    expect(test(host, 'repository-notice')!.textContent).toContain('Git local rascunho criado, na branch automation')
    expect(test(host, 'repository-rascunho')).toBeTruthy()
    expect(test(host, 'repository-form')).toBeNull()
  })

  it('clona com a URL e a conta de git do projeto (a de SSH não entra na lista)', async () => {
    const { host, calls } = await mount({
      reply: (path, init) =>
        path === '/projects/p1/repositories' && init?.method === 'POST'
          ? { name: 'site', branch: 'main', origin: 'https://github.com/empresa/site.git', worktrees: [] }
          : undefined,
    })
    test(host, 'new-repository')!.click()
    await flush()
    const accounts = [...test(host, 'repository-account')!.querySelectorAll('option')].map((option) => option.value)
    expect(accounts).toEqual(['', 'github-empresa'])
    fill(test(host, 'repository-url'), ' https://github.com/empresa/site.git ')
    fill(test(host, 'repository-account'), 'github-empresa')
    test(host, 'repository-form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(calls.find((call) => call.init?.method === 'POST')?.init?.body).toEqual({ url: 'https://github.com/empresa/site.git', account: 'github-empresa' })
    expect(test(host, 'repository-notice')!.textContent).toContain('Repositório site clonado.')
  })

  it('remove só depois de confirmar na tela, e avisa das worktrees que ficaram no disco', async () => {
    const { host, calls } = await mount({
      reply: (path, init) => (init?.method === 'DELETE' ? { kept: ['outra-pasta/api-fix'] } : undefined),
    })
    test(host, 'remove-api')!.click()
    await flush()
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
    expect(document.body.textContent).toContain('Remover o repositório api?')
    confirm('Remover')!.click()
    await flush()
    expect(calls.find((call) => call.init?.method === 'DELETE')?.path).toBe('/projects/p1/repositories/api')
    expect(test(host, 'repository-api')).toBeNull()
    expect(test(host, 'repository-notice')!.textContent).toContain('outra-pasta/api-fix')
  })

  it('a recusa de remover (conversa em turno) aparece na tela e o repositório fica', async () => {
    const { host } = await mount({
      reply: (path, init) => {
        if (init?.method === 'DELETE') throw new ApiError(409, 'repository_busy', 'uma conversa está em turno neste repositório')
        return undefined
      },
    })
    test(host, 'remove-notas')!.click()
    await flush()
    confirm('Remover')!.click()
    await flush()
    expect(test(host, 'repository-error')!.textContent).toContain('uma conversa está em turno')
    expect(test(host, 'repository-notas')).toBeTruthy()
  })

  it('vem de 10 em 10: remover fica na página em que se estava, e o repositório novo leva para a dele', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `a${String(index + 1).padStart(2, '0')}`, branch: 'automation', worktrees: [] }))
    const { host } = await mount({
      reply: (path, init) => {
        if (path !== '/projects/p1/repositories') return init?.method === 'DELETE' ? { kept: [] } : undefined
        return init?.method === 'POST' ? { name: 'rascunho', branch: 'automation', worktrees: [] } : many
      },
    })
    const shown = () => [...test(host, 'repository-list')!.children].map((row) => row.getAttribute('data-test'))
    expect(shown()).toHaveLength(10)
    expect(test(host, 'pager')!.textContent).toContain('1–10 de 12')

    test(host, 'new-repository')!.click()
    await flush()
    test(host, 'mode-local')!.click()
    test(host, 'mode-local')!.dispatchEvent(new Event('change'))
    await flush()
    fill(test(host, 'repository-name'), 'rascunho')
    test(host, 'repository-form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(shown()).toEqual(['repository-a11', 'repository-a12', 'repository-rascunho'])

    test(host, 'remove-a12')!.click()
    await flush()
    confirm('Remover')!.click()
    await flush()
    expect(shown()).toEqual(['repository-a11', 'repository-rascunho'])
    expect(test(host, 'pager')!.textContent).toContain('11–12 de 12')
  })

  it('quem não administra o projeto nem o gateway não vê a tela', async () => {
    const { host, calls } = await mount({ role: 'member' })
    expect(host.textContent).toContain('Só quem administra este projeto vê os repositórios.')
    expect(calls.some((call) => call.path === '/projects/p1/repositories')).toBe(false)
  })
})

describe('RepositoriesView — as regras do git da instalação', () => {
  it('o admin do gateway abre a guia pelo link (#regras) e salva só as regras do git', async () => {
    const { host, calls } = await mount({ admin: true, hash: '#regras' })
    expect(test(host, 'tab-rules')!.getAttribute('aria-selected')).toBe('true')
    const base = test(host, 'git-base-branch') as HTMLInputElement
    expect(base.value).toBe('automation')
    fill(base, 'develop')
    test(host, 'installation-git')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(calls.find((call) => call.init?.method === 'PUT')).toMatchObject({
      path: '/settings',
      init: { body: { installationName: null, branchPrefix: 'henrique/', baseBranch: 'develop', protectedBranches: ['automation', 'main'], lockMainCheckout: true } },
    })
    expect(Object.keys(calls.find((call) => call.init?.method === 'PUT')!.init!.body as object).sort()).toEqual([
      'baseBranch',
      'branchPrefix',
      'installationName',
      'lockMainCheckout',
      'protectedBranches',
    ])
    expect(test(host, 'git-saved')!.textContent).toContain('Regras do git salvas')
  })

  it('o admin do gateway sem papel no projeto vê só as regras', async () => {
    const { host, calls } = await mount({ admin: true, role: 'member' })
    expect(test(host, 'installation-git')).toBeTruthy()
    expect(test(host, 'tab-repositories')).toBeNull()
    expect(calls.some((call) => call.path === '/projects/p1/repositories')).toBe(false)
  })
})
