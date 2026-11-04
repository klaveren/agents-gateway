import { ref } from 'vue'

/** A largura da coluna da lista (Conversas, Agentes, Usuários…), em px: uma só para todas as telas. */
export const LIST_WIDTH = { default: 340, min: 260, max: 640 } as const
const KEY = 'layout.listWidth'

const clamp = (value: number) => Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, value)))

function stored(): number {
  try {
    const value = Number(localStorage.getItem(KEY))
    return Number.isFinite(value) && value > 0 ? clamp(value) : LIST_WIDTH.default
  } catch {
    return LIST_WIDTH.default
  }
}

// ⚖️ Compartilhada: arrastar numa tela vale para as outras, e a largura volta no próximo acesso (o navegador guarda).
const width = ref(stored())

export function useListWidth() {
  const set = (value: number) => {
    width.value = clamp(value)
    try {
      localStorage.setItem(KEY, String(width.value))
    } catch {
      // Sem armazenamento (aba anônima, bloqueio): vale até recarregar.
    }
  }
  return { width, set, reset: () => set(LIST_WIDTH.default) }
}
