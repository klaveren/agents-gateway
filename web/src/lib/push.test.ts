import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { disablePush, enablePush, pushState } from './push'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

function fakeBrowser(permission: NotificationPermission, existing?: object) {
  const subscription = existing as PushSubscription | null
  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => ({ toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: vi.fn() })),
  }
  const registration = { pushManager }
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(async () => 'granted') })
  vi.stubGlobal('PushManager', function PushManager() {})
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  })
  return pushManager
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
  vi.mocked(api).mockReset()
})

describe('📱 aviso no aparelho', () => {
  it('sem suporte a push, diz que não dá (fora do iPhone)', async () => {
    expect(await pushState()).toBe('unsupported')
  })

  it('bloqueado nos ajustes: denied; sem assinatura: off', async () => {
    fakeBrowser('denied')
    expect(await pushState()).toBe('denied')
    fakeBrowser('default')
    expect(await pushState()).toBe('off')
  })

  it('ligar pede a permissão, assina com a chave do gateway e entrega a assinatura', async () => {
    const pushManager = fakeBrowser('default')
    vi.mocked(api).mockImplementation((async (path: string) => (path === '/push/key' ? { publicKey: KEY } : { devices: 1 })) as never)
    expect(await enablePush()).toBe('on')
    expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
    expect(vi.mocked(api).mock.calls.at(-1)).toEqual([
      '/push/subscriptions',
      { method: 'POST', body: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } } },
    ])
  })

  it('desligar avisa o gateway e cancela a assinatura do aparelho', async () => {
    const unsubscribe = vi.fn(async () => true)
    fakeBrowser('granted', { endpoint: 'https://web.push.apple.com/x', unsubscribe })
    vi.mocked(api).mockResolvedValue({ devices: 0 } as never)
    expect(await disablePush()).toBe('off')
    expect(vi.mocked(api)).toHaveBeenCalledWith('/push/subscriptions', { method: 'DELETE', body: { endpoint: 'https://web.push.apple.com/x' } })
    expect(unsubscribe).toHaveBeenCalled()
  })
})
