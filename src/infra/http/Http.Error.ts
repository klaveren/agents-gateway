import {
  AdapterNotFoundError,
  AgentNotFoundError,
  AgentUnavailableError,
  InvalidAgentError,
  InvalidSettingsError,
  ModeNotSupportedError,
  ReadOnlyAgentError,
  SessionNotFoundError,
  ToolsNotSupportedError,
} from '@domain/errors/Domain.Error'

export type TErrorCode =
  | 'validation_error'
  | 'agent_not_found'
  | 'agent_read_only'
  | 'session_not_found'
  | 'mode_not_supported'
  | 'tools_not_supported'
  | 'adapter_not_found'
  | 'agent_unavailable'
  | 'unauthorized'
  | 'not_found'
  | 'internal_error'

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

  if (error instanceof AgentUnavailableError) {
    /**
     * 403, e um código PRÓPRIO.
     *
     * ⚖️ Não é 404: o agente existe. Não é 500: ninguém quebrou — isto é uma decisão de operação, e
     * mandar quem lê procurar defeito é o erro que este código existe para não cometer. E não é 503,
     * que acenderia monitoramento de queda por um desligamento deliberado.
     *
     * ⚠️ O CÓDIGO NÃO É `unauthorized`. Ele mandaria a pessoa pedir acesso a alguém, quando o que
     * ela precisa é que alguém religue o agente. O status é o mesmo; o código é o que diz o que
     * fazer a seguir.
     */
    return { status: 403, code: 'agent_unavailable', message: error.message }
  }

  if (error instanceof InvalidAgentError) {
    return { status: 422, code: 'validation_error', message: 'Agent is invalid', details: error.issues }
  }

  if (error instanceof ReadOnlyAgentError) {
    return { status: 409, code: 'agent_read_only', message: error.message }
  }

  if (error instanceof InvalidSettingsError) {
    return { status: 422, code: 'validation_error', message: error.message }
  }

  if (error instanceof ModeNotSupportedError) {
    return { status: 422, code: 'mode_not_supported', message: error.message }
  }

  if (error instanceof ToolsNotSupportedError) {
    return { status: 422, code: 'tools_not_supported', message: error.message }
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
