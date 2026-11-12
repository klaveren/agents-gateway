import type { IExecutionContext } from './models/ExecutionContext.Model'

/**
 * ⚖️ A IDENTIDADE DE QUEM CHAMA, PARA FORA: qual agente, em qual conversa, de qual projeto. É o que o `session-identity` do
 * opencode dava ao AKM — a base da auditoria (o `sessionId` do `AuditEntry`) e das camadas de autoridade do `agents-mcp`.
 * - No TERMINAL do agente (o `run_bash`, o Bash do Claude, o shell do Codex), sempre: as variáveis abaixo.
 * - Num MCP, só no servidor cadastrado com "enviar a identidade do agente": os cabeçalhos abaixo. ⛔ Nunca por padrão — um
 *   MCP de terceiros não recebe os ids das conversas sem quem o cadastrou decidir.
 */
export const IDENTITY_ENV = { agent: 'GATEWAY_AGENT_ID', conversation: 'GATEWAY_CONVERSATION_ID', project: 'GATEWAY_PROJECT_ID' } as const
export const IDENTITY_HEADERS = { agent: 'x-gateway-agent', conversation: 'x-gateway-conversation', project: 'x-gateway-project' } as const

type TIdentity = Partial<Record<keyof typeof IDENTITY_ENV, string>>

function identityOf(context: IExecutionContext | undefined): TIdentity {
  const project = context?.conversationProjectId ?? context?.projectId
  return {
    ...(context?.agentId ? { agent: context.agentId } : {}),
    ...(context?.sessionId ? { conversation: context.sessionId } : {}),
    ...(project ? { project } : {}),
  }
}

/** As variáveis do terminal. Sem contexto, nenhuma. */
export function identityEnv(context: IExecutionContext | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(identityOf(context)).map(([key, value]) => [IDENTITY_ENV[key as keyof TIdentity], value]))
}

/** Os cabeçalhos para o MCP que pediu a identidade. Sem contexto, nenhum. */
export function identityHeaders(context: IExecutionContext | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(identityOf(context)).map(([key, value]) => [IDENTITY_HEADERS[key as keyof TIdentity], value]))
}

/**
 * O ambiente do terminal do agente, na ordem em que um vence o outro: as variáveis FIXAS do agente por baixo (ver
 * `IAgent.env`), o que o gateway monta por cima (HOME, PATH, a conexão do CLI) e a identidade por último.
 *
 * ⛔ O agente só ACRESCENTA: a regra já recusa os nomes reservados (`envIssues`), e a ordem garante o resto — nem um
 * nome que a regra deixou passar troca o que o gateway pôs, e a identidade de quem chama nunca é a que o agente diz.
 */
export function terminalEnv<T extends Record<string, string | undefined>>(
  agentEnv: Readonly<Record<string, string>> | undefined,
  gateway: T,
  context: IExecutionContext | undefined,
): T & Record<string, string> {
  // ⚖️ As variáveis secretas do turno por cima do que o gateway monta: o nome já recusa os reservados (`secretNameIssue`).
  return { ...agentEnv, ...gateway, ...context?.secretEnv, ...identityEnv(context) } as T & Record<string, string>
}

/**
 * ⛔ Nomes que dizem AONDE o CLI do provedor conecta e em quem ele confia: o endpoint, o proxy, a CA, a pasta de
 * configuração, a troca de provedor. Quem os fixasse levaria a credencial do provedor (a chave do sistema ou o login
 * da assinatura) a outro servidor.
 */
export const CLI_CONNECTION_ENV =
  /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE|ANTIGRAVITY)_\w*(URL|BASE|HOST|ENDPOINT|CONFIG_DIR|HOME|USE_)\w*$|PROXY$|^(NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)$/i

/**
 * O ambiente do PROCESSO do CLI de um provedor (Claude, Codex, Antigravity): o mesmo `terminalEnv`, com duas travas a mais.
 *
 * ⛔ É este processo que guarda a credencial do provedor. As variáveis do agente e as secretas do turno não fixam a
 * conexão dele (`CLI_CONNECTION_ENV` fica de fora), e o que o gateway monta vence as duas: aqui ninguém troca a
 * chave, o endpoint nem a pasta de configuração que o gateway pôs.
 */
export function cliTerminalEnv<T extends Record<string, string | undefined>>(
  agentEnv: Readonly<Record<string, string>> | undefined,
  gateway: T,
  context: IExecutionContext | undefined,
): T & Record<string, string> {
  const own = (env: Readonly<Record<string, string>> | undefined) => Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !CLI_CONNECTION_ENV.test(name)))
  return { ...own(agentEnv), ...own(context?.secretEnv), ...gateway, ...identityEnv(context) } as T & Record<string, string>
}
