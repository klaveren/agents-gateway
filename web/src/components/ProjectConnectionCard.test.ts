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

  it('o token que caiu aparece com o motivo', async () => {
    const { host, app } = (await mount()) as unknown as { host: HTMLElement; app: ReturnType<typeof createApp> }
    useConnectionsStore().list = [connection({ updateAvailable: false, state: 'unauthorized', lastError: 'the connection token is invalid, expired or revoked' })]
    app.mount(host)
    await nextTick()
    expect(host.textContent).toContain('Token não vale mais')
    expect(host.textContent).toContain('revoked')
  })
})
