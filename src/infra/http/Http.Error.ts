import { AdapterNotFoundError, AgentNotFoundError, ModeNotSupportedError, SessionNotFoundError } from '@domain/errors/Domain.Error'

export type TErrorCode = 'validation_error' | 'agent_not_found' | 'session_not_found' | 'mode_not_supported' | 'adapter_not_found' | 'unauthorized' | 'not_found' | 'internal_error'

export interface IHttpFailure {
  status: number
  code: TErrorCode
  message: string
  details?: unknown
}

/** Erro que já sabe como quer sair na resposta. Usado pelos middlewares e pela validação. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: TErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Traduz o que o domínio lançou para status e código.
 *
 * Antes tudo virava 500, inclusive "agente inexistente" — o cliente não tinha como
 * distinguir o erro dele do erro nosso.
 */
export function toHttpFailure(error: unknown): IHttpFailure {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details }
  }

  if (error instanceof AgentNotFoundError) {
    return { status: 404, code: 'agent_not_found', message: error.message }
  }

  if (error instanceof SessionNotFoundError) {
    return { status: 404, code: 'session_not_found', message: error.message }
  }

  if (error instanceof ModeNotSupportedError) {
    return { status: 422, code: 'mode_not_supported', message: error.message }
  }

  if (error instanceof AdapterNotFoundError) {
    return { status: 500, code: 'adapter_not_found', message: error.message }
  }

  return {
    status: 500,
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  }
}
