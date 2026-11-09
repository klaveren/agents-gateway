/**
 * ⚖️ A AUDITORIA: um evento por ação que muda algo no gateway (criar, salvar, apagar, entrar, compartilhar, aprovar,
 * mandar mensagem…), gravado por quem passa por toda rota (ver `Audit.Trail`). Quem, o quê, em quê, quando, de onde
 * e como terminou.
 *
 * ⛔ SEM O CORPO da requisição: senha, chave de API e o texto da conversa não moram aqui. O que identifica o alvo são
 * os parâmetros da rota (os ids). O texto das conversas tem o seu próprio registro (os turnos gravados).
 */
export interface IAuditEvent {
  id: number
  at: Date
  /** Quem: a conta (id e e-mail, como o token afirma) e, quando foi um agente, o agente e a conversa dele. */
  actorId?: string
  actorEmail?: string
  agentId?: string
  conversationId?: string
  /** O quê: método e rota (`POST /agents/:agentId/shares`). A tela traduz as conhecidas. */
  action: string
  /** Em quê: os parâmetros da rota (`{ agentId: 'atlas' }`). */
  target?: Record<string, string>
  /** Como terminou: o status HTTP (>= 400 = recusado ou falhou). */
  status: number
  durationMs?: number
  ip?: string
  /** O e-mail que tentou entrar (login e setup): a conta ainda não existe na credencial. */
  detail?: string
  /** Recusado ou com falha: a mensagem que a API devolveu (e, num 422, os campos), cortada. */
  error?: string
}

export type TNewAuditEvent = Omit<IAuditEvent, 'id'>

/** O recorte da consulta: tudo opcional, e se soma. `before` é o cursor (o id do último da página anterior). */
export interface IAuditQuery {
  since?: Date
  until?: Date
  /** Parte do id ou do e-mail de quem fez. */
  actor?: string
  /** Parte da ação (`agents`, `DELETE`, `/auth/login`). */
  action?: string
  /** Só os recusados ou com falha (status >= 400). */
  failed?: boolean
  before?: number
  limit?: number
}

export const AUDIT_PAGE_MAX = 200
