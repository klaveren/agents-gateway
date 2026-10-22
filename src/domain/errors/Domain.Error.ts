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

/**
 * Um agente que não pode ser salvo como veio. Carrega TODOS os problemas, campo a campo: a tela
 * mostra cada um onde ele está, em vez de um de cada vez a cada tentativa.
 */
export class InvalidAgentError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`Agent is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

/** Agente embutido (do código) não se edita nem se apaga pela API: duplica-se. */
export class ReadOnlyAgentError extends DomainError {
  constructor(public readonly agentId: string) {
    super(`Built-in agent is read-only: ${agentId}`)
  }
}

/** Uma conta que não pode ser criada ou mudada como veio. Todos os problemas, campo a campo. */
export class InvalidUserError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`User change is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

export class UserNotFoundError extends DomainError {
  constructor(public readonly userId: string) {
    super(`User not found: ${userId}`)
  }
}

/**
 * Login recusado. ⛔ UMA mensagem só para e-mail inexistente, senha errada e conta desativada:
 * distinguir contaria a quem tenta quais e-mails têm conta.
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('Invalid e-mail or password')
  }
}

/** Tentativas demais para o mesmo e-mail: espera antes de tentar de novo. */
export class LoginLockedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super('Too many attempts. Try again later.')
  }
}

/** O setup do primeiro admin não está disponível: já há conta, ou o pedido não veio desta máquina. */
export class SetupUnavailableError extends DomainError {
  constructor() {
    super('Setup is not available')
  }
}

export class InvalidProviderError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`Provider is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

export class ProviderNotFoundError extends DomainError {
  constructor(public readonly providerId: string) {
    super(`Provider not found: ${providerId}`)
  }
}

/** Provider que algum agente usa não se apaga: troque o provider desses agentes antes. */
export class ProviderInUseError extends DomainError {
  constructor(
    public readonly providerId: string,
    public readonly agents: string[],
  ) {
    super(`Provider ${providerId} is used by: ${agents.join(', ')}`)
  }
}

/** O provider do agente não existe ou está desligado: nenhuma sessão nasce nele. */
export class ProviderUnavailableError extends DomainError {
  constructor(public readonly providerId: string) {
    super(`Provider ${providerId} is not available (missing or disabled). Check it in Providers.`)
  }
}

export class ModelNotFoundError extends DomainError {
  constructor(
    public readonly providerId: string,
    public readonly modelId: string,
  ) {
    super(`Model not found in the catalog of ${providerId}: ${modelId}`)
  }
}

export class InvalidModelError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`Model change is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

/** O agente não tem nenhum modelo ativado no catálogo do provider: nenhuma sessão nasce nele. */
export class AgentWithoutModelError extends DomainError {
  constructor(public readonly agentId: string) {
    super(`Agent ${agentId} has no enabled model. Enable one in Providers → Models, then pick it in the agent.`)
  }
}

/** O que se pediu trocar numa sessão viva não vale (modelo fora do agente, nível fora do protocolo). */
export class InvalidSessionChangeError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`Session change is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

/** A sessão está no meio de um turno: trocar agora valeria pela metade. */
export class SessionBusyError extends DomainError {
  constructor(public readonly sessionId: string) {
    super(`Session ${sessionId} is answering; wait for the turn to finish.`)
  }
}

/** O token de acesso pedido não vale (nome, validade, limite por conta). */
export class InvalidAccessTokenError extends DomainError {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(`Access token is invalid: ${issues.map((issue) => `${issue.field} (${issue.message})`).join('; ')}`)
  }
}

export class AccessTokenNotFoundError extends DomainError {
  constructor(public readonly tokenId: string) {
    super(`Access token not found: ${tokenId}`)
  }
}
