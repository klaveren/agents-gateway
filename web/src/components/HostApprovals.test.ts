import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import HostApprovals from './HostApprovals.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = () => new Promise((resolve) => setTimeout(resolve))

describe('🖥️ o cartão de aprovação do agente de máquina', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    document.body.innerHTML = ''
  })

  it('mostra o comando exato; o sudo pede a senha, que vai na resposta e some da tela', async () => {
    vi.mocked(api).mockImplementation(async (path, init) =>
      init?.method === 'POST'
        ? { approved: true }
        : [{ id: 'ha_1', agentId: 'zeus', command: 'sudo brew services restart redis', reason: 'privilege escalation', password: true, expiresAt: '' }],
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(HostApprovals, { sessionId: 'gw_1', running: false }).mount(host)
    await flush()
    await nextTick()
    expect(host.querySelector('pre')?.textContent).toBe('sudo brew services restart redis')
    const input = host.querySelector<HTMLInputElement>('[data-test="host-approval-password"]')!
    input.value = 'segredo'
    input.dispatchEvent(new Event('input'))
    host.querySelector<HTMLFormElement>('[data-test="host-approval"]')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/sessions/gw_1/host-approvals/ha_1', { method: 'POST', body: { approve: true, password: 'segredo' } })
    await nextTick()
    expect(host.querySelector('[data-test="host-approvals"]')).toBeNull()
  })

  it('recusar não manda senha', async () => {
    vi.mocked(api).mockImplementation(async (_path, init) =>
      init?.method === 'POST' ? { approved: false } : [{ id: 'ha_2', command: 'rm -rf ./build', reason: 'recursive force delete', password: false, expiresAt: '' }],
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp(HostApprovals, { sessionId: 'gw_1', running: false }).mount(host)
    await flush()
    await nextTick()
    expect(host.querySelector('[data-test="host-approval-password"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('[data-test="host-approval-reject"]')!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/sessions/gw_1/host-approvals/ha_2', { method: 'POST', body: { approve: false } })
  })
})
