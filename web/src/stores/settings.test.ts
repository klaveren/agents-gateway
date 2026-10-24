import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useSettingsStore } from './settings'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

describe('useSettingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('carga que chega depois do reset não ressuscita as configurações', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(api).mockReturnValueOnce(new Promise((done) => (resolve = done)))
    const settings = useSettingsStore()

    const load = settings.load()
    settings.reset()
    resolve({ audience: 'all' })
    await load

    expect(settings.current).toBeUndefined()
  })
})
