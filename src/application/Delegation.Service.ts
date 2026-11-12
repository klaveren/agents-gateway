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
  /** Continua uma conversa que já existe: uma filha DESTA conversa pai, ou uma da mesma pessoa com o agente (ver `ownIssue`). */
  sessionId?: string
  /**
   * `false` = não espera: a resposta entra depois na conversa que pediu, como mensagem do gateway (o agente segue
   * trabalhando). Ausente = espera a resposta, como sempre.
   */
  wait?: boolean
}

/** Com quem o agente fala: os que ele pode chamar e as conversas abertas com eles (as filhas e as da pessoa). */
export interface ITalkDirectory {
  agents: Array<{ id: string; name?: string }>
  conversations: Array<{ conversation: string; to: string; kind: 'child' | 'person'; title?: string; updatedAt?: string }>
}

/** O estado de uma conversa que o agente alcança: rodando agora, e a última resposta. */
export interface ITalkStatus {
  conversation: string
  to: string
  running: boolean
  reply?: string
}

/** Onde a delegação lê as conversas gravadas (a lista, o estado e de quem é cada uma). Ligado na composição. */
export interface ITalkLookup {
  name(agentId: string): string | undefined
  find(sessionId: string): Promise<IStoredConversation | undefined>
  /** As conversas da pessoa (dono), as mais recentes primeiro. */
  conversations(owner: { id: string; account?: string }): Promise<Array<IStoredConversation & { id: string; title?: string; updatedAt?: Date }>>
  lastReply(sessionId: string): Promise<string | undefined>
}

/** O que a delegação confere de uma conversa (viva ou gravada) antes de continuá-la. */
export interface IStoredConversation {
  agentId: string
  metadata?: Record<string, unknown>
}

/** O cabeçalho da mensagem que um agente põe numa conversa da pessoa: no formato dos avisos do gateway. */
export function relayedMessage(fromAgent: string, fromConversation: string, message: string): string {
  return `[Mensagem do agente ${fromAgent} (conversa ${fromConversation}), em nome da mesma pessoa: não é ela digitando. A sua resposta volta para ele.]\n\n${message}`
}

const ownerOf = (metadata: Record<string, unknown> | undefined) => metadata?.owner as { id?: unknown; account?: unknown } | undefined

/**
 * ⛔ A conversa que NÃO é filha desta só continua se for da MESMA pessoa (dono e conta), do MESMO projeto, com o agente
 * pedido, e não for de delegação (a filha de outra conversa continua só pela mãe dela). Devolve o motivo da recusa.
 */
export function ownIssue(parent: IStoredConversation & { id: string }, target: IStoredConversation, sessionId: string, agentId: string): string | undefined {
  if (target.metadata?.[DELEGATED_BY] !== undefined) return `conversation ${sessionId} is not a delegation of this conversation to ${agentId}`
  if (target.agentId !== agentId) return `conversation ${sessionId} is with ${target.agentId}, not ${agentId}`
  const mine = ownerOf(parent.metadata)
  const theirs = ownerOf(target.metadata)
  if (!mine?.id || mine.id !== theirs?.id || (mine.account ?? undefined) !== (theirs?.account ?? undefined))
    return `conversation ${sessionId} belongs to another person; continue only a delegation of this conversation or a conversation of the same person`
  if (parent.metadata?.[PROJECT_METADATA_KEY] !== target.metadata?.[PROJECT_METADATA_KEY])
    return `conversation ${sessionId} is in another project (${String(target.metadata?.[PROJECT_METADATA_KEY] ?? 'none')}); continue only one in this conversation's project`
  return undefined
}

export type TDelegationResult = { ok: true; agentId: string; sessionId: string; reply: string; pending?: boolean } | { ok: false; error: string }

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
 *
 * ⚖️ A CONVERSA DA PESSOA: com o `sessionId`, o agente também continua uma conversa que a PRÓPRIA pessoa abriu com o
 * agente de destino ("fale com o Integra naquela conversa"), com as mesmas travas e mais as do `ownIssue`. A mensagem
 * entra com um cabeçalho dizendo de qual agente vem: quem lê a conversa sabe que não foi a pessoa que digitou.
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
    /**
     * ⚖️ Ao fim do turno da filha, a sessão viva dela sai: ninguém mais a encerra, e ela ocupava a vaga de conversa viva
     * da conta por horas. A conversa fica gravada; continuar (com o `sessionId`) a retoma pelo histórico.
     */
    private readonly release?: (sessionId: string) => void,
    /**
     * ⚖️ Retoma a conversa da pessoa (não filha) que não está viva, se `accept` aceitar a gravada: devolve o motivo da
     * recusa, ou nada quando ela voltou. O admin vem de `via` (a conversa que chama). Ausente = sem retomada.
     */
    private readonly resumeOwn?: (sessionId: string, accept: (stored: IStoredConversation) => string | undefined, via: string) => Promise<string | undefined>,
  ) {}

  /** Quem entrega a resposta que chegou depois do turno da mãe (um turno novo nela; ligado na composição). */
  private late?: (parentSessionId: string, text: string) => void

  useLateDelivery(deliver: (parentSessionId: string, text: string) => void): void {
    this.late = deliver
  }

  private lookup?: ITalkLookup

  useLookup(lookup: ITalkLookup): void {
    this.lookup = lookup
  }

  /** A conversa que chama, viva. */
  private parentOf(context: IExecutionContext | undefined) {
    if (!context?.sessionId) return undefined
    try {
      return this.provider.describe(context.sessionId)
    } catch {
      return undefined
    }
  }

  /** A conversa (viva ou gravada) com o agente dela e a metadata. */
  private async conversationOf(sessionId: string): Promise<IStoredConversation | undefined> {
    try {
      return this.provider.describe(sessionId)
    } catch {
      return this.lookup?.find(sessionId)
    }
  }

  /** O agente de uma conversa que o agente que chama alcança (filha dele, ou da mesma pessoa e projeto). */
  async agentOf(sessionId: string): Promise<string | undefined> {
    return (await this.conversationOf(sessionId))?.agentId
  }

  /**
   * ⚖️ COM QUEM O AGENTE FALA: os agentes que ele pode chamar e as conversas abertas com eles — as filhas desta conversa e
   * as da mesma pessoa, no mesmo projeto, que não são de delegação. É o `talk` sem nada: nenhum id precisa ser adivinhado.
   */
  async directory(allowed: readonly string[], context: IExecutionContext | undefined): Promise<ITalkDirectory> {
    const parent = this.parentOf(context)
    const agents = allowed.map((id) => ({ id, ...(this.lookup?.name(id) ? { name: this.lookup.name(id)! } : {}) }))
    const owner = ownerOf(parent?.metadata)
    if (!parent || typeof owner?.id !== 'string' || !this.lookup) return { agents, conversations: [] }
    const project = parent.metadata?.[PROJECT_METADATA_KEY]
    const found = (await this.lookup.conversations({ id: owner.id, ...(typeof owner.account === 'string' ? { account: owner.account } : {}) }))
      .filter((item) => item.id !== parent.id && allowed.includes(item.agentId))
      .flatMap((item): Array<{ item: typeof item; kind: 'child' | 'person' }> => {
        const by = item.metadata?.[DELEGATED_BY]
        if (by === parent.id) return [{ item, kind: 'child' }]
        if (by === undefined && item.metadata?.[PROJECT_METADATA_KEY] === project) return [{ item, kind: 'person' }]
        return []
      })
      .slice(0, 15)
    return {
      agents,
      conversations: found.map(({ item, kind }) => ({
        conversation: item.id,
        to: item.agentId,
        kind,
        ...(item.title ? { title: item.title } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt.toISOString() } : {}),
      })),
    }
  }

  /** ⛔ O estado de uma conversa: só a que o agente alcançaria para falar (a filha dele, ou da mesma pessoa e projeto). */
  async status(allowed: readonly string[], sessionId: string, context: IExecutionContext | undefined): Promise<{ ok: true; status: ITalkStatus } | { ok: false; error: string }> {
    const parent = this.parentOf(context)
    if (!parent) return { ok: false, error: 'talk needs the calling conversation; none in this call' }
    const target = await this.conversationOf(sessionId)
    if (!target) return { ok: false, error: `conversation ${sessionId} was deleted or does not exist` }
    if (!allowed.includes(target.agentId)) return { ok: false, error: `not allowed to talk to ${target.agentId}; allowed: ${allowed.join(', ') || 'none'}` }
    const child = target.metadata?.[DELEGATED_BY] === parent.id
    const issue = child ? undefined : ownIssue(parent, target, sessionId, target.agentId)
    if (issue) return { ok: false, error: issue }
    let running: boolean
    try {
      running = this.provider.describe(sessionId).status === 'running'
    } catch {
      running = false
    }
    const reply = await this.lookup?.lastReply(sessionId)
    return { ok: true, status: { conversation: sessionId, to: target.agentId, running, ...(reply ? { reply } : {}) } }
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
    const wanted = sessionId ?? ''
    /** A conversa é da pessoa (não filha desta): a mensagem leva o cabeçalho; `resumed` = voltou aqui e sai ao fim. */
    let own: { resumed: boolean } | undefined
    if (sessionId) {
      let child: (IStoredConversation & { status: string }) | undefined
      try {
        child = this.provider.describe(sessionId)
      } catch {
        child = undefined
      }
      if (child && (child.metadata?.[DELEGATED_BY] !== parent.id || child.agentId !== request.agentId)) {
        const issue = ownIssue(parent, child, sessionId, request.agentId)
        if (issue) return { ok: false, error: issue }
        if (child.status === 'running') return { ok: false, error: `conversation ${sessionId} is running a turn now; wait for it to finish, or tell the person` }
        own = { resumed: false }
      }
      if (!child) {
        // ⚖️ Encerrada não é perdida: a filha gravada volta pelo histórico, desde que seja DESTA mãe e deste agente.
        try {
          const stored = await this.resumeChild?.(sessionId, parent.id)
          if (!stored) return { ok: false, error: `conversation ${sessionId} was deleted or does not exist; start a new one (omit sessionId)` }
          if (stored.delegatedBy === undefined && this.resumeOwn) {
            const refused = await this.resumeOwn(sessionId, (found) => ownIssue(parent, found, wanted, request.agentId), parent.id)
            if (refused) return { ok: false, error: refused }
            own = { resumed: true }
          } else if (stored.delegatedBy !== parent.id || stored.agentId !== request.agentId)
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

    // O turno da mãe que fez a chamada: parada, ou noutro turno, na volta = a chamada caiu e a mãe já seguiu.
    const turnAtCall = parent.turns
    const target = sessionId
    const exchange = this.exchange(parent, request, target, own)
    if (request.wait === false) {
      // ⚖️ SEM ESPERAR: a resposta entra depois na conversa que pediu (no turno que ainda roda, ou num novo), como mensagem.
      void exchange
        .then((outcome) => this.deliver(parent.id, request.agentId, target, outcome, true))
        .catch((error: unknown) =>
          console.warn(`[delegação] a resposta de ${request.agentId} (${target}) não foi entregue: ${error instanceof Error ? error.message : String(error)}`),
        )
      return { ok: true, agentId: request.agentId, sessionId: target, reply: '', pending: true }
    }
    const outcome = await exchange
    this.deliverIfLost(parent.id, turnAtCall, request.agentId, target, outcome)
    return outcome.ok ? { ok: true, agentId: request.agentId, sessionId: target, reply: outcome.reply } : { ok: false, error: `${request.agentId} failed: ${outcome.error}` }
  }

  /** O turno na conversa de destino, até o fim: a resposta (ou a falha). A conversa que voltou aqui sai da memória depois. */
  private async exchange(
    parent: { id: string; agentId: string },
    request: IDelegationRequest,
    sessionId: string,
    own: { resumed: boolean } | undefined,
  ): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
    let reply = ''
    let failure: string | undefined
    const startedAt = Date.now()
    console.log(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}${own ? ', conversa da pessoa' : ''}): turno começou`)
    const text = own ? relayedMessage(parent.agentId, parent.id, request.message) : request.message
    try {
      for await (const event of this.sendMessage.execute(sessionId, { text })) {
        const payload = (event.payload ?? {}) as Record<string, unknown>
        if (event.type === 'text.delta') reply += String(payload.text ?? '')
        if (event.type === 'error') failure = String(payload.message ?? 'error')
        if (event.type === 'message.aborted') failure ??= 'the turn was interrupted'
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const took = `${Math.round((Date.now() - startedAt) / 1000)} s`
    // A conversa da pessoa que já estava viva fica como estava (ela pode estar na tela); a que voltou aqui sai, como a filha.
    if (!own || own.resumed) this.release?.(sessionId)
    if (failure && !reply) {
      console.warn(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}): falhou em ${took}: ${failure}`)
      return { ok: false, error: failure }
    }
    console.log(`[delegação] ${parent.agentId} → ${request.agentId} (${sessionId}): respondeu em ${took}`)
    return { ok: true, reply }
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
    this.deliver(parentId, agentId, childId, outcome, false)
  }

  /** A resposta que chega como MENSAGEM na conversa que pediu: no turno que ela roda agora (a fila), ou num turno novo. */
  private deliver(parentId: string, agentId: string, childId: string, outcome: { ok: true; reply: string } | { ok: false; error: string }, asked: boolean): void {
    let status: string
    try {
      ;({ status } = this.provider.describe(parentId))
    } catch {
      status = 'idle'
    }
    const when = asked ? 'que você pediu sem esperar' : 'que chegou depois do fim do seu turno'
    const text = outcome.ok
      ? `[Resposta de ${agentId} (conversation ${childId}), ${when}: leia e continue de onde parou.]\n\n${outcome.reply || '(sem texto)'}`
      : `[A conversa com ${agentId} (conversation ${childId}) falhou, ${when}: ${outcome.error}. Decida: tentar de novo (talk com a conversation, para continuar a mesma), outro caminho, ou avisar a pessoa.]`
    console.log(`[delegação] a resposta de ${agentId} (${childId}) entra como mensagem em ${parentId}`)
    if (status === 'running' && this.provider.enqueue?.(parentId, text) !== undefined) return
    this.late?.(parentId, text)
  }
}
