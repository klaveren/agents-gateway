import { randomUUID } from 'node:crypto'
import { GuidanceNotFoundError, InvalidGuidanceError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import { DOC_BODY_MAX, DOC_ID_PATTERN, DOC_KINDS, DOC_SUMMARY_MAX, DOC_TITLE_MAX, IProjectDoc, READ_DOC_TOOL, TDocKind } from '@domain/models/ProjectDoc.Model'
import { IRule, RULE_BODY_MAX, RULE_TITLE_MAX } from '@domain/models/Rule.Model'
import { IGuidanceRepository, TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'

type TIssues = Array<{ field: string; message: string }>

export interface IRuleInput {
  projectId?: string | null
  title?: string
  body?: string
  enabled?: boolean
}

/** Uma spec do contexto inicial, para a tela: sem o corpo, com o peso estimado. */
export interface IContextDoc {
  id: string
  title: string
  summary: string
  projectId?: string
  tokens: number
}

/** Tokens estimados de um texto (≈ 4 caracteres por token): só para a tela avisar do peso. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

export interface IDocInput {
  id?: string
  kind?: TDocKind
  projectId?: string | null
  title?: string
  summary?: string
  body?: string
}

/**
 * As RULES e os DOCUMENTOS (specs e ADRs) do ambiente: o cadastro, que é de admin, e o que a conversa recebe.
 *
 * ⚖️ O QUE VALE NUMA CONVERSA são os globais mais os do projeto DELA (não o do agente: o Atlas, global, numa
 * conversa do projeto XPTO recebe as do XPTO). Fixado na criação: editar uma rule vale para as próximas.
 */
export class GuidanceService {
  constructor(
    private readonly repository: IGuidanceRepository,
    /** O projeto existe? (rule e documento de projeto apontam para um que exista). */
    private readonly projectExists: (projectId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  rules(scope: TGuidanceScope): IRule[] {
    return this.repository.rules(scope)
  }

  rule(id: string): IRule {
    const rule = this.repository.rule(id)
    if (!rule) throw new GuidanceNotFoundError('rule', id)
    return rule
  }

  /** Rule nova: no fim da lista do escopo (a próxima "Rule N"). */
  createRule(input: IRuleInput, by: string): IRule {
    const scope = input.projectId ?? null
    const rule: IRule = {
      id: randomUUID(),
      ...(scope ? { projectId: scope } : {}),
      position: this.nextPosition(scope),
      title: input.title?.trim() ?? '',
      body: input.body?.trim() ?? '',
      enabled: input.enabled ?? true,
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    this.check(ruleIssues(rule), rule.projectId)
    this.repository.insertRule(rule)
    return rule
  }

  /** Trocar o escopo leva a rule para o fim da lista do novo e renumera a do antigo. */
  updateRule(id: string, input: IRuleInput, by: string): IRule {
    const current = this.rule(id)
    const scope = input.projectId === undefined ? (current.projectId ?? null) : input.projectId
    const moved = scope !== (current.projectId ?? null)
    const next: IRule = {
      ...current,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body.trim() } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    }
    this.check(ruleIssues(next), scope ?? undefined)
    const saved = this.repository.updateRule(id, {
      title: next.title,
      body: next.body,
      enabled: next.enabled,
      ...(moved ? { projectId: scope, position: this.nextPosition(scope) } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
    if (moved) this.renumber(current.projectId ?? null)
    return saved
  }

  deleteRule(id: string): void {
    const rule = this.rule(id)
    this.repository.deleteRule(id)
    this.renumber(rule.projectId ?? null)
  }

  /** Sobe ou desce uma posição, trocando com a vizinha. Na ponta, fica onde está. */
  moveRule(id: string, direction: 'up' | 'down', by: string): IRule[] {
    const rule = this.rule(id)
    const list = this.repository.rules(rule.projectId ?? null)
    const index = list.findIndex((item) => item.id === id)
    const other = list[direction === 'up' ? index - 1 : index + 1]
    if (other) {
      this.repository.updateRule(rule.id, { position: other.position, updatedAt: this.now(), updatedBy: by })
      this.repository.updateRule(other.id, { position: rule.position })
    }
    return this.repository.rules(rule.projectId ?? null)
  }

  docs(scope: TGuidanceScope, kind?: TDocKind): IProjectDoc[] {
    return this.repository.docs(scope, kind)
  }

  doc(id: string): IProjectDoc {
    const doc = this.repository.doc(id)
    if (!doc) throw new GuidanceNotFoundError('doc', id)
    return doc
  }

  createDoc(input: IDocInput, by: string): IProjectDoc {
    const doc: IProjectDoc = {
      id: input.id?.trim() ?? '',
      kind: input.kind ?? 'spec',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      title: input.title?.trim() ?? '',
      summary: input.summary?.trim() ?? '',
      body: input.body ?? '',
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = docIssues(doc)
    if (!DOC_ID_PATTERN.test(doc.id)) issues.unshift({ field: 'id', message: 'use 2–64 lowercase letters, digits or hyphens' })
    else if (this.repository.doc(doc.id)) issues.unshift({ field: 'id', message: `already exists: ${doc.id}` })
    this.check(issues, doc.projectId)
    this.repository.insertDoc(doc)
    return doc
  }

  updateDoc(id: string, input: IDocInput, by: string): IProjectDoc {
    const current = this.doc(id)
    const scope = input.projectId === undefined ? (current.projectId ?? null) : input.projectId
    const next: IProjectDoc = {
      ...current,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.summary !== undefined ? { summary: input.summary.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
    }
    this.check(docIssues(next), scope ?? undefined)
    return this.repository.updateDoc(id, {
      kind: next.kind,
      title: next.title,
      summary: next.summary,
      body: next.body,
      ...(input.projectId !== undefined ? { projectId: scope } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
  }

  deleteDoc(id: string): void {
    this.doc(id)
    this.repository.deleteDoc(id)
  }

  /**
   * ⛔ O documento que a conversa pode ler: o global ou o do projeto dela. O de outro projeto responde como
   * inexistente — o id sozinho não abre nada.
   */
  readDoc(id: string, projectId?: string): IProjectDoc | undefined {
    const doc = this.repository.doc(id)
    if (!doc) return undefined
    return !doc.projectId || doc.projectId === projectId ? doc : undefined
  }

  /**
   * O CONTEXTO INICIAL do projeto: as specs que vão INTEIRAS no prompt de toda conversa dele, na ordem marcada.
   * ⚖️ O que deixou de valer (virou ADR, foi para outro projeto, sumiu) fica de fora sem apagar a marca: voltar a
   * valer, volta a entrar.
   */
  initialContext(projectId: string): IProjectDoc[] {
    return this.repository
      .contextDocs(projectId)
      .map((id) => this.repository.doc(id))
      .filter((doc): doc is IProjectDoc => !!doc && doc.kind === 'spec' && (!doc.projectId || doc.projectId === projectId))
  }

  /** O contexto inicial como a tela o mostra: sem o corpo, com os tokens estimados. */
  initialContextView(projectId: string): { docs: IContextDoc[]; totalTokens: number } {
    this.requireProject(projectId)
    const docs = this.initialContext(projectId).map((doc) => ({
      id: doc.id,
      title: doc.title,
      summary: doc.summary,
      ...(doc.projectId ? { projectId: doc.projectId } : {}),
      tokens: estimateTokens(doc.body),
    }))
    return { docs, totalTokens: docs.reduce((sum, doc) => sum + doc.tokens, 0) }
  }

  /** ⛔ Só spec, e só a global ou a do próprio projeto. Troca a lista inteira, na ordem dada. */
  setInitialContext(projectId: string, docIds: readonly string[], by: string): { docs: IContextDoc[]; totalTokens: number } {
    this.requireProject(projectId)
    const issues: TIssues = []
    const seen = new Set<string>()
    for (const id of docIds) {
      const doc = this.repository.doc(id)
      if (seen.has(id)) issues.push({ field: 'docIds', message: `repeated: ${id}` })
      else if (!doc) issues.push({ field: 'docIds', message: `no such document: ${id}` })
      else if (doc.kind !== 'spec') issues.push({ field: 'docIds', message: `only specs load in full: ${id} is an ${doc.kind}` })
      else if (doc.projectId && doc.projectId !== projectId) issues.push({ field: 'docIds', message: `${id} belongs to another project (${doc.projectId})` })
      seen.add(id)
    }
    if (issues.length) throw new InvalidGuidanceError(issues)
    this.repository.setContextDocs(projectId, docIds, by)
    return this.initialContextView(projectId)
  }

  /** Os projetos que carregam o documento inteiro (o selo da página Specs). */
  loadedIn(docId: string): string[] {
    return this.repository.contextProjectsOf(docId).filter((projectId) => this.initialContext(projectId).some((doc) => doc.id === docId))
  }

  /** Há documento no índice desta conversa? É o que liga o `read_doc` nela. */
  hasDocs(projectId?: string): boolean {
    return this.visibleDocs(projectId).length > 0
  }

  /**
   * O que vai no system prompt da conversa: as rules ligadas (globais, depois as do projeto, numeradas) e o
   * índice dos documentos. `undefined` sem nada cadastrado — a seção nem aparece.
   */
  environmentFor(projectId?: string): string | undefined {
    const rules = [...this.repository.rules(null), ...(projectId ? this.repository.rules(projectId) : [])].filter((rule) => rule.enabled)
    const loaded = projectId ? this.initialContext(projectId) : []
    const docs = this.visibleDocs(projectId)
    const sections: string[] = []
    if (rules.length) {
      sections.push(
        [
          '## Regras do ambiente',
          'Valem em toda resposta e em toda ferramenta que você usar. Em conflito com um pedido, a regra vence: diga qual regra impede.',
          ...rules.map((rule, index) => `${index + 1}. **${rule.title}** — ${rule.body}`),
        ].join('\n'),
      )
    }
    if (loaded.length) {
      sections.push(
        [
          '## Specs do projeto',
          'Carregadas inteiras: valem como as regras do ambiente. Siga-as em toda resposta e em toda ferramenta que você usar.',
          ...loaded.map((doc) => `### ${doc.title}\n${doc.body.trim()}`),
        ].join('\n\n'),
      )
    }
    if (docs.length) {
      sections.push(
        [
          '## Documentos de referência',
          `Specs (como algo deve ser) e ADRs (decisões e o porquê). Antes de decidir algo que um deles cobre, leia-o inteiro com ${READ_DOC_TOOL} (pelo id).`,
          ...docs.map((doc) => `- [${doc.kind}] ${doc.id} — ${doc.title}${doc.summary ? `: ${doc.summary}` : ''}`),
        ].join('\n'),
      )
    }
    return sections.length ? sections.join('\n\n') : undefined
  }

  /** O projeto foi apagado: as rules e os documentos dele vão junto. */
  removeProject(projectId: string): void {
    this.repository.deleteProject(projectId)
  }

  /** O índice da conversa: os globais e os do projeto, menos os que já vão inteiros no prompt. */
  private visibleDocs(projectId?: string): IProjectDoc[] {
    const loaded = new Set(projectId ? this.initialContext(projectId).map((doc) => doc.id) : [])
    return [...this.repository.docs(null), ...(projectId ? this.repository.docs(projectId) : [])].filter((doc) => !loaded.has(doc.id))
  }

  private requireProject(projectId: string): void {
    if (!this.projectExists(projectId)) throw new ProjectNotFoundError(projectId)
  }

  private nextPosition(scope: TGuidanceScope): number {
    return this.repository.rules(scope).reduce((max, rule) => Math.max(max, rule.position), 0) + 1
  }

  /** Depois de apagar ou tirar uma: 1, 2, 3… sem buraco. */
  private renumber(scope: TGuidanceScope): void {
    this.repository.rules(scope).forEach((rule, index) => {
      if (rule.position !== index + 1) this.repository.updateRule(rule.id, { position: index + 1 })
    })
  }

  private check(issues: TIssues, projectId: string | undefined): void {
    if (projectId && !this.projectExists(projectId)) issues.push({ field: 'projectId', message: `no such project: ${projectId}` })
    if (issues.length) throw new InvalidGuidanceError(issues)
  }
}

function ruleIssues(rule: IRule): TIssues {
  const issues: TIssues = []
  if (!rule.title) issues.push({ field: 'title', message: 'required' })
  else if (rule.title.length > RULE_TITLE_MAX) issues.push({ field: 'title', message: `at most ${RULE_TITLE_MAX} characters` })
  if (!rule.body) issues.push({ field: 'body', message: 'required' })
  else if (rule.body.length > RULE_BODY_MAX) issues.push({ field: 'body', message: `at most ${RULE_BODY_MAX} characters` })
  return issues
}

function docIssues(doc: IProjectDoc): TIssues {
  const issues: TIssues = []
  if (!DOC_KINDS.includes(doc.kind)) issues.push({ field: 'kind', message: `one of ${DOC_KINDS.join(', ')}` })
  if (!doc.title) issues.push({ field: 'title', message: 'required' })
  else if (doc.title.length > DOC_TITLE_MAX) issues.push({ field: 'title', message: `at most ${DOC_TITLE_MAX} characters` })
  if (doc.summary.length > DOC_SUMMARY_MAX) issues.push({ field: 'summary', message: `at most ${DOC_SUMMARY_MAX} characters` })
  if (!doc.body.trim()) issues.push({ field: 'body', message: 'required' })
  else if (doc.body.length > DOC_BODY_MAX) issues.push({ field: 'body', message: `at most ${DOC_BODY_MAX} characters` })
  return issues
}
