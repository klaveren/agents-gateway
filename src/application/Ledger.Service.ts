import { InvalidLedgerError, LedgerNotFoundError } from '@domain/errors/Domain.Error'
import {
  foldText,
  ledgerExportFiles,
  ledgerPromptSection,
  ledgerWarnings,
  lineIssues,
  lineTypeOf,
  playbookIssues,
  similarTopics,
  topicIssues,
  topicSlug,
  triggerIssues,
} from '@domain/Ledger.Policy'
import { ILedgerContext, ILedgerLine, ILedgerRevision, ILedgerWarning, ILedgerWrite, LEDGER_LIMITS, TLedgerAuthor, TLedgerLineSnapshot } from '@domain/models/Ledger.Model'
import { ILedgerRepository } from '@domain/ports/LedgerRepository.Port'

/** O que o ledger precisa saber de um agente: se existe, de que projeto é e se é só de admin. */
export interface ILedgerAgentInfo {
  id: string
  projectId?: string
  adminOnly?: boolean
}

export interface ILedgerAgents {
  /** `undefined` = o agente não existe (o do catálogo ou o de fábrica). */
  get(agentId: string): ILedgerAgentInfo | undefined
}

/** Quem lê pela ferramenta: o agente da conversa e o projeto DELA (vêm do servidor, nunca de argumento). */
export interface ILedgerReader {
  agentId: string
  conversationProjectId?: string
}

export type TLedgerLineView = Pick<ILedgerLine, 'id' | 'date' | 'type' | 'trigger' | 'learning' | 'ref' | 'createdAt' | 'createdBy' | 'updatedAt' | 'updatedBy'>

/** Um contexto na lista: sem o conteúdo (linhas, playbook), com a contagem e os avisos dele. */
export interface ILedgerContextSummary {
  topic: string
  trigger: string
  lineCount: number
  hasPlaybook: boolean
  createdAt: Date
  createdBy: TLedgerAuthor
  updatedAt: Date
  updatedBy: TLedgerAuthor
  warnings: ILedgerWarning[]
}

export interface ILedgerContextDetail extends ILedgerContextSummary {
  playbook: string
  lines: TLedgerLineView[]
}

export interface ILedgerIndex {
  agentId: string
  contexts: ILedgerContextSummary[]
  lineCount: number
  /** Todos os avisos (os dos contextos e os do ledger inteiro). */
  warnings: ILedgerWarning[]
}

export interface ILedgerSearchResult {
  agentId: string
  query: string
  contexts: ILedgerContextSummary[]
  lines: Array<TLedgerLineView & { topic: string }>
}

export interface ILedgerWriteResult {
  action: ILedgerWrite['action']
  topic: string
  /** Ausente depois de `excluir`. */
  context?: ILedgerContextDetail
  /** O índice depois da mudança: a tela troca a lista sem reler. */
  index: ILedgerIndex
  /** Os avisos que interessam a quem acabou de escrever: os do tema e os do ledger inteiro. */
  warnings: ILedgerWarning[]
  /** `false`: o pedido não mudou nada (o mesmo gatilho, o mesmo texto) — nenhuma revisão. */
  changed: boolean
}

const today = (now: Date) => now.toISOString().slice(0, 10)
const lineView = (line: ILedgerLine): TLedgerLineView => ({
  id: line.id,
  date: line.date,
  type: line.type,
  trigger: line.trigger,
  learning: line.learning,
  ref: line.ref,
  createdAt: line.createdAt,
  createdBy: line.createdBy,
  updatedAt: line.updatedAt,
  updatedBy: line.updatedBy,
})
const lineSnapshot = (line: Pick<ILedgerLine, 'id' | 'date' | 'type' | 'trigger' | 'learning' | 'ref'>): TLedgerLineSnapshot => ({
  id: line.id,
  date: line.date,
  type: line.type,
  trigger: line.trigger,
  learning: line.learning,
  ref: line.ref,
})

/**
 * O LEDGER DOS AGENTES (ver `Ledger.Model`): ler, escrever com validação, revisões, saúde, a seção do prompt e o export.
 *
 * ⛔ DONO = quem chama: a escrita vem sempre com o `agentId` resolvido por quem chamou o serviço (o servidor, a partir do
 * turno; a tela, a partir da rota de admin) — este serviço não tem caminho para "escrever no ledger de outro agente"
 * vindo de argumento de ferramenta. Ler o de outro é `canRead` (a visibilidade de agentes por projeto).
 */
export class LedgerService {
  constructor(
    private readonly repository: ILedgerRepository,
    private readonly agents: ILedgerAgents,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** ⛔ O agente tem de existir: ledger de agente inexistente não se lê nem se escreve (o apagado fica guardado, não exposto). */
  requireAgent(agentId: string): ILedgerAgentInfo {
    const agent = this.agents.get(agentId)
    if (!agent) throw new LedgerNotFoundError('agent', agentId)
    return agent
  }

  /**
   * ⛔ VISIBILIDADE para ler o ledger de OUTRO agente — a mesma dos agentes: o global, e os do projeto da conversa (ou do
   * projeto do próprio leitor). O de agente só-admin, só um agente só-admin lê (a conversa dele é sempre de admin; a de
   * outro pode não ser). Fora disso, responde como inexistente.
   */
  canRead(reader: ILedgerReader, targetId: string): boolean {
    if (reader.agentId === targetId) return true
    const target = this.agents.get(targetId)
    const own = this.agents.get(reader.agentId)
    if (!target || !own) return false
    if (target.adminOnly && !own.adminOnly) return false
    if (!target.projectId) return true
    return target.projectId === reader.conversationProjectId || target.projectId === own.projectId
  }

  index(agentId: string): ILedgerIndex {
    const contexts = this.repository.contexts(agentId)
    const lines = this.repository.agentLines(agentId)
    const warnings = ledgerWarnings({ contexts, lines })
    const counts = new Map<string, number>()
    for (const line of lines) counts.set(line.topic, (counts.get(line.topic) ?? 0) + 1)
    return {
      agentId,
      contexts: contexts.map((context) => this.summary(context, counts.get(context.topic) ?? 0, warnings)),
      lineCount: lines.length,
      warnings,
    }
  }

  context(agentId: string, rawTopic: string): ILedgerContextDetail {
    const context = this.requireContext(agentId, topicSlug(rawTopic))
    return this.detail(context, this.index(agentId).warnings)
  }

  /** As linhas e os contextos que casam com TODAS as palavras da busca (sem acento, sem caixa). */
  search(agentId: string, query: string): ILedgerSearchResult {
    const words = foldText(query).split(/\s+/).filter(Boolean)
    const matches = (text: string) => words.length > 0 && words.every((word) => foldText(text).includes(word))
    const index = this.index(agentId)
    const lines = this.repository
      .agentLines(agentId)
      .filter((line) => matches([line.topic, line.type, line.trigger, line.learning, line.ref].join(' ')))
      .map((line) => ({ ...lineView(line), topic: line.topic }))
    const playbooks = new Set(
      this.repository
        .contexts(agentId)
        .filter((context) => matches(context.playbook))
        .map((context) => context.topic),
    )
    return {
      agentId,
      query,
      contexts: index.contexts.filter((context) => matches(`${context.topic} ${context.trigger}`) || playbooks.has(context.topic)),
      lines,
    }
  }

  revisions(agentId: string, rawTopic: string): ILedgerRevision[] {
    return this.repository.revisions(agentId, topicSlug(rawTopic))
  }

  /** A seção do system prompt do agente (só o índice e a regra; com teto). `undefined` sem nenhum contexto. */
  promptSection(agentId: string): string | undefined {
    return ledgerPromptSection(this.repository.contexts(agentId))
  }

  /** O ledger no formato das pastas antigas (`<agente>-ledger/index.md` + `contextos/<tema>.md`): caminho → conteúdo. */
  exportFiles(agentId: string): Record<string, string> {
    return ledgerExportFiles(
      agentId,
      this.repository.contexts(agentId).map((context) => ({ context, lines: this.repository.lines(context.id) })),
    )
  }

  /**
   * UMA escrita no ledger do agente `agentId`, com a revisão dela (quem, quando, antes e depois), tudo ou nada.
   * ⛔ `agentId` é o DONO, resolvido por quem chama (o turno ou a rota de admin) — nunca um argumento da ferramenta.
   */
  write(agentId: string, change: ILedgerWrite, by: TLedgerAuthor): ILedgerWriteResult {
    this.requireAgent(agentId)
    const topic = topicSlug(change.topic ?? '')
    const issues = topicIssues(topic)
    if (issues.length) throw new InvalidLedgerError(issues)
    const at = this.now()
    const changed = this.repository.transaction(() => this.apply(agentId, topic, change, by, at))
    const index = this.index(agentId)
    const context = change.action === 'excluir' ? undefined : this.repository.context(agentId, topic)
    return {
      action: change.action,
      topic,
      ...(context ? { context: this.detail(context, index.warnings) } : {}),
      index,
      warnings: index.warnings.filter((warning) => !warning.topic || warning.topic === topic || warning.related === topic),
      changed,
    }
  }

  private apply(agentId: string, topic: string, change: ILedgerWrite, by: TLedgerAuthor, at: Date): boolean {
    const revision = (fields: Pick<ILedgerRevision, 'action'> & Partial<Pick<ILedgerRevision, 'lineId' | 'before' | 'after'>>) =>
      this.repository.addRevision({ agentId, topic, at, by, ...fields })

    if (change.action === 'criar') {
      if (this.repository.context(agentId, topic))
        throw new InvalidLedgerError([{ field: 'topic', message: `already exists: ${topic} — change it (gatilho, playbook, linha_nova) instead of creating another` }])
      const problems = [...triggerIssues(change.trigger), ...playbookIssues(change.playbook)]
      if (this.repository.contexts(agentId).length >= LEDGER_LIMITS.maxContexts)
        problems.push({ field: 'topic', message: `at most ${LEDGER_LIMITS.maxContexts} contexts: merge or delete some first` })
      if (problems.length) throw new InvalidLedgerError(problems)
      const trigger = change.trigger!.trim()
      const playbook = (change.playbook ?? '').trim()
      this.repository.createContext({ agentId, topic, trigger, playbook, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by })
      revision({ action: 'criar', after: { trigger, playbook } })
      return true
    }

    const context = this.requireContext(agentId, topic)
    if (change.action === 'gatilho') {
      const problems = triggerIssues(change.trigger)
      if (problems.length) throw new InvalidLedgerError(problems)
      const trigger = change.trigger!.trim()
      if (trigger === context.trigger) return false
      this.repository.updateContext(context.id, { trigger, updatedAt: at, updatedBy: by })
      revision({ action: 'gatilho', before: { trigger: context.trigger, playbook: context.playbook }, after: { trigger, playbook: context.playbook } })
      return true
    }
    if (change.action === 'playbook') {
      const problems = playbookIssues(change.playbook)
      if (problems.length) throw new InvalidLedgerError(problems)
      const playbook = (change.playbook ?? '').trim()
      if (playbook === context.playbook) return false
      this.repository.updateContext(context.id, { playbook, updatedAt: at, updatedBy: by })
      revision({ action: 'playbook', before: { trigger: context.trigger, playbook: context.playbook }, after: { trigger: context.trigger, playbook } })
      return true
    }
    if (change.action === 'excluir') {
      const lines = this.repository.lines(context.id).map((line) => lineSnapshot(line))
      this.repository.deleteContext(context.id)
      revision({ action: 'excluir', before: { trigger: context.trigger, playbook: context.playbook, lines } })
      return true
    }
    if (change.action === 'linha_nova') {
      const line = this.normalizedLine(change.line ?? {})
      const problems = lineIssues(line)
      if (this.repository.agentLines(agentId).length >= LEDGER_LIMITS.maxLines)
        problems.push({ field: 'line', message: `at most ${LEDGER_LIMITS.maxLines} lines: prune the ledger first` })
      if (problems.length) throw new InvalidLedgerError(problems)
      const created = this.repository.addLine({
        contextId: context.id,
        date: line.date ?? today(at),
        type: line.type!,
        trigger: line.trigger!,
        learning: line.learning!,
        ref: line.ref ?? '',
        createdAt: at,
        createdBy: by,
        updatedAt: at,
        updatedBy: by,
      })
      this.touch(context, at, by)
      revision({ action: 'linha_nova', lineId: created.id, after: lineSnapshot(created) })
      return true
    }

    // linha_editar / linha_apagar: a linha tem de ser DESTE contexto (do ledger de quem escreve).
    const current = this.repository.lines(context.id).find((line) => line.id === change.lineId)
    if (!current) throw new LedgerNotFoundError('line', `${topic} #${change.lineId ?? '?'}`)
    if (change.action === 'linha_apagar') {
      this.repository.deleteLine(current.id)
      this.touch(context, at, by)
      revision({ action: 'linha_apagar', lineId: current.id, before: lineSnapshot(current) })
      return true
    }
    const patch = this.normalizedLine(change.line ?? {})
    const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as typeof patch
    if (!Object.keys(fields).length) throw new InvalidLedgerError([{ field: 'line', message: 'nothing to change: send type, lineTrigger, learning, ref or date' }])
    const problems = lineIssues(fields, true)
    if (problems.length) throw new InvalidLedgerError(problems)
    const next = { ...current, ...fields }
    if (JSON.stringify(lineSnapshot(next)) === JSON.stringify(lineSnapshot(current))) return false
    this.repository.updateLine(current.id, { ...fields, updatedAt: at, updatedBy: by })
    this.touch(context, at, by)
    revision({ action: 'linha_editar', lineId: current.id, before: lineSnapshot(current), after: lineSnapshot(next) })
    return true
  }

  /** O contexto muda quando uma linha dele muda: o "última mudança" da lista e a ordem do índice no prompt. */
  private touch(context: ILedgerContext, at: Date, by: TLedgerAuthor): void {
    this.repository.updateContext(context.id, { updatedAt: at, updatedBy: by })
  }

  /** Os campos de texto aparados e o tipo pelo nome canônico (`REGRA` → APRENDIZADO). Tipo inválido fica para a regra recusar. */
  private normalizedLine(line: NonNullable<ILedgerWrite['line']>): NonNullable<ILedgerWrite['line']> {
    const trim = (value: string | undefined) => (value === undefined ? undefined : value.trim())
    const type = line.type === undefined ? undefined : (lineTypeOf(line.type) ?? (String(line.type) as ILedgerLine['type']))
    return { type, trigger: trim(line.trigger), learning: trim(line.learning), ref: trim(line.ref), date: trim(line.date) }
  }

  private requireContext(agentId: string, topic: string): ILedgerContext {
    const context = this.repository.context(agentId, topic)
    if (!context) {
      const near = this.repository
        .contexts(agentId)
        .filter((other) => similarTopics(other.topic, topic))
        .map((other) => other.topic)
      throw new LedgerNotFoundError('context', near.length ? `${topic} (did you mean ${near.join(', ')}?)` : topic)
    }
    return context
  }

  private summary(context: ILedgerContext, lineCount: number, warnings: readonly ILedgerWarning[]): ILedgerContextSummary {
    return {
      topic: context.topic,
      trigger: context.trigger,
      lineCount,
      hasPlaybook: !!context.playbook.trim(),
      createdAt: context.createdAt,
      createdBy: context.createdBy,
      updatedAt: context.updatedAt,
      updatedBy: context.updatedBy,
      warnings: warnings.filter((warning) => warning.topic === context.topic),
    }
  }

  private detail(context: ILedgerContext, warnings: readonly ILedgerWarning[]): ILedgerContextDetail {
    const lines = this.repository.lines(context.id)
    return { ...this.summary(context, lines.length, warnings), playbook: context.playbook, lines: lines.map(lineView) }
  }
}
