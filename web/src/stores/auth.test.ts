import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/lib/api'
import { useAuthStore } from './auth'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

describe('useAuthStore — quem está logado', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    localStorage.clear()
  })

  it('status, conta e papel saem JUNTOS (o gateway está longe): as três antes de qualquer resposta', async () => {
    const pending: Array<{ path: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
    vi.mocked(api).mockImplementation((path: string) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })) as never)
    const auth = useAuthStore()
    const probing = auth.probe()
    await vi.waitFor(() => expect(pending.map((one) => one.path).sort()).toEqual(['/auth/me', '/auth/status', '/settings']))
    for (const one of pending) {
      if (one.path === '/auth/status') one.resolve({ localAccounts: true, setupRequired: false })
      if (one.path === '/auth/me') one.resolve({ id: 'u1', email: 'a@b', name: 'A', role: 'member' })
      if (one.path === '/settings') one.reject(new ApiError(403, 'forbidden', 'no'))
    }
    await probing
    expect([auth.checked, auth.localAccounts, auth.user?.id, auth.isAdmin, auth.unauthorized]).toEqual([true, true, 'u1', false, false])
  })
})
