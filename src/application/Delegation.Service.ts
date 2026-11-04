import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { DELEGATED_BY, DELEGATED_FROM, DELEGATION_CHAIN, DELEGATION_DEPTH, delegationMaxDepth } from '@domain/models/Delegation.Model'
import { EMode } from '@domain/enums/EMode.Enum'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { SendMessageUseCase } from './SendMessage.Usecase'

export interface IDelegationRequest {
  /** Os agentes que o agente pai pode chamar (os `agent:<id>` dele). */
  allowed: readonly string[]
  agentId: string
  message: string
  /** Continua uma conversa filha que já existe — desde que seja DESTA conversa pai. */
  sessionId?: string
}

export type TDelegationResult = { ok: true; agentId: string; sessionId: string; reply: string } | { ok: false; error: string }

/**
 * Um agente pedindo a outro: abre (ou continua) uma conversa FILHA, manda a mensagem e devolve a resposta.
 *
 * ⛔ AS TRAVAS, todas aqui e antes de gastar um token:
 * - só para os agentes que o pai escolheu (`agent:<id>`);
 * - profundidade até `DELEGATION_MAX_DEPTH` (padrão 2);
 * - nada de ciclo: quem já está na cadeia desde a raiz não é chamado de novo.
 *
 * ⚖️ A FILHA É DA MESMA PESSOA (o mesmo `owner`) e roda com a credencial dela — o escopo do chamador já
 * está ativo no turno pai. Os turnos são gravados pelo `SendMessageUseCase`, como qualquer conversa.
 */
export class DelegationService {
  constructor(
    private readonly provider: IAgentProvider,
    private readonly createSession: CreateSessionUseCase,
    private readonly sendMessage: SendMessageUseCase,
    private readonly maxDepth: () => number = () => delegationMaxDepth(),
    /** As lanes do agente de destino: a filha nasce na `agent` quando ele tem, senão na `chat` com as ferramentas ligadas. */
    private readonly modesOf: (agentId: string) => readonly EMode[] | undefined = () => undefined,
    /**
     * ⚖️ Retoma a filha que não está mais viva (o gateway reiniciou, a sessão expirou): qualquer conversa volta, a menos
     * que tenha sido apagada. Devolve a conversa gravada (para conferir de quem é) ou nada. Ausente = sem retomada.
     */
    private readonly resumeChild?: (sessionId: string, parentId: string) => Promise<{ agentId: string; delegatedBy?: unknown } | undefined>,
  ) {}

  /** Quem entrega a resposta que chegou depois do turno da mãe (um turno novo nela; ligado na composição). */
  private late?: (parentSessionId: string, text: string) => void

  useLateDelivery(deliver: (parentSessionId: string, text: string) => void): void {
    this.late = deliver
  }

  async delegate(request: IDelegationRequest, context: IExecutionContext | undefined): Promise<TDelegationResult> {
    if (!context?.sessionId) return { ok: false, error: 'delegation needs the calling conversation; none in this call' }
    let parent
    try {
      parent = this.provider.describe(context.sessionId)
    } catch {
      return { ok: false, error: 'the calling conversation is no longer live' }
    }

    const metadata = parent.metadata ?? {}
    const depth = (typeof metadata[DELEGATION_DEPTH] === 'number' ? (metadata[DELEGATION_DEPTH] as number) : 0) + 1
    const chain = Array.isArray(metadata[DELEGATION_CHAIN]) ? (metadata[DELEGATION_CHAIN] as string[]) : [parent.agentId]

    if (!request.allowed.includes(request.agentId)) return { ok: false, error: `not allowed to delegate to ${request.agentId}; allowed: ${request.allowed.join(', ') || 'none'}` }
    if (request.agentId === parent.agentId || chain.includes(request.agentId))
      return { ok: false, error: `${request.agentId} is already in this delegation chain (${chain.join(' → ')}); no cycles` }
    if (depth > this.maxDepth()) return { ok: false, error: `delegation depth limit reached (${this.maxDepth()}); answer with what you have` }

    let sessionId = request.sessionId
    if (sessionId) {
      let child: { agentId: string; metadata?: Record<string, unknown> } | undefined
      try {
        child = this.provider.describe(sessionId)
      } catch {
        child = undefined
      }
      if (child && (child.metadata?.[DELEGATED_BY] !== parent.id || child.agentId !== request.agentId))
        return { ok: false, error: `conversation ${sessionId} is not a delegation of this conversation to ${request.agentId}` }
      if (!child) {
        // ⚖️ Encerrada não é perdida: a filha gravada volta pelo histórico, desde que seja DESTA mãe e deste agente.
        try {
          const stored = await this.resumeChild?.(sessionId, parent.id)
          if (!stored) return { ok: false, error: `conversation ${sessionId} was deleted or does not exist; start a new one (omit sessionId)` }
          if (stored.delegatedBy !== parent.id || stored.agentId !== request.agentId)
            return { ok: false, error: `conversation ${sessionId} is not a delegation of this conversation to ${request.agentId}` }
        } catch (error: unknown) {
          return { ok: false, error: `could not resume ${sessionId}: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
    } else {
      try {
        const modes = this.modesOf(request.agentId) ?? []
        const mode = modes.includes(EMode.AGENT) ? EMode.AGENT : EMode.CHAT
        const created = await this.createSession.execute({
          agentId: request.agentId,
          mode,
          delegated: true,
          parentSessionId: parent.id,
          ...(mode === EMode.CHAT ? { tools: true } : {}),
          metadata: {
            ...(metadata.owner ? { owner: metadata.owner } : {}),
            // O projeto da conversa-mãe: o filho global (o construtor) trabalha nele — é onde o que ele grava nasce.
            ...(typeof metadata[PROJECT_METADATA_KEY] === 'string' ? { [PROJECT_METADATA_KEY]: metadata[PROJECT_METADATA_KEY] } : {}),
            [DELEGATED_BY]: parent.id,
            [DELEGATED_FROM]: parent.agentId,
            [DELEGATION_DEPTH]: depth,
            [DELEGATION_CHAIN]: [...chain, request.agentId],
          },
        })
        sessionId = created.id
      } catch (error: unknown) {
        return { ok: false, error: `could not open a conversation with ${request.agentId}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    let reply = ''
    let failure: string | undefined
    // O turno da mãe que fez a chamada: parada, ou noutro turno, na volta = a chamada caiu e a mãe já seguiu.
    const turnAtCall = parent.turns
    const startedAt = Date.now()
    console.log(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}): turno começou`)
    try {
      for await (const event of this.sendMessage.execute(sessionId, { text: request.message })) {
        const payload = (event.payload ?? {}) as Record<string, unknown>
        if (event.type === 'text.delta') reply += String(payload.text ?? '')
        if (event.type === 'error') failure = String(payload.message ?? 'error')
        if (event.type === 'message.aborted') failure ??= 'the turn was interrupted'
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const took = `${Math.round((Date.now() - startedAt) / 1000)} s`
    if (failure && !reply) {
      console.warn(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}): falhou em ${took}: ${failure}`)
      this.deliverIfLost(parent.id, turnAtCall, request.agentId, sessionId, { ok: false, error: failure })
      return { ok: false, error: `${request.agentId} failed: ${failure}` }
    }
    console.log(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}): respondeu em ${took}`)
    this.deliverIfLost(parent.id, turnAtCall, request.agentId, sessionId, { ok: true, reply })
    return { ok: true, agentId: request.agentId, sessionId, reply }
  }

  /**
   * ⚖️ A RESPOSTA NÃO SE PERDE: se o turno da mãe já acabou quando a filha respondeu (a chamada da ferramenta caiu antes),
   * a resposta entra num turno NOVO da mãe — ela lê e continua, como numa conversa. Com a mãe rodando outro turno, entra
   * nele (a fila do turno). Antes, o agente-mãe só ficava sabendo pela tela.
   */
  private deliverIfLost(parentId: string, turnAtCall: number, agentId: string, childId: string, outcome: { ok: true; reply: string } | { ok: false; error: string }): void {
    let status: string
    let turns: number
    try {
      ;({ status, turns } = this.provider.describe(parentId))
    } catch {
      return
    }
    // A mãe ainda está no turno que delegou: a resposta chega pela ferramenta, como sempre.
    if (status === 'running' && turns === turnAtCall) return
    const text = outcome.ok
      ? `[Resposta de ${agentId} à sua delegação (sessionId ${childId}), que chegou depois do fim do seu turno: leia e continue de onde parou.]\n\n${outcome.reply || '(sem texto)'}`
      : `[A delegação a ${agentId} (sessionId ${childId}) falhou depois do fim do seu turno: ${outcome.error}. Decida: tentar de novo (com o sessionId, para continuar a mesma conversa), outro caminho, ou avisar a pessoa.]`
    console.log(`[delegação] a resposta de ${agentId} (${childId}) chegou depois do turno da mãe ${parentId}: entra como mensagem`)
    if (status === 'running' && this.provider.enqueue?.(parentId, text) !== undefined) return
    this.late?.(parentId, text)
  }
}
