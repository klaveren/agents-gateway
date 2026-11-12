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

/** Cabeçalho que só um proxy ou um navegador acrescenta — o `curl` do deploy, nunca. */
const NOT_THE_HOST_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'origin', 'sec-fetch-site', 'sec-fetch-mode']

/**
 * ⛔ A requisição veio do PRÓPRIO servidor, sem proxy no meio: o socket é loopback (ou o endereço em que ele escuta) E não há
 * cabeçalho de encaminhamento. Com um proxy na mesma máquina todo mundo chegaria como loopback; o proxy sempre
 * acrescenta `X-Forwarded-*`/`Forwarded`/`X-Real-IP`, e o `curl` do deploy não — então quem tem cabeçalho nunca é "o host".
 *
 * ⛔ Nem uma PÁGINA aberta no navegador da máquina: ela também chega como loopback, mas o navegador sempre marca o pedido
 * (`Origin` em todo POST de outra origem, `Sec-Fetch-*` em todo pedido) e o script da página não consegue tirar a marca.
 */
export function fromThisHostDirectly(req: Request): boolean {
  const remote = req.socket?.remoteAddress?.replace(/^::ffff:/, '')
  const local = req.socket?.localAddress?.replace(/^::ffff:/, '')
  const headers = req.headers ?? {}
  if (NOT_THE_HOST_HEADERS.some((name) => headers[name] !== undefined)) return false
  return !!remote && (remote === '127.0.0.1' || remote === '::1' || remote === local)
}
