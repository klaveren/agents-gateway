/**
 * O AVISO DO GATEWAY que entra numa conversa como turno (a vigia que disparou, a decisão de um pedido de permissão): o
 * servidor o escreve começando por `[Aviso do gateway, não é mensagem da pessoa: …]`. Na tela ele não é fala de ninguém.
 */
const NOTICE = /^\[Aviso do gateway, não é mensagem da pessoa: ([^\n]*)\](?:\n([\s\S]*))?$/

export interface IGatewayNotice {
  /** O que aconteceu, numa linha. */
  what: string
  /** O resto do aviso (a saída da conferência, o que o agente anotou): fica recolhido. */
  detail: string
}

export function gatewayNotice(request: string | undefined): IGatewayNotice | undefined {
  const match = NOTICE.exec((request ?? '').trim())
  if (!match) return undefined
  const what = (match[1] ?? '').trim()
  return { what: what.charAt(0).toUpperCase() + what.slice(1), detail: (match[2] ?? '').trim() }
}
