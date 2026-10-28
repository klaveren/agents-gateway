import { randomBytes } from 'node:crypto'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { ILocalTool } from './Tool.Types'

/** O que um turno concedeu: as ferramentas do gateway e o contexto em que elas rodam. */
export interface ITurnGrant {
  tools: readonly ILocalTool[]
  context: IExecutionContext
}

/**
 * ⛔ AS FERRAMENTAS DO GATEWAY PARA UM CLI (Codex, Gemini), presas a UM TURNO.
 *
 * O CLI chama por MCP (`/v1/turn-tools`), mas quem executa é o gateway, com as permissões e o cerco do agente. O token
 * é aleatório, vale só enquanto o turno roda e carrega a lista EXATA de ferramentas e o contexto (agente, conversa,
 * projeto) decididos pelo adapter. Ninguém escolhe agente nem ferramenta pelo header: só apresenta o token.
 */
export class TurnGrants {
  private readonly grants = new Map<string, ITurnGrant>()

  register(grant: ITurnGrant): string {
    const token = randomBytes(24).toString('base64url')
    this.grants.set(token, grant)
    return token
  }

  get(token: string | undefined): ITurnGrant | undefined {
    return token ? this.grants.get(token) : undefined
  }

  release(token: string): void {
    this.grants.delete(token)
  }
}

let shared: TurnGrants | undefined
/** As concessões do processo (o adapter registra; a rota consulta). */
export function turnGrants(): TurnGrants {
  shared ??= new TurnGrants()
  return shared
}
