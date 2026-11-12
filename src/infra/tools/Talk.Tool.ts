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

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/**
 * ⚖️ O `talk` de UM agente: a ÚNICA ferramenta para falar com outro agente (o lugar do antigo `delegate_to_agent`). O
 * `to` só aceita os que ele pode chamar (`agent:<id>`). Os casos saem dos campos:
 * - nada → com quem ele fala e as conversas abertas com cada um;
 * - `conversation` sem `message` → o estado dela (rodando? a última resposta);
 * - `message` → fala: numa conversa nova (`to`), na filha dele ou na da mesma pessoa com o outro agente (`conversation`);
 *   `wait: 0` não espera — a resposta entra depois nesta conversa, como mensagem do gateway.
 * ⛔ As travas são as da delegação (`Delegation.Service`) e a regra `delegate` do projeto e do agente, aqui.
 */
export function makeTalkTool(allowed: readonly string[], slot: DelegationSlot, permissions?: IPermissionChecker): ILocalTool {
  return {
    origin: 'local',
    name: DELEGATE_TOOL_NAME,
    description:
      "Talk to another agent — the ONLY way to (agents do not get start_conversation, send_message nor delegate_to_agent). No arguments: who you can talk to and the conversations already open with each (yours, and the ones the same person has with them in this project). `to` + `message`: a new conversation with that agent. `conversation` + `message`: continue that conversation (one you opened, or the person's own conversation with that agent — e.g. an id the person gave you). `conversation` alone: is it running, and its last reply. `wait: 0`: do not wait — the reply comes later into this conversation as a gateway message. Give the other agent everything it needs in `message`: it does not see this conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: [...allowed], description: 'The agent to talk to (needed for a new conversation).' },
        message: { type: 'string', description: 'The full request — the other agent does not see this conversation.' },
        conversation: { type: 'string', description: 'A conversation to continue (or to check, without message): its id, e.g. gw_….' },
        wait: { type: 'number', description: 'Absent: wait for the reply. 0: do not wait; the reply arrives later in this conversation.' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, context) {
      const service = slot.get()
      if (!service) return { status: 'error', result: 'talk is not available in this process' }
      const to = str(args.to)
      const message = str(args.message)
      const conversation = str(args.conversation)
      if (!message && !conversation) {
        const directory = await service.directory(to ? allowed.filter((id) => id === to) : allowed, context)
        return { status: 'success', result: JSON.stringify(directory) }
      }
      if (!message) {
        const outcome = await service.status(allowed, conversation!, context)
        return outcome.ok ? { status: 'success', result: JSON.stringify(outcome.status) } : { status: 'error', result: outcome.error }
      }
      const agentId = to ?? (conversation ? await service.agentOf(conversation) : undefined)
      if (!agentId)
        return {
          status: 'error',
          result: conversation ? `conversation ${conversation} was deleted or does not exist` : 'say who to talk to (`to`), or the conversation to continue',
        }
      // ⛔ A regra de delegação do projeto e do agente (ver `Permission.Policy`), na hora de falar.
      const verdict = permissions?.check(askerOf(context), { category: 'delegate', value: agentId }, { log: true })
      if (verdict && !verdict.allowed) return { status: 'error', result: `Not permitted: ${verdict.reason}` }
      const outcome = await service.delegate(
        { allowed, agentId, message, ...(conversation ? { sessionId: conversation } : {}), ...(args.wait === 0 || args.wait === '0' ? { wait: false } : {}) },
        context,
      )
      if (!outcome.ok) return { status: 'error', result: outcome.error }
      return {
        status: 'success',
        result: JSON.stringify(
          outcome.pending
            ? { to: outcome.agentId, conversation: outcome.sessionId, status: 'pending', note: 'the reply will come into this conversation as a gateway message' }
            : { to: outcome.agentId, conversation: outcome.sessionId, reply: outcome.reply },
        ),
      }
    },
  }
}
