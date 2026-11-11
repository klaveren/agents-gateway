import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'

/** A rota em atendimento: o método e o caminho REGISTRADO (`/agents/:agentId`), não o pedido. */
export interface IRequestScope {
  method: string
  route: string
}

const storage = new AsyncLocalStorage<IRequestScope>()

/**
 * Abre o escopo da rota para o handler inteiro (como o do chamador): quem decide acesso lá no fundo (`Project.Access`)
 * sabe se o pedido muda algo e qual rota é, sem virar parâmetro em cada assinatura.
 */
export function requestScope(method: string, route: string) {
  return (_req: Request, _res: Response, next: NextFunction) => storage.run({ method: method.toUpperCase(), route }, () => next())
}

export function currentRequest(): IRequestScope | undefined {
  return storage.getStore()
}
