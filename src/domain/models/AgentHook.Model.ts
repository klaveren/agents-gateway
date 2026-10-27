/**
 * Um HOOK de agente: a porta por onde um evento externo (GitHub, um CRM, um cron) aciona o agente.
 *
 * ⚖️ O HOOK É DO AGENTE, e não um webhook genérico ligado depois: `POST /v1/hook/<agente>/<hook>` já diz
 * quem atende e o que fazer — o `prompt` do hook, com o evento recebido junto. Um agente tem quantos quiser.
 */
export type THookVerify = 'key' | 'hmac'
export type THookSession = 'new' | 'continuous'

export interface IAgentHook {
  agentId: string
  name: string
  /** O que o agente faz quando o evento chega. O evento (corpo, headers úteis, query) vai junto. */
  prompt: string
  enabled: boolean
  /** `key`: a chave no header. `hmac`: a assinatura do corpo com a chave (estilo GitHub). */
  verify: THookVerify
  signatureHeader: string
  signaturePrefix: string
  signatureEncoding: 'hex' | 'base64'
  /** `new`: uma conversa por chamada. `continuous`: todas na mesma, em fila (o agente lembra dos eventos). */
  session: THookSession
  /** A conversa de um hook `continuous`. */
  sessionId?: string
  /** ⛔ Em nome de quem o agente roda: a conta que criou o hook (as permissões e a caixa de entrada são dela). */
  runAs: string
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** Uma chamada recebida, para a tela mostrar as últimas. */
export interface IHookDelivery {
  id: string
  agentId: string
  hookName: string
  receivedAt: Date
  status: 'running' | 'ok' | 'error'
  sessionId?: string
  error?: string
}

export const HOOK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const HOOK_DELIVERIES_KEPT = 20
export const HOOK_DEFAULTS = { signatureHeader: 'X-Hub-Signature-256', signaturePrefix: 'sha256=', signatureEncoding: 'hex' as const }

/** A chave do segredo do hook no cofre de credenciais (o mesmo das chaves dos providers). */
export const hookSecretKey = (agentId: string, name: string) => `hook:${agentId}/${name}`
