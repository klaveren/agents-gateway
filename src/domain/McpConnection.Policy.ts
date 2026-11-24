/**
 * ⚖️ O 1.º TURNO ESPERA OS MCPs. O CLI do Claude conecta sozinho aos servidores remotos e, por padrão, NÃO espera:
 * o turno começava sem as ferramentas de um servidor lento (o `agents-mcp` da Infoccus leva segundos) e o agente
 * concluía que elas não existiam — só as via no turno seguinte. Agora o CLI espera, com teto; o servidor que passar
 * do teto vira aviso ao agente, no próprio turno.
 */

/** O teto padrão de conexão de cada MCP antes do 1.º turno (ms). */
export const MCP_CONNECT_TIMEOUT_DEFAULT_MS = 15_000

/** A variável do gateway que ajusta o teto (ms). */
export const MCP_CONNECT_TIMEOUT_SETTING = 'CLAUDE_MCP_CONNECT_TIMEOUT_MS'

/** O teto em vigor: o do ambiente do gateway, se for um número positivo; senão o padrão. */
export function mcpConnectTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env[MCP_CONNECT_TIMEOUT_SETTING])
  return Number.isFinite(value) && value > 0 ? Math.round(value) : MCP_CONNECT_TIMEOUT_DEFAULT_MS
}

/**
 * O ambiente que faz o CLI esperar os MCPs.
 *
 * ⚠️ `MCP_CONNECTION_NONBLOCKING=0` é a forma que o changelog do CLI documenta; `MCP_CONNECT_TIMEOUT_MS` é o teto que
 * o modo bloqueante respeita, e `MCP_TIMEOUT` o de partida de cada servidor (as duas em ms).
 */
export function mcpWaitEnv(timeoutMs: number = mcpConnectTimeoutMs()): Record<string, string> {
  return { MCP_CONNECTION_NONBLOCKING: '0', MCP_CONNECT_TIMEOUT_MS: String(timeoutMs), MCP_TIMEOUT: String(timeoutMs) }
}

/**
 * Os servidores do agente que o CLI não ligou, pelo `mcp_servers` do `init`.
 * `expected` mapeia o nome do servidor no CLI ao nome que o agente conhece; servidor fora dele (o local) não conta.
 */
export function unavailableMcpServers(reported: readonly { name: string; status: string }[] | undefined, expected: ReadonlyMap<string, string>): string[] {
  const status = new Map((reported ?? []).map((server) => [server.name, server.status]))
  return [...expected].filter(([name]) => status.get(name) !== 'connected').map(([, label]) => label)
}

/** O aviso ao agente: o servidor existe, só não chegou a tempo. */
export function mcpPendingNote(servers: readonly string[]): string {
  const list = servers.join(', ')
  const one = servers.length === 1
  return `[Aviso do gateway:] ${one ? 'o servidor' : 'os servidores'} ${list} ainda ${one ? 'está' : 'estão'} conectando; as ferramentas ${one ? 'dele' : 'deles'} não estão disponíveis neste turno — não conclua que não existem.`
}
