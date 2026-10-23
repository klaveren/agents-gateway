import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

/**
 * Os protocolos que falam pela ASSINATURA de uma pessoa (Claude Pro/Max, ChatGPT, Google), pelo cliente
 * oficial de cada um e com o login feito no host — sem chave de API.
 *
 * ⛔ SÓ A LANE AGENT: as APIs de chat (Messages, Responses, Gemini) exigem chave; a assinatura só vale
 * nos clientes agênticos. ⛔ USO PESSOAL: a conta é de quem fez o login, e por padrão só admin conversa
 * com esses agentes (`SUBSCRIPTION_ADMIN_ONLY`).
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

/** ⚖️ Ligado por padrão; `SUBSCRIPTION_ADMIN_ONLY=0` abre para qualquer conta. */
export function subscriptionAdminOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBSCRIPTION_ADMIN_ONLY?.trim() !== '0'
}
