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

/**
 * A RESPOSTA DE OUTRO AGENTE que o gateway entrega como mensagem (o `talk` sem esperar, ou a que chegou depois do turno —
 * ver `Delegation.Service.deliver`): não é fala da pessoa. Na tela vira um cartão com quem respondeu e a conversa dele.
 */
const REPLY = /^\[Resposta de ([^\s(]+) \(conversation ([^)\s]+)\), ([^:\]]+): leia e continue de onde parou\.\]\s*([\s\S]*)$/
const FAILED = /^\[A conversa com ([^\s(]+) \(conversation ([^)\s]+)\) falhou, (que você pediu sem esperar|que chegou depois do fim do seu turno): ([\s\S]*?)\. Decida: [\s\S]*\]$/

export interface IAgentReply {
  agentId: string
  conversationId: string
  ok: boolean
  /** A resposta (markdown) ou o erro. */
  body: string
}

export function agentReply(request: string | undefined): IAgentReply | undefined {
  const text = (request ?? '').trim()
  const reply = REPLY.exec(text)
  if (reply) return { agentId: reply[1]!, conversationId: reply[2]!, ok: true, body: (reply[4] ?? '').trim() || '(sem texto)' }
  const failed = FAILED.exec(text)
  if (failed) return { agentId: failed[1]!, conversationId: failed[2]!, ok: false, body: (failed[4] ?? '').trim() }
  return undefined
}
