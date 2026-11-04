import { nextTick, ref, type Ref } from 'vue'

/** Até aqui do fim conta como "no fim" (a última linha meio escondida, um arredondamento). */
export const BOTTOM_SLACK_PX = 80

/**
 * ⚖️ A ROLAGEM SEGUE O FIM SÓ ENQUANTO A PESSOA ESTÁ NELE: rolou para cima para ler, a tela para de descer sozinha (e o
 * que chega marca `unseen`); voltou ao fim, ou chamou `toBottom` (enviou, trocou de conversa), ela volta a seguir.
 */
export function useStickToBottom(scroller: Ref<HTMLElement | undefined | null>) {
  const pinned = ref(true)
  const unseen = ref(false)

  function onScroll() {
    const element = scroller.value
    if (!element) return
    pinned.value = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX
    if (pinned.value) unseen.value = false
  }

  function scrollDown() {
    void nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }))
  }

  function toBottom() {
    pinned.value = true
    unseen.value = false
    scrollDown()
  }

  /** Chegou conteúdo novo embaixo: segue se estava no fim; senão, só marca. */
  function grew() {
    if (pinned.value) scrollDown()
    else unseen.value = true
  }

  return { pinned, unseen, onScroll, toBottom, grew }
}
