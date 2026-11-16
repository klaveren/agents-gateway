import { beforeEach, describe, expect, it } from 'vitest'
import { useDrawerWidth } from './useDrawerWidth'

const pointer = (clientX: number) => ({ clientX, pointerId: 1, target: document.body }) as unknown as PointerEvent

describe('useDrawerWidth — a gaveta que a pessoa alarga', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
  })

  it('arrastar a borda muda a largura entre o mínimo e a janela, e ela fica lembrada por gaveta', () => {
    const drawer = useDrawerWidth('gw.teste.width', 460)
    expect(drawer.width.value).toBe(460)
    drawer.onDrag(pointer(100))
    expect(drawer.width.value).toBe(460)
    drawer.startDrag(pointer(1140))
    drawer.onDrag(pointer(900))
    expect(drawer.width.value).toBe(700)
    drawer.onDrag(pointer(1500))
    expect(drawer.width.value).toBe(360)
    drawer.onDrag(pointer(10))
    expect(drawer.width.value).toBe(1520)
    drawer.stopDrag()
    expect(useDrawerWidth('gw.teste.width', 460).width.value).toBe(1520)
    expect(useDrawerWidth('gw.outra.width', 900).width.value).toBe(900)
  })
})
