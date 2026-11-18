import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { type IProjectConnection, useConnectionsStore } from '@/stores/connections'
import ProjectConnectionCard from './ProjectConnectionCard.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const connection = (over: Partial<IProjectConnection> = {}): IProjectConnection => ({
  projectId: 'logiccus',
  url: 'https://gw.empresa.com',
  remoteProjectId: 'logiccus',
  syncedVersion: 42,
  latestVersion: 45,
  updateAvailable: true,
  state: 'ok',
  changes: [
    { kind: 'skill', id: 'banco', op: 'update', revisions: 3, at: '2026-11-11T10:00:00Z', by: 'maya' },
    { kind: 'command', id: 'velho', op: 'delete', revisions: 1, at: '2026-11-11T10:00:00Z', by: 'maya' },
  ],
  skipped: [],
  secrets: [],
  modelMap: {},
  autoUpdate: false,
  ...over,
})

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div')
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = createApp(ProjectConnectionCard, { projectId: 'logiccus' })
  app.use(pinia)
  return { host, app } as never
}

describe('ProjectConnectionCard', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  it('um aviso só, da versão daqui para a última, com o que mudou; Atualizar traz a última e o aviso some', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    useConnectionsStore().list = [connection()]
    app.mount(host)
    await nextTick()

    const notice = host.querySelector('[data-test="connection-update"]')!
    expect(notice.textContent).toContain('v42 → v45')
    expect(notice.textContent).toContain('Skill banco: alterado (3×)')
    expect(notice.textContent).toContain('Comando velho: removido')
    expect(host.textContent).toContain('só leitura')

    vi.mocked(api).mockResolvedValueOnce({
      result: { version: 45, applied: 1, removed: ['command/velho'], skipped: [] },
      connection: connection({ syncedVersion: 45, updateAvailable: false, changes: [] }),
    })
    ;(notice.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="connection-update"]')).toBeNull())
    expect(vi.mocked(api)).toHaveBeenCalledWith('/connections/logiccus/sync', { method: 'POST' })
    expect(host.textContent).toContain('Atualizado para a v45')
  })

  it('🔄 atualizou sozinho: "Atualizado v42 → v45" com o que mudou; Ok o dá por visto', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    const changes = connection().changes
    useConnectionsStore().list = [
      connection({ autoUpdate: true, syncedVersion: 45, updateAvailable: false, changes: [], lastUpdate: { from: 42, to: 45, changes, at: '2026-11-18T10:00:00Z', seen: false } }),
    ]
    app.mount(host)
    await nextTick()
    const updated = host.querySelector('[data-test="connection-updated"]')!
    expect(updated.textContent).toContain('Atualizado: v42 → v45')
    expect(updated.textContent).toContain('Skill banco: alterado (3×)')
    expect(host.querySelector('[data-test="connection-update"]')).toBeNull()

    vi.mocked(api).mockResolvedValueOnce(
      connection({ autoUpdate: true, syncedVersion: 45, updateAvailable: false, changes: [], lastUpdate: { from: 42, to: 45, changes, at: '2026-11-18T10:00:00Z', seen: true } }),
    )
    ;(updated.querySelector('button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="connection-updated"]')).toBeNull())
    expect(vi.mocked(api)).toHaveBeenCalledWith('/connections/logiccus/update-seen', { method: 'POST' })
  })

  it('🔄 o interruptor liga a atualização automática', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    useConnectionsStore().list = [connection()]
    app.mount(host)
    await nextTick()
    const toggle = host.querySelector('[data-test="connection-auto-update"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    vi.mocked(api).mockResolvedValueOnce(connection({ autoUpdate: true, syncedVersion: 45, updateAvailable: false }))
    toggle.click()
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/connections/logiccus/auto-update', { method: 'PUT', body: { autoUpdate: true } })
  })

  it('o token que caiu aparece com o motivo', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    useConnectionsStore().list = [connection({ updateAvailable: false, state: 'unauthorized', lastError: 'the connection token is invalid, expired or revoked' })]
    app.mount(host)
    await nextTick()
    expect(host.textContent).toContain('Token não vale mais')
    expect(host.textContent).toContain('revoked')
  })
})

describe('ProjectConnectionCard — as variáveis que o projeto pede', () => {
  beforeEach(() => vi.mocked(api).mockReset())

  const secrets = [
    { kind: 'skill', id: 'efi', name: 'EFI_CLIENT_ID', description: 'Client ID', configured: true },
    { kind: 'agent', id: 'zeus', name: 'EFI_CLIENT_ID', configured: false },
    { kind: 'skill', id: 'efi', name: 'EFI_CLIENT_SECRET', configured: false },
    { kind: 'skill', id: 'efi', name: 'EFI_CERT', configured: true },
  ]

  it('⚖️ uma linha por nome, com o status daqui; o .env colado preenche os nomes pedidos e salvar manda só os preenchidos', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    useConnectionsStore().list = [connection({ updateAvailable: false, secrets })]
    app.mount(host)
    await nextTick()

    expect(host.querySelector('[data-test="secrets-pending"]')?.textContent).toBe('2 pendente(s)')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-secret]')]
    expect(rows.map((row) => [row.dataset.secret, row.querySelector('[data-test="secret-status"]')?.textContent?.trim()])).toEqual([
      ['EFI_CLIENT_ID', 'Parcial · 1 de 2'],
      ['EFI_CLIENT_SECRET', 'Pendente'],
      ['EFI_CERT', 'Preenchida'],
    ])
    expect(rows[0]!.textContent).toContain('skill efi · agente zeus — Client ID')

    ;(host.querySelector('[data-test="secrets-paste-toggle"]') as HTMLElement).click()
    await nextTick()
    const paste = host.querySelector<HTMLTextAreaElement>('[data-test="secrets-paste"]')!
    paste.value = '# comentário\nexport EFI_CLIENT_SECRET="s3cr3t"\nOUTRA=x\n'
    paste.dispatchEvent(new Event('input'))
    await nextTick()
    ;(host.querySelector('[data-test="secrets-paste-apply"]') as HTMLElement).click()
    await nextTick()
    expect(host.querySelector('[data-test="secrets-paste-note"]')?.textContent).toContain('1 preenchida(s) a partir do .env · 1 ignorada(s), o projeto não pede: OUTRA')

    vi.mocked(api).mockResolvedValueOnce(connection({ updateAvailable: false, secrets: secrets.map((secret) => ({ ...secret, configured: true })) }) as never)
    const save = host.querySelector<HTMLButtonElement>('[data-test="secrets-save"]')!
    expect(save.textContent?.trim()).toBe('Salvar 1 variável(is)')
    save.click()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
    expect(vi.mocked(api)).toHaveBeenCalledWith('/connections/logiccus/secrets', { method: 'PUT', body: { values: { EFI_CLIENT_SECRET: 's3cr3t' } } })
    expect(host.querySelector('[data-test="secrets-pending"]')).toBeNull()
    expect(host.querySelector('[data-test="secrets-note"]')?.textContent).toBe('1 variável(is) gravada(s) nesta máquina.')
    // O campo volta vazio: o valor não fica na tela.
    expect([...host.querySelectorAll<HTMLInputElement>('[data-test="secret-input"]')].every((input) => input.value === '')).toBe(true)
  })
})
