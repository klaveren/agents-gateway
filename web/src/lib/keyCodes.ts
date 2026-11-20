/** ⌨️ As teclas que o navegador ao vivo repassa à aba do agente (ver `LiveBrowser.vue`). */
/** As teclas que não escrevem nada: vão como tecla (com o código que a página espera). */
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}
/** As teclas de pontuação pelo `code` (a posição): o código do caractere não serve — o do ponto (46) é o do Delete. */
const PUNCTUATION_CODES: Record<string, number> = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
  NumpadDecimal: 110,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadMultiply: 106,
  NumpadDivide: 111,
}
/**
 * ⌨️ O código de tecla que a página espera (`windowsVirtualKeyCode`). ⛔ Nunca o código do caractere: o do ponto (46) é o do
 * Delete, o da vírgula (44) o do PrintScreen — a página apagava em vez de escrever.
 */
export function keyCodeOf(event: Pick<KeyboardEvent, 'key' | 'code'>): number | undefined {
  if (event.key in KEY_CODES) return KEY_CODES[event.key]
  const code = event.code || ''
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3)
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5)
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6))
  if (code === 'Space') return 32
  if (code in PUNCTUATION_CODES) return PUNCTUATION_CODES[code]
  // Sem `code` (teclado virtual): letra e número pelo caractere; o resto vai só como texto.
  return /^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase().charCodeAt(0) : undefined
}
/** A tecla que não escreve nada mas a página precisa (apagar, setas, Enter...). */
export function isControlKey(key: string): boolean {
  return key in KEY_CODES
}
