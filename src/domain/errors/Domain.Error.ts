/**
 * Erros que o domínio sabe nomear.
 *
 * O domínio segue sem saber o que é HTTP: quem traduz para status e código de resposta é o
 * mapper em `@infra/http/Http.Error`. O que importa aqui é que "agente inexistente" e
 * "falhou por qualquer motivo" deixem de ser a mesma coisa.
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class AgentNotFoundError extends DomainError {
  constructor(public readonly agentId: string) {
    super(`Agent not found: ${agentId}`)
  }
}

export class SessionNotFoundError extends DomainError {
  constructor(public readonly sessionId: string) {
    super(`Session not found: ${sessionId}`)
  }
}

export class ModeNotSupportedError extends DomainError {
  constructor(
    public readonly agentId: string,
    public readonly mode: string,
  ) {
    super(`Agent ${agentId} does not support mode: ${mode}`)
  }
}

export class AdapterNotFoundError extends DomainError {
  constructor(
    public readonly provider: string,
    public readonly mode: string,
  ) {
    super(`Adapter not found for provider: ${provider} (mode: ${mode})`)
  }
}

export class ToolsNotSupportedError extends DomainError {
  constructor(public readonly mode: string) {
    super(`The manual tool loop is only available on the chat lane, not on "${mode}"`)
  }
}

/**
 * O agente existe, funciona, e não atende agora.
 *
 * ⚖️ NÃO É "não encontrado" nem "sem permissão": é uma DECISÃO de operação, tomada na
 * configuração. A distinção importa no relato — quem lê "indisponível" não sai procurando
 * servidor caído nem pedindo acesso.
 */
export class AgentUnavailableError extends DomainError {
  constructor(message = 'O agente está indisponível no momento.') {
    super(message)
    this.name = 'AgentUnavailableError'
  }
}

/**
 * Uma alteração de configuração que não faz sentido — por exemplo, apagar um campo obrigatório.
 * É erro de quem pediu (422), e não do serviço.
 */
export class InvalidSettingsError extends DomainError {
  constructor(public readonly field: string) {
    super(`Settings field cannot be cleared: ${field}`)
  }
}
