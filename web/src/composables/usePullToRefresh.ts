import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/** Quanto (em px, já com a resistência) o indicador precisa descer para valer ao soltar. */
export const PULL_THRESHOLD = 70
/** O quanto o indicador desce no máximo. */
const PULL_MAX = 120
/** A resistência: o indicador anda menos que o dedo. */
const RESISTANCE = 0.5

/**
 * ⛔ Onde o gesto não vale: campos de texto, o navegador ao vivo, o editor (Monaco), o terminal e o que marcar
 * `data-no-pull`. Lá o arrasto é da própria ferramenta.
 */
const EXCLUDED = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], iframe, .monaco-editor, .xterm, [data-no-pull]'

/** Algum contêiner rolável entre o toque e a raiz já desceu: o arrasto é rolagem, não atualização. */
function scrolledAbove(target: Element | null, root: Element): boolean {
  for (let element = target; element; element = element.parentElement) {
    if (element.scrollTop > 0) return true
    if (element === root) break
  }
  return typeof window !== 'undefined' && window.scrollY > 0
}

export type TPullState = 'idle' | 'pulling' | 'ready' | 'refreshing'

/**
 * 📱 Puxar para atualizar, no toque (celular e o PWA do iPhone, onde o Safari em tela cheia não tem o gesto). Com a área
 * rolável no topo, arrastar para baixo mostra o indicador; passou do limiar e soltou, chama `onRefresh`. Sem toque (mouse),
 * nada muda: só escuta `touch*`.
 */
export function usePullToRefresh(root: Ref<HTMLElement | undefined>, onRefresh: () => Promise<unknown> | unknown) {
  const distance = ref(0)
  const state = ref<TPullState>('idle')
  let startX = 0
  let startY = 0
  /** undefined = ainda não decidiu; true = é o gesto; false = é outra coisa (rolagem, arrasto lateral). */
  let tracking: boolean | undefined
  let armed = false

  function reset() {
    armed = false
    tracking = undefined
    distance.value = 0
    if (state.value !== 'refreshing') state.value = 'idle'
  }

  function onStart(event: TouchEvent) {
    if (state.value === 'refreshing' || event.touches.length !== 1 || !root.value) return reset()
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest(EXCLUDED) || scrolledAbove(target, root.value)) return reset()
    armed = true
    tracking = undefined
    startX = event.touches[0].clientX
    startY = event.touches[0].clientY
  }

  function onMove(event: TouchEvent) {
    if (!armed || tracking === false) return
    const dx = event.touches[0].clientX - startX
    const dy = event.touches[0].clientY - startY
    if (tracking === undefined) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      // Para cima ou para o lado: é rolagem, fica com o navegador.
      if (dy <= 0 || Math.abs(dx) > dy) {
        tracking = false
        return
      }
      tracking = true
    }
    // Voltou para cima do ponto de partida: o indicador some, mas o gesto continua até soltar.
    distance.value = Math.min(PULL_MAX, Math.max(0, dy) * RESISTANCE)
    state.value = distance.value >= PULL_THRESHOLD ? 'ready' : 'pulling'
    // Segura o "elástico" do Safari enquanto o indicador acompanha o dedo.
    if (event.cancelable) event.preventDefault()
  }

  async function onEnd() {
    const fire = armed && tracking === true && distance.value >= PULL_THRESHOLD
    reset()
    if (!fire) return
    state.value = 'refreshing'
    distance.value = PULL_THRESHOLD
    try {
      await onRefresh()
    } finally {
      state.value = 'idle'
      distance.value = 0
    }
  }

  let bound: HTMLElement | undefined
  function unbind() {
    bound?.removeEventListener('touchstart', onStart)
    bound?.removeEventListener('touchmove', onMove)
    bound?.removeEventListener('touchend', onEnd)
    bound?.removeEventListener('touchcancel', reset)
    bound = undefined
  }
  function bind(element: HTMLElement | undefined) {
    if (element === bound) return
    unbind()
    bound = element
    if (!bound) return
    bound.addEventListener('touchstart', onStart, { passive: true })
    // ⚠️ Não passivo: precisa do `preventDefault` para o elástico não brigar com o indicador.
    bound.addEventListener('touchmove', onMove, { passive: false })
    bound.addEventListener('touchend', onEnd)
    bound.addEventListener('touchcancel', reset)
  }
  // O elemento pode nascer depois (ou trocar, com a casca da edição): liga no que estiver lá.
  onMounted(() => bind(root.value))
  watch(root, bind, { flush: 'post' })
  onBeforeUnmount(unbind)

  return { distance, state }
}
