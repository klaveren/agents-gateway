import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api, ApiError } from '@/lib/api'
import type { ISecretMeta } from '@/stores/resourceSecrets'
import SecretVariables from './SecretVariables.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const meta = (name: string, overrides: Partial<ISecretMeta> = {}): ISecretMeta => ({
  scope: 'agent',
  scopeId: 'theo',
  name,
  description: `descrição de ${name}`,
  updatedAt: '2026-11-03T12:00:00Z',
  updatedBy: 'root@x.test',
  ...overrides,
})

let app: App | undefined
let stored: ISecretMeta[]

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(SecretVariables, { basePath: '/agents/theo', scopeLabel: 'deste agente' }) })
  app.use(pinia).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const type = async (element: Element | null | undefined, value: string) => {
  const input = element as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flush()
}
const q = (host: HTMLElement, test: string) => host.querySelector<HTMLElement>(`[data-test="${test}"]`)
const row = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`[data-secret="${name}"]`)!

describe('SecretVariables', () => {
  beforeEach(() => {
    stored = [meta('GITLAB_TOKEN'), meta('AWS_KEY', { description: undefined, updatedBy: undefined })]
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (path === '/agents/theo/secrets' && !init?.method) return stored
      const name = decodeURIComponent(path.split('/secrets/')[1] ?? '')
      if (init?.method === 'PUT') {
        if ((init.body as Record<string, unknown>).value === 'ruim') throw new ApiError(422, 'validation_error', 'inválido', [{ field: 'value', message: 'curto demais' }])
        return meta(name, { description: ((init.body as Record<string, unknown>).description as string | undefined) ?? 'descrição de ' + name })
      }
      if (init?.method === 'DELETE') return undefined
      throw new Error(`inesperado: ${path}`)
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('lista nome, descrição e quando/quem definiu, sem valor e sem campo preenchido', async () => {
    const host = await mount()
    expect(host.textContent).toContain('nunca é mostrado de novo')
    expect([...host.querySelectorAll('[data-test="secret-name"]')].map((el) => el.textContent)).toEqual(['GITLAB_TOKEN', 'AWS_KEY'])
    expect(row(host, 'GITLAB_TOKEN').textContent).toContain('descrição de GITLAB_TOKEN')
    expect(row(host, 'GITLAB_TOKEN').textContent).toContain('por root@x.test')
    expect(row(host, 'AWS_KEY').textContent).not.toContain(' por ')
    expect(host.querySelectorAll('input[type="password"]')).toHaveLength(1)
    expect((q(host, 'secret-add-value') as HTMLInputElement).value).toBe('')
    await click(q(row(host, 'GITLAB_TOKEN'), 'secret-change'))
    expect((q(host, 'secret-new-value') as HTMLInputElement).type).toBe('password')
    expect((q(host, 'secret-new-value') as HTMLInputElement).value).toBe('')
  })

  it('adicionar manda PUT com o valor, avisa nome fora do padrão e limpa o valor', async () => {
    const host = await mount()
    const submit = q(host, 'secret-add-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await type(q(host, 'secret-add-name'), 'gitlab')
    expect(q(host, 'secret-name-hint')).toBeTruthy()
    await type(q(host, 'secret-add-name'), 'NOVA_CHAVE')
    expect(q(host, 'secret-name-hint')).toBeNull()
    await type(q(host, 'secret-add-description'), 'minha chave')
    await type(q(host, 'secret-add-value'), 's3gredo')
    expect(submit.disabled).toBe(false)
    await click(submit)
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/secrets/NOVA_CHAVE', { method: 'PUT', body: { value: 's3gredo', description: 'minha chave' } })
    expect((q(host, 'secret-add-value') as HTMLInputElement).value).toBe('')
    expect((q(host, 'secret-add-name') as HTMLInputElement).value).toBe('')
    expect(host.textContent).toContain('NOVA_CHAVE')
    expect(host.innerHTML).not.toContain('s3gredo')
  })

  it('erro 422 mostra a mensagem e limpa o valor mesmo assim', async () => {
    const host = await mount()
    await type(q(host, 'secret-add-name'), 'X_TOKEN')
    await type(q(host, 'secret-add-value'), 'ruim')
    await click(q(host, 'secret-add-submit'))
    expect(q(host, 'secret-error')?.textContent).toContain('value: curto demais')
    expect((q(host, 'secret-add-value') as HTMLInputElement).value).toBe('')
  })

  it('trocar o valor manda só o valor e fecha o campo', async () => {
    const host = await mount()
    await click(q(row(host, 'GITLAB_TOKEN'), 'secret-change'))
    await type(q(host, 'secret-new-value'), 'novo-valor')
    await click(q(host, 'secret-save-value'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/secrets/GITLAB_TOKEN', { method: 'PUT', body: { value: 'novo-valor' } })
    expect(q(host, 'secret-new-value')).toBeNull()
    expect(host.innerHTML).not.toContain('novo-valor')
  })

  it('editar a descrição manda PUT sem valor', async () => {
    const host = await mount()
    await click(q(row(host, 'GITLAB_TOKEN'), 'secret-describe'))
    await type(q(host, 'secret-new-description'), 'outra')
    await click(q(host, 'secret-save-description'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/secrets/GITLAB_TOKEN', { method: 'PUT', body: { description: 'outra' } })
  })

  it('apagar pede confirmação e manda DELETE', async () => {
    const host = await mount()
    await click(q(row(host, 'AWS_KEY'), 'secret-remove'))
    expect(document.body.textContent).toContain('Apagar AWS_KEY?')
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/agents/theo/secrets/AWS_KEY', { method: 'DELETE' })
    await click(document.body.querySelector('[role="alertdialog"] .btn:last-child'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/agents/theo/secrets/AWS_KEY', { method: 'DELETE' })
    expect(host.querySelector('[data-secret="AWS_KEY"]')).toBeNull()
  })
})
