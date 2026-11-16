import { ref } from 'vue'

/** A largura lembrada no navegador. Sem armazenamento (aba privada, bloqueio), vale o padrão e só não lembra. */
function stored(key: string, fallback: number): number {
  try {
    return Number(localStorage.getItem(key)) || fallback
  } catch {
    return fallback
  }
}

/**
 * ⚖️ A GAVETA À DIREITA QUE A PESSOA ALARGA: arrastar a borda esquerda muda a largura, lembrada por gaveta (`key`). Entre
 * `min` e a janela menos 80 px; quem desenha limita de novo pela janela atual (`min(<largura>px, calc(100vw - 360px))`).
 */
export function useDrawerWidth(key: string, fallback: number, min = 360) {
  const width = ref(stored(key, fallback))
  let dragging = false

  function startDrag(event: PointerEvent): void {
    dragging = true
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  function onDrag(event: PointerEvent): void {
    if (!dragging) return
    width.value = Math.min(Math.max(window.innerWidth - event.clientX, min), window.innerWidth - 80)
  }
  function stopDrag(): void {
    if (!dragging) return
    dragging = false
    try {
      localStorage.setItem(key, String(Math.round(width.value)))
    } catch {
      /* sem armazenamento: só não lembra */
    }
  }

  return { width, startDrag, onDrag, stopDrag }
}
