import { DelegationService } from '@application/Delegation.Service'
import { DELEGATE_TOOL_NAME } from '@domain/models/Delegation.Model'
import { ILocalTool } from './Tool.Types'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { askerOf } from './Local.Tools'

/**
 * Onde a ferramenta encontra o serviço de delegação. ⚖️ PREENCHIDO DEPOIS: o serviço precisa do provider
 * de sessões, que precisa dos adapters, que precisam do catálogo de ferramentas — resolver na hora da
 * chamada corta esse círculo da composição.
 */
export class DelegationSlot {
  private service?: DelegationService

  bind(service: DelegationService): void {
    this.service = service
  }

  get(): DelegationService | undefined {
    return this.service
  }
}

/** A ferramenta `delegate_to_agent` de UM agente: o `agentId` só aceita os que ele pode chamar. */
export function makeDelegateTool(allowed: readonly string[], slot: DelegationSlot, permissions?: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: DELEGATE_TOOL_NAME,
    description:
      'Ask another agent to do part of the work and wait for its answer. Opens a linked conversation with it (or continues one with `sessionId`). Use it for what that agent is better at; give it everything it needs in `message`.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', enum: [...allowed], description: 'The agent to ask.' },
        message: { type: 'string', description: 'The full request for that agent — it does not see this conversation.' },
        sessionId: { type: 'string', description: 'Optional: continue a previous delegation (the sessionId it returned).' },
      },
      required: ['agentId', 'message'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const service = slot.get()
      if (!service) return { status: 'error', result: 'delegation is not available in this process' }
      // ⛔ A regra de delegação do projeto e do agente (ver `Permission.Policy`), na hora de delegar.
      const verdict = permissions?.check(askerOf(context), { category: 'delegate', value: String(args.agentId ?? '') }, { log: true })
      if (verdict && !verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      const outcome = await service.delegate(
        {
          allowed,
          agentId: String(args.agentId ?? ''),
          message: String(args.message ?? ''),
          ...(typeof args.sessionId === 'string' && args.sessionId ? { sessionId: args.sessionId } : {}),
        },
        context,
      )
      return outcome.ok
        ? { status: 'success', result: JSON.stringify({ agentId: outcome.agentId, sessionId: outcome.sessionId, reply: outcome.reply }) }
        : { status: 'error', result: outcome.error }
    },
  }
}
