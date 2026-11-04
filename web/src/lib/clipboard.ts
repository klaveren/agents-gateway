/**
 * Copia um texto. ⚠️ O `navigator.clipboard` só existe em contexto seguro (HTTPS ou localhost): o gateway servido por
 * `http://10.10.0.4` não o tem, e aí vale o caminho antigo (um campo escondido e `execCommand('copy')`). Lança quando
 * nenhum dos dois copiou — quem chama só diz "Copiado" se deu certo.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  try {
    if (!document.execCommand('copy')) throw new Error('o navegador não permite copiar aqui')
  } finally {
    field.remove()
  }
}
