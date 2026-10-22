/**
 * Preferência local do navegador. ⚠️ Pode não existir (aba privada, armazenamento bloqueado): toda
 * leitura e escrita tolera a falha e a tela segue com o padrão.
 */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // Sem armazenamento: vale só nesta aba.
  }
}
