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
