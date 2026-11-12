import { randomBytes } from 'node:crypto'
import { IWakeInput, IWatch, IWatchCheck, IWatchStartInput, TWatchStatus, WATCH_LIMITS, clipWatchOutput, watchMaxActive, watchNotice } from '@domain/models/Watch.Model'
import { IWatchRepository } from '@domain/ports/WatchRepository.Port'

/** O que a vigia precisa saber da conversa em que está armada. */
export interface IWatchConversation {
  agentId: string
  /** A conta dona da conversa. Sem ela não há em nome de quem retomar. */
  ownerId?: string
  /** Conversa de delegação (a do subagente): não arma vigia. */
  delegated: boolean
  archived: boolean
}

/** Onde o aviso foi parar: virou turno, entrou na fila do turno em curso, ou não havia mais a quem entregar. */
export type TWatchDelivery = 'turn' | 'queued' | 'archived' | 'gone' | 'no-owner'
export type TWatchChecker = (watch: IWatch) => Promise<IWatchCheck>
export type TWatchDeliverer = (watch: IWatch, text: string) => Promise<TWatchDelivery>

/** Armar deu nisto: a vigia armada, a recusa (com o porquê), ou "já aconteceu" (nada foi armado). */
export type TWatchArmed = { watch: IWatch } | { refused: string } | { already: string }

export interface IWatchServiceDeps {
  repository: IWatchRepository
  /** A conversa, viva ou só gravada. `undefined` = apagada. */
  conversation(sessionId: string): Promise<IWatchConversation | undefined>
  /** A conta existe e está ativa. */
  ownerActive(userId: string): boolean
  now?: () => Date
  newId?: () => string
  maxActive?: () => number
}

/** Há quanto tempo uma vigia encerrada e entregue some do banco. */
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60_000

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * As VIGIAS de conversa: arma, confere e, quando encerra, ENTREGA o aviso na conversa (que retoma sozinha).
 *
 * ⚖️ A conferência e a entrega são ligadas depois (`useCheck`, `useDelivery`): quem confere é o terminal do agente e quem
 * entrega é o controller das conversas, e os dois nascem depois deste serviço.
 * ⛔ Uma vigia encerrada só sai da fila quando o aviso ENTROU na conversa (ou não há mais a quem entregar): a entrega que
 * falha fica pendente e o relógio tenta de novo. A promessa não se perde num reinício.
 */
export class WatchService {
  private check?: TWatchChecker
  private deliverer?: TWatchDeliverer
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly maxActive: () => number

  constructor(private readonly deps: IWatchServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => `w-${randomBytes(4).toString('hex')}`)
    this.maxActive = deps.maxActive ?? (() => watchMaxActive())
  }

  useCheck(check: TWatchChecker): void {
    this.check = check
  }

  useDelivery(deliverer: TWatchDeliverer): void {
    this.deliverer = deliverer
  }

  /** A vigia por comando. Confere UMA VEZ na hora: o comando recusado volta como recusa, o que já aconteceu não arma nada. */
  async startCommand(sessionId: string, input: IWatchStartInput): Promise<TWatchArmed> {
    const admitted = await this.admit(sessionId)
    if ('refused' in admitted) return admitted
    const createdAt = this.now()
    const draft: IWatch = {
      ...this.blank(sessionId, admitted, createdAt, input.label, input.then),
      kind: 'command',
      command: input.command,
      everySeconds: input.everySeconds,
      deadlineAt: new Date(createdAt.getTime() + input.deadlineMinutes * 60_000),
    }
    const first = await this.run(draft)
    if (first.verdict === 'refused') return { refused: first.output }
    if (first.verdict === 'timeout')
      return { refused: `A conferência passou de ${WATCH_LIMITS.checkTimeoutSeconds} s. O comando da vigia tem de ser rápido: só confere e sai.\n${first.output}` }
    if (first.verdict === 'met') return { already: first.output }
    // A conferência demorou: os tetos são conferidos de novo, com o que foi armado nesse meio-tempo.
    const full = this.full(sessionId)
    if (full) return { refused: full }
    const now = this.now()
    const watch: IWatch = {
      ...draft,
      checks: 1,
      lastOutput: clipWatchOutput(first.output) || undefined,
      nextCheckAt: new Date(Math.min(now.getTime() + input.everySeconds * 1000, draft.deadlineAt.getTime())),
    }
    this.deps.repository.insert(watch)
    return { watch }
  }

  /** O `wake_me`: só o horário. O agente acorda, confere com as ferramentas dele e rearma se precisar. */
  async wake(sessionId: string, input: IWakeInput): Promise<{ watch: IWatch } | { refused: string }> {
    const admitted = await this.admit(sessionId)
    if ('refused' in admitted) return admitted
    const createdAt = this.now()
    const deadlineAt = new Date(createdAt.getTime() + input.afterMinutes * 60_000)
    const watch: IWatch = { ...this.blank(sessionId, admitted, createdAt, input.label, input.then), kind: 'timer', deadlineAt, nextCheckAt: deadlineAt }
    this.deps.repository.insert(watch)
    return { watch }
  }

  /** As da conversa, da mais nova para a mais antiga. */
  list(sessionId: string, limit = 20): IWatch[] {
    return this.deps.repository.listBySession(sessionId, limit)
  }

  /** Cancela uma vigia ativa DESTA conversa. `undefined` = não existe aqui, ou já encerrou. */
  stop(sessionId: string, id: string, reason = 'cancelada'): IWatch | undefined {
    const watch = this.deps.repository.find(id)
    if (!watch || watch.sessionId !== sessionId || watch.status !== 'active') return undefined
    this.close(watch.id, 'cancelled', reason)
    return this.deps.repository.find(id)
  }

  /** A conversa foi apagada: as vigias dela param e nenhum aviso pendente é entregue. */
  cancelSession(sessionId: string): void {
    for (const watch of this.deps.repository.listBySession(sessionId, 200)) {
      if (watch.status === 'active') this.close(watch.id, 'cancelled', 'a conversa foi apagada')
      else if (!watch.delivered) this.deps.repository.update(watch.id, { delivered: true, nextCheckAt: null })
    }
  }

  /** O que venceu: conferência, prazo, ou entrega pendente. */
  due(now: Date = this.now()): IWatch[] {
    return this.deps.repository.listDue(now)
  }

  purge(): void {
    this.deps.repository.purge(new Date(this.now().getTime() - KEEP_ENDED_MS))
  }

  /** Um passo de uma vigia vencida: confere (ou acorda) e, se encerrou, entrega. */
  async process(watch: IWatch): Promise<void> {
    if (watch.status !== 'active') return this.deliver(watch)
    const conversation = await this.deps.conversation(watch.sessionId)
    if (!conversation) return this.close(watch.id, 'cancelled', 'a conversa foi apagada')
    if (conversation.archived) return this.close(watch.id, 'cancelled', 'a conversa foi arquivada')
    if (!this.deps.ownerActive(watch.runAs)) return this.close(watch.id, 'failed', 'a conta dona da conversa foi desativada')

    if (watch.kind === 'timer') {
      if (watch.deadlineAt.getTime() <= this.now().getTime()) await this.end(watch.id, 'met')
      return
    }

    const check = await this.run(watch)
    // Cancelada (ou a conversa apagada) enquanto a conferência rodava: o resultado não vale mais.
    const fresh = this.deps.repository.find(watch.id)
    if (!fresh || fresh.status !== 'active') return
    const now = this.now()
    const checks = fresh.checks + 1
    const lastOutput = clipWatchOutput(check.output) || null
    if (check.verdict === 'met') {
      this.deps.repository.update(fresh.id, { checks, lastOutput, failures: 0 })
      return this.end(fresh.id, 'met')
    }
    const failures = check.verdict === 'unmet' ? 0 : fresh.failures + 1
    this.deps.repository.update(fresh.id, { checks, lastOutput, failures })
    if (failures >= WATCH_LIMITS.maxFailures) return this.end(fresh.id, 'failed', `a conferência não rodou ${WATCH_LIMITS.maxFailures} vezes seguidas`)
    if (now.getTime() >= fresh.deadlineAt.getTime()) return this.end(fresh.id, 'expired')
    // ⚖️ Nunca passa do prazo: a última conferência cai exatamente nele, e só então a vigia expira.
    const next = Math.min(now.getTime() + (fresh.everySeconds ?? WATCH_LIMITS.defaultEverySeconds) * 1000, fresh.deadlineAt.getTime())
    this.deps.repository.update(fresh.id, { nextCheckAt: new Date(next) })
  }

  /** A conferência, que nunca lança: o que quebra conta como conferência que não rodou. */
  private async run(watch: IWatch): Promise<IWatchCheck> {
    if (!this.check) return { verdict: 'refused', output: 'Este gateway não tem como conferir comandos: use wake_me.' }
    try {
      return await this.check(watch)
    } catch (error) {
      return { verdict: 'refused', output: `A conferência falhou: ${message(error)}` }
    }
  }

  private async admit(sessionId: string): Promise<{ conversation: IWatchConversation; ownerId: string } | { refused: string }> {
    const conversation = await this.deps.conversation(sessionId)
    if (!conversation) return { refused: 'A vigia só funciona dentro de uma conversa.' }
    if (conversation.delegated)
      return { refused: 'Conversa de delegação não arma vigia: espere dentro do turno ou devolva à conversa-mãe o que falta. Quem arma vigia é a conversa principal.' }
    if (!conversation.ownerId || !this.deps.ownerActive(conversation.ownerId))
      return { refused: 'Esta conversa não tem uma conta dona em nome de quem retomar: espere dentro do turno e confira antes de responder.' }
    const full = this.full(sessionId)
    return full ? { refused: full } : { conversation, ownerId: conversation.ownerId }
  }

  private full(sessionId: string): string | undefined {
    if (this.deps.repository.countActive(sessionId) >= WATCH_LIMITS.perSession)
      return `Esta conversa já tem ${WATCH_LIMITS.perSession} vigias ativas: cancele uma (watch_stop) ou junte as conferências num comando só.`
    const max = this.maxActive()
    if (this.deps.repository.countActive() >= max) return `O gateway chegou ao teto de ${max} vigias ativas. Espere dentro do turno ou tente mais tarde.`
    return undefined
  }

  private blank(
    sessionId: string,
    admitted: { conversation: IWatchConversation; ownerId: string },
    createdAt: Date,
    label: string,
    then: string,
  ): Omit<IWatch, 'kind' | 'deadlineAt'> {
    let id = this.newId()
    while (this.deps.repository.find(id)) id = this.newId()
    return {
      id,
      sessionId,
      agentId: admitted.conversation.agentId,
      runAs: admitted.ownerId,
      label,
      then,
      status: 'active',
      createdAt,
      checks: 0,
      failures: 0,
      delivered: false,
      deliveryAttempts: 0,
    }
  }

  /** Encerra SEM aviso: não há a quem (ou por que) avisar. */
  private close(id: string, status: TWatchStatus, endReason: string): void {
    this.deps.repository.update(id, { status, endReason, endedAt: this.now(), nextCheckAt: null, delivered: true })
  }

  /** Encerra e entrega o aviso. */
  private async end(id: string, status: TWatchStatus, endReason?: string): Promise<void> {
    this.deps.repository.update(id, { status, endedAt: this.now(), nextCheckAt: null, delivered: false, ...(endReason ? { endReason } : {}) })
    const ended = this.deps.repository.find(id)
    if (ended) await this.deliver(ended)
  }

  private async deliver(watch: IWatch): Promise<void> {
    if (watch.delivered) return
    const now = this.now()
    let outcome: TWatchDelivery
    try {
      if (!this.deliverer) throw new Error('a entrega ainda não está ligada')
      outcome = await this.deliverer(watch, watchNotice(watch, now))
    } catch (error) {
      const deliveryAttempts = watch.deliveryAttempts + 1
      if (deliveryAttempts >= WATCH_LIMITS.maxDeliveryAttempts) {
        this.deps.repository.update(watch.id, { deliveryAttempts, delivered: true, nextCheckAt: null, endReason: `o aviso não entrou na conversa: ${message(error)}` })
        return
      }
      const wait = Math.min(RETRY_BASE_MS * 2 ** watch.deliveryAttempts, RETRY_MAX_MS)
      this.deps.repository.update(watch.id, { deliveryAttempts, nextCheckAt: new Date(now.getTime() + wait) })
      return
    }
    if (outcome === 'no-owner')
      this.deps.repository.update(watch.id, { status: 'failed', delivered: true, nextCheckAt: null, endReason: 'a conta dona da conversa foi desativada' })
    else if (outcome === 'archived' || outcome === 'gone')
      this.deps.repository.update(watch.id, {
        delivered: true,
        nextCheckAt: null,
        endReason: outcome === 'archived' ? 'a conversa foi arquivada: o aviso não foi entregue' : 'a conversa foi apagada',
      })
    else this.deps.repository.update(watch.id, { delivered: true, nextCheckAt: null })
  }
}
