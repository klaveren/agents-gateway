import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { PULL_THRESHOLD, usePullToRefresh } from './usePullToRefresh'
import { registerRefresh, runRefresh, setRefreshFallback } from '@/lib/pullRefresh'

/** Um toque de mentira (o jsdom não tem `Touch`). */
function touch(target: Element, type: string, y: number, x = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y, target }]
  Object.defineProperty(event, 'touches', { value: touches })
  target.dispatchEvent(event)
  return event
}

function setup(onRefresh = vi.fn()) {
  let api!: ReturnType<typeof usePullToRefresh>
  const Host = defineComponent({
    setup() {
      const root = ref<HTMLElement>()
      api = usePullToRefresh(root, onRefresh)
      return () => h('main', { ref: root }, [h('div', { class: 'list' }, [h('p', { class: 'row' }, 'linha')]), h('textarea', { class: 'composer' })])
    },
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(Host)
  app.mount(host)
  const wrapper = { app, element: host.firstElementChild as HTMLElement, unmount: () => (app.unmount(), host.remove()) }
  return { wrapper, api, onRefresh, row: wrapper.element.querySelector('.row')!, list: wrapper.element.querySelector('.list') as HTMLElement }
}

/** Arrasta de 0 até `to` (em px do dedo) e solta. */
async function pull(target: Element, to: number) {
  touch(target, 'touchstart', 0)
  for (let y = 10; y <= to; y += 10) touch(target, 'touchmove', y)
  touch(target, 'touchend', to)
  await nextTick()
}

let mounted: { app: App; unmount: () => void } | undefined
afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

describe('usePullToRefresh', () => {
  it('passou do limiar e soltou: atualiza; o indicador acompanha o dedo com resistência', async () => {
    const { wrapper, api, onRefresh, row } = setup()
    mounted = wrapper
    touch(row, 'touchstart', 0)
    touch(row, 'touchmove', 100)
    expect(api.distance.value).toBe(50)
    expect(api.state.value).toBe('pulling')
    touch(row, 'touchmove', PULL_THRESHOLD * 2 + 10)
    expect(api.state.value).toBe('ready')
    touch(row, 'touchend', 0)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    await nextTick()
    await nextTick()
    expect(api.state.value).toBe('idle')
  })

  it('antes do limiar: volta sem fazer nada', async () => {
    const { wrapper, api, onRefresh, row } = setup()
    mounted = wrapper
    await pull(row, PULL_THRESHOLD) // o dedo andou 70, o indicador 35
    expect(onRefresh).not.toHaveBeenCalled()
    expect(api.state.value).toBe('idle')
    expect(api.distance.value).toBe(0)
  })

  it('fora do topo (a lista já rolou) não dispara', async () => {
    const { wrapper, onRefresh, row, list } = setup()
    mounted = wrapper
    list.scrollTop = 40
    await pull(row, 300)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('no campo de texto, no navegador ao vivo ou arrastando para o lado não dispara', async () => {
    const { wrapper, onRefresh, row } = setup()
    mounted = wrapper
    await pull(wrapper.element.querySelector('.composer')!, 300)
    row.setAttribute('data-no-pull', '')
    await pull(row, 300)
    row.removeAttribute('data-no-pull')
    touch(row, 'touchstart', 0, 0)
    touch(row, 'touchmove', 20, 80)
    touch(row, 'touchmove', 300, 80)
    touch(row, 'touchend', 0)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('sem toque (mouse) nada muda', async () => {
    const { wrapper, api, onRefresh, row } = setup()
    mounted = wrapper
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 0 }))
    row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 300 }))
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientY: 300 }))
    await nextTick()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(api.state.value).toBe('idle')
  })
})

describe('runRefresh', () => {
  afterEach(() => setRefreshFallback(undefined))

  it('chama as releituras registradas pela tela, e não o fallback', async () => {
    const screen = vi.fn()
    const panel = vi.fn().mockRejectedValue(new Error('caiu'))
    const fallback = vi.fn()
    setRefreshFallback(fallback)
    const offScreen = registerRefresh(screen)
    const offPanel = registerRefresh(panel)
    await runRefresh()
    expect(screen).toHaveBeenCalledTimes(1)
    expect(panel).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
    offScreen()
    offPanel()
  })

  it('sem nenhuma registrada: o fallback (os dados globais)', async () => {
    const fallback = vi.fn()
    setRefreshFallback(fallback)
    await runRefresh()
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
