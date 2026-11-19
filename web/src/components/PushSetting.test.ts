import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import PushSetting from './PushSetting.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined
async function flush() {
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}
const CONFIG = { publicKey: 'BPUB', contact: 'mailto:push@agents-gateway.invalid', custom: false, devices: 2 }

async function mount() {
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: Record<string, string> }) => {
    if (init?.method === 'PUT' && init.body?.contact !== undefined) return { ...CONFIG, contact: `mailto:${init.body.contact}`, custom: true }
    if (init?.method === 'PUT') return { ...CONFIG, publicKey: init.body?.publicKey, devices: 0 }
    return CONFIG
  }) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(PushSetting) })
  app.mount(host)
  await flush()
  return host
}

afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

const type = async (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('Aviso no celular nas Configurações', () => {
  it('mostra a chave pública e quantos aparelhos recebem; salva o contato', async () => {
    const host = await mount()
    expect(host.querySelector('[data-test="push-public-key"]')?.textContent).toBe('BPUB')
    expect(host.querySelector('[data-test="push-devices"]')?.textContent).toContain('2 aparelhos')
    await type(host.querySelector<HTMLInputElement>('[data-test="push-contact"]')!, 'ops@empresa.com')
    host.querySelector<HTMLButtonElement>('[data-test="push-contact-save"]')!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/push/config', { method: 'PUT', body: { contact: 'ops@empresa.com' } })
    expect(host.textContent).toContain('Contato salvo')
  })

  it('usar as próprias chaves manda as duas e limpa o campo da privada', async () => {
    const host = await mount()
    host.querySelector<HTMLButtonElement>('[data-test="push-import"]')!.click()
    await flush()
    const inputs = host.querySelectorAll<HTMLInputElement>('[data-test="push-import-form"] input')
    await type(inputs[0], 'BNOVA')
    await type(inputs[1], 'privada')
    host.querySelector<HTMLButtonElement>('[data-test="push-import-save"]')!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/push/config', { method: 'PUT', body: { publicKey: 'BNOVA', privateKey: 'privada' } })
    expect(host.querySelector('[data-test="push-import-form"]')).toBeNull()
    expect(host.querySelector('[data-test="push-public-key"]')?.textContent).toBe('BNOVA')
  })
})
