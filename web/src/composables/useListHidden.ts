import { ref } from 'vue'

const KEY = 'gw.conversations.hidden'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** A lista de conversas escondida (no desktop, com uma conversa aberta): mais largura para a conversa e o navegador. Lembrada no navegador. */
const hidden = ref(read())

export function useListHidden() {
  function toggle() {
    hidden.value = !hidden.value
    try {
      localStorage.setItem(KEY, hidden.value ? '1' : '0')
    } catch {
      // sem armazenamento: vale só nesta aba
    }
  }
  return { hidden, toggle }
}
