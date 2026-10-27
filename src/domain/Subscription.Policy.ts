import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

/**
 * Os protocolos que falam pela ASSINATURA de uma pessoa (Claude Pro/Max, ChatGPT, Google), pelo cliente
 * oficial de cada um e com o login feito no host — sem chave de API.
 *
 * ⛔ SÓ A LANE AGENT: as APIs de chat (Messages, Responses, Gemini) exigem chave; a assinatura só vale
 * nos clientes agênticos. A conta é de quem fez o login; quem conversa com esses agentes é decisão de
 * quem cria o agente (`IAgent.adminOnly`).
 */
export const SUBSCRIPTION_PROTOCOLS: readonly EProvider[] = [EProvider.CLAUDE_SUB, EProvider.CODEX, EProvider.ANTIGRAVITY]

export function isSubscription(protocol: EProvider | undefined): boolean {
  return !!protocol && SUBSCRIPTION_PROTOCOLS.includes(protocol)
}

/** As lanes que o protocolo atende. */
export function lanesOf(protocol: EProvider): readonly EMode[] {
  return isSubscription(protocol) ? [EMode.AGENT] : [EMode.CHAT, EMode.AGENT]
}

/**
 * A família de ferramentas nativas: o Claude da assinatura roda o MESMO Claude Agent SDK, então recebe
 * as nativas do Claude (`sdk:WebSearch`…).
 */
export function nativeFamily(protocol: EProvider): EProvider {
  return protocol === EProvider.CLAUDE_SUB ? EProvider.CLAUDE : protocol
}
