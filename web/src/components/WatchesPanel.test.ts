import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import type { IWatchItem } from '@/lib/types'
import WatchesPanel from './WatchesPanel.vue'

const NOW = new Date('2026-01-01T10:02:00Z')
const command: IWatchItem = { id: 'w-1', kind: 'command', label: 'servidor voltar', command: 'curl -sf http://x/health', everySeconds: 60, status: 'active', createdAt: '2026-01-01T10:00:00Z', deadlineAt: '2026-01-01T11:00:00Z', checks: 2 }
const timer: IWatchItem = { id: 'w-2', kind: 'timer', label: 'ticket fechar', status: 'active', createdAt: '2026-01-01T10:01:30Z', deadlineAt: '2026-01-01T10:30:00Z', checks: 0 }

let app: App | undefined
function mount(items: IWatchItem[], stop: (id: string) => Promise<boolean>) {
  const host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(WatchesPanel, { items, stop }) })
  app.mount(host)
  return host
}
const button = (text: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('WatchesPanel', () => {
  it('diz o que está sendo vigiado, há quanto tempo, de quanto em quanto e até quando', () => {
    vi.useFakeTimers({ now: NOW })
    const host = mount([command, timer], async () => true)
    const lines = [...host.querySelectorAll('li')].map((line) => [...line.querySelectorAll('span:not(:has(span))')].map((part) => part.textContent?.trim()))
    expect(lines[0]).toEqual(['Vigiando', 'servidor voltar', 'há 2 min · confere a cada 1 min · prazo em 58 min'])
    expect(lines[1]).toEqual(['Despertador', 'ticket fechar', 'agora · acorda em 28 min'])
    // O comando conferido fica na dica do rótulo, para quem quer saber o que roda.
    expect(host.querySelector('li [title]')?.getAttribute('title')).toBe('curl -sf http://x/health')
  })

  it('cancelar pede confirmação, e só o confirmar para a vigia', async () => {
    vi.useFakeTimers({ now: NOW })
    const stop = vi.fn(async () => true)
    const host = mount([command], stop)
    host.querySelector<HTMLButtonElement>('li button')?.click()
    await nextTick()
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('Parar de vigiar?')
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain('servidor voltar')

    // "Cancelar" no diálogo é desistir de parar: a vigia segue.
    const dismiss = [...document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((item) => item.textContent?.trim() === 'Cancelar')
    dismiss?.click()
    await nextTick()
    expect(stop).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

    host.querySelector<HTMLButtonElement>('li button')?.click()
    await nextTick()
    button('Parar de vigiar')?.click()
    await nextTick()
    await nextTick()
    expect(stop).toHaveBeenCalledWith('w-1')
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
