/**
 * ⚖️ O RASCUNHO NÃO SE PERDE: o texto digitado fica guardado neste navegador, por dono (a conversa, a mensagem) — trocou de
 * tela e voltou, ele está ali. Enviar limpa. É só conveniência de quem digita: o navegador que não guarda (aba anônima,
 * bloqueio) segue sem ele.
 */
const DRAFT_PREFIX = 'gw-draft:'

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

export function writeDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_PREFIX + key, value)
    else localStorage.removeItem(DRAFT_PREFIX + key)
  } catch {
    // Sem o armazenamento do navegador, o rascunho só não sobrevive à troca de tela.
  }
}
