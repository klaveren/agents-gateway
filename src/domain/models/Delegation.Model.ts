import { liveLimit } from './Limits.Model'

/**
 * Delegação: um agente pedindo a outro, numa conversa FILHA ligada à que a originou.
 *
 * ⚖️ QUEM PODE CHAMAR QUEM está no próprio agente, em `allowedTools`, como `agent:<id>` — o mesmo esquema
 * de `sdk:` (nativas) e `mcp:` (servidores MCP). Com ao menos um, o agente ganha a ferramenta
 * `delegate_to_agent`, que só aceita os escolhidos.
 */
export const AGENT_TOOL_PREFIX = 'agent:'
export const DELEGATE_TOOL_NAME = 'delegate_to_agent'

/** Chaves do `metadata` da conversa filha — simples, para a listagem poder filtrar (`?delegatedBy=<id>`). */
export const DELEGATED_BY = 'delegatedBy'
export const DELEGATED_FROM = 'delegatedFrom'
export const DELEGATION_DEPTH = 'delegationDepth'
export const DELEGATION_CHAIN = 'delegationChain'

/** Profundidade máxima: a raiz chama (1), a filha chama (2), e para aí. As configurações (ou `DELEGATION_MAX_DEPTH`) mudam. */
export function delegationMaxDepth(env: NodeJS.ProcessEnv = process.env): number {
  const configured = liveLimit('delegationMaxDepth')
  if (configured !== undefined) return configured
  const parsed = Number.parseInt(env.DELEGATION_MAX_DEPTH ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2
}

export function isAgentToolRef(entry: string): boolean {
  return entry.startsWith(AGENT_TOOL_PREFIX)
}

/** Os agentes a quem este pode delegar, na ordem em que foram escolhidos. */
export function delegatesOf(allowedTools: readonly string[]): string[] {
  return [
    ...new Set(
      allowedTools
        .filter(isAgentToolRef)
        .map((entry) => entry.slice(AGENT_TOOL_PREFIX.length))
        .filter(Boolean),
    ),
  ]
}

/**
 * ⛔ AS FERRAMENTAS DE CONVERSA DO MCP DO GATEWAY SÃO DE QUEM ESTÁ DE FORA (pessoa, integração), nunca de agente: por
 * elas um agente chegava a qualquer outro sem nenhuma trava da delegação (lista `agent:<id>`, regra `delegate`,
 * profundidade, ciclo). Agente fala com agente só por `delegate_to_agent`.
 */
export const PEOPLE_ONLY_GATEWAY_TOOLS: readonly string[] = ['start_conversation', 'send_message', 'get_turn']
