import { Request } from 'express'
import { HttpError } from './Http.Error'

/** Quanto tempo quem chama espera antes de tentar de novo (o `Retry-After` do 503 `draining`). */
export const DRAIN_RETRY_SECONDS = 30

let draining = false

/**
 * ⚖️ O MODO DRENO do deploy: o gateway para de ACEITAR turno novo e deixa os em andamento acabarem. Só em memória, de
 * propósito: o processo que reinicia nasce sem dreno, e um deploy que morre no meio não deixa o gateway recusando turnos
 * para sempre.
 */
export const drain = {
  active: (): boolean => draining,
  set: (on: boolean): void => {
    draining = on
  },
}

/** ⛔ Turno NOVO (conversa nova, mensagem, `turns`) com o dreno ligado: 503 `draining`. Quem chama tenta de novo depois. */
export function refuseWhenDraining(): void {
  if (draining)
    throw new HttpError(503, 'draining', 'The gateway is restarting for an update: no new turns are accepted right now. Retry shortly.', { retryAfterSeconds: DRAIN_RETRY_SECONDS })
}

/**
 * ⛔ A requisição veio do PRÓPRIO servidor, sem proxy no meio: o socket é loopback (ou o endereço em que ele escuta) E não há
 * cabeçalho de encaminhamento. Com um proxy na mesma máquina todo mundo chegaria como loopback; o proxy sempre
 * acrescenta `X-Forwarded-*`/`Forwarded`/`X-Real-IP`, e o `curl` do deploy não — então quem tem cabeçalho nunca é "o host".
 */
export function fromThisHostDirectly(req: Request): boolean {
  const remote = req.socket?.remoteAddress?.replace(/^::ffff:/, '')
  const local = req.socket?.localAddress?.replace(/^::ffff:/, '')
  const headers = req.headers ?? {}
  if (['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'].some((name) => headers[name] !== undefined)) return false
  return !!remote && (remote === '127.0.0.1' || remote === '::1' || remote === local)
}
