import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useStickToBottom } from './useStickToBottom'

/** Um elemento rolável de mentira: altura total, visível e posição. */
function scrollable(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const element = { scrollHeight, clientHeight, scrollTop, scrollTo: vi.fn((options: { top: number }) => void (element.scrollTop = options.top - clientHeight)) }
  return element
}

describe('useStickToBottom', () => {
  it('no fim, o conteúdo novo desce a tela; rolou para cima, para de descer e marca o que chegou', async () => {
    const element = scrollable(1000, 400, 600)
    const stick = useStickToBottom(ref(element as unknown as HTMLElement))
    stick.grew()
    await nextTick()
    expect(element.scrollTo).toHaveBeenCalledTimes(1)

    element.scrollTop = 100
    stick.onScroll()
    expect(stick.pinned.value).toBe(false)
    stick.grew()
    await nextTick()
    expect(element.scrollTo).toHaveBeenCalledTimes(1)
    expect(stick.unseen.value).toBe(true)
  })

  it('voltar ao fim (ou perto dele) retoma; toBottom força e limpa o aviso', async () => {
    const element = scrollable(1000, 400, 100)
    const stick = useStickToBottom(ref(element as unknown as HTMLElement))
    stick.onScroll()
    stick.grew()
    expect(stick.unseen.value).toBe(true)
    element.scrollTop = 550
    stick.onScroll()
    expect([stick.pinned.value, stick.unseen.value]).toEqual([true, false])

    element.scrollTop = 0
    stick.onScroll()
    stick.toBottom()
    await nextTick()
    expect([stick.pinned.value, stick.unseen.value]).toEqual([true, false])
    expect(element.scrollTo).toHaveBeenLastCalledWith({ top: 1000 })
  })
})
