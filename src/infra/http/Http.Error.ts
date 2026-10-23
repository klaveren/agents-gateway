import {
  AdapterNotFoundError,
  AgentNotFoundError,
  AgentUnavailableError,
  AgentWithoutModelError,
  InvalidAgentError,
  InvalidModelError,
  InvalidSessionChangeError,
  SessionBusyError,
  ModelNotFoundError,
  InvalidProviderError,
  ProviderInUseError,
  InvalidMcpServerError,
  McpServerNotFoundError,
  McpServerInUseError,
  ProviderNotFoundError,
  ProviderUnavailableError,
  SubagentOnlyError,
  SubscriptionRestrictedError,
  InvalidCredentialsError,
  InvalidUserError,
  InvalidAccessTokenError,
  AccessTokenNotFoundError,
  LoginLockedError,
  SetupUnavailableError,
  UserNotFoundError,
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
  | 'provider_in_use'
  | 'mcp_server_in_use'
  | 'provider_unavailable'
  | 'subscription_restricted'
  | 'subagent_only'
  | 'upstream_error'
  | 'agent_without_model'
  | 'invalid_credentials'
  | 'login_locked'
  | 'session_not_found'
  | 'session_busy'
  | 'mode_not_supported'
  | 'tools_not_supported'
  | 'adapter_not_found'
  | 'agent_unavailable'
  | 'unauthorized'
  | 'forbidden'
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

  if (error instanceof AgentWithoutModelError) {
    return { status: 422, code: 'agent_without_model', message: error.message }
  }

  if (error instanceof InvalidSessionChangeError) {
    return { status: 422, code: 'validation_error', message: 'Session change is invalid', details: error.issues }
  }

  if (error instanceof SessionBusyError) {
    return { status: 409, code: 'session_busy', message: error.message }
  }

  if (error instanceof InvalidModelError) {
    return { status: 422, code: 'validation_error', message: 'Model change is invalid', details: error.issues }
  }

  if (error instanceof ModelNotFoundError) {
    return { status: 404, code: 'not_found', message: error.message }
  }

  if (error instanceof InvalidProviderError) {
    return { status: 422, code: 'validation_error', message: 'Provider is invalid', details: error.issues }
  }

  if (error instanceof ProviderNotFoundError) {
    return { status: 404, code: 'not_found', message: 'Not found' }
  }

  if (error instanceof InvalidMcpServerError) {
    return { status: 422, code: 'validation_error', message: 'MCP server is invalid', details: error.issues }
  }

  if (error instanceof McpServerNotFoundError) {
    return { status: 404, code: 'not_found', message: error.message }
  }

  if (error instanceof McpServerInUseError) {
    return { status: 409, code: 'mcp_server_in_use', message: error.message, details: { agents: error.agents } }
  }

  if (error instanceof ProviderInUseError) {
    return { status: 409, code: 'provider_in_use', message: error.message, details: { agents: error.agents } }
  }

  if (error instanceof SubagentOnlyError) {
    return { status: 422, code: 'subagent_only', message: error.message }
  }

  if (error instanceof SubscriptionRestrictedError) {
    return { status: 403, code: 'subscription_restricted', message: error.message }
  }

  if (error instanceof ProviderUnavailableError) {
    return { status: 422, code: 'provider_unavailable', message: error.message }
  }

  if (error instanceof InvalidAccessTokenError) {
    return { status: 422, code: 'validation_error', message: 'Access token is invalid', details: error.issues }
  }

  if (error instanceof AccessTokenNotFoundError) {
    return { status: 404, code: 'not_found', message: error.message }
  }

  if (error instanceof InvalidUserError) {
    return { status: 422, code: 'validation_error', message: 'User change is invalid', details: error.issues }
  }

  if (error instanceof InvalidCredentialsError) {
    return { status: 401, code: 'invalid_credentials', message: error.message }
  }

  if (error instanceof LoginLockedError) {
    return { status: 429, code: 'login_locked', message: error.message, details: { retryAfterSeconds: error.retryAfterSeconds } }
  }

  // ⚠️ 404 para os dois: setup fechado e conta inexistente não contam nada a quem sonda.
  if (error instanceof SetupUnavailableError || error instanceof UserNotFoundError) {
    return { status: 404, code: 'not_found', message: 'Not found' }
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
