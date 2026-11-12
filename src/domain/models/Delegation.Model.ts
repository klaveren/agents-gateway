import { liveLimit } from './Limits.Model'

/**
 * Delegação: um agente falando com outro — numa conversa FILHA ligada à que a originou, ou na conversa que a mesma
 * pessoa já tem com ele.
 *
 * ⚖️ QUEM PODE CHAMAR QUEM está no próprio agente, em `allowedTools`, como `agent:<id>` — o mesmo esquema
 * de `sdk:` (nativas) e `mcp:` (servidores MCP). Com ao menos um, o agente ganha a ferramenta `talk` (ver
 * `Talk.Model`), que só aceita os escolhidos.
 */
export const AGENT_TOOL_PREFIX = 'agent:'
/** A ferramenta de falar com outro agente (a do MCP do gateway, para pessoas, tem o mesmo nome e outras regras). */
export const DELEGATE_TOOL_NAME = 'talk'
/** O nome de antes (os turnos gravados e os prompts escritos ainda o citam). */
export const LEGACY_DELEGATE_TOOL_NAME = 'delegate_to_agent'

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
 * ⛔ O `talk` DO MCP DO GATEWAY É DE QUEM ESTÁ DE FORA (pessoa, integração), nunca de agente: por ele um agente chegava a
 * qualquer outro sem nenhuma trava da delegação (lista `agent:<id>`, regra `delegate`, profundidade, ciclo). Agente fala
 * com agente pelo `talk` LOCAL (`Talk.Tool`), que tem as travas — e também continua uma conversa da MESMA pessoa com o
 * outro agente (ver `ownIssue` em `Delegation.Service`). Os nomes antigos ficam na lista só para não voltarem por engano.
 */
export const PEOPLE_ONLY_GATEWAY_TOOLS: readonly string[] = ['talk', 'start_conversation', 'send_message', 'get_turn']
