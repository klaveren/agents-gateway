import { randomUUID } from 'node:crypto'
import { builderKindOf, PROTOCOLS } from '@domain/Builder.Agents'
import { estimateTokens } from '@domain/Token.Estimate'
import { AgentNotFoundError, GuidanceNotFoundError, InvalidGuidanceError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import {
  DOC_BODY_MAX,
  DOC_ID_PATTERN,
  DOC_INDEX_LIMIT,
  DOC_KINDS,
  DOC_SUMMARY_MAX,
  DOC_TITLE_MAX,
  IProjectDoc,
  READ_DOC_TOOL,
  SEARCH_DOCS_TOOL,
  TDocKind,
} from '@domain/models/ProjectDoc.Model'
import {
  ALL_RESOURCES,
  IAgentResources,
  NO_RESOURCES,
  IResource,
  RESOURCE_BODY_MAX,
  RESOURCE_DESCRIPTION_MAX,
  RESOURCE_ID_PATTERN,
  RESOURCE_KINDS,
  TResourceKind,
  USE_SKILL_TOOL,
} from '@domain/models/Resource.Model'
import { IBuilderDraft, IProtocolAddendum, IProtocolView, PROTOCOL_ADDENDUM_MAX, PROTOCOL_KINDS, TProtocolKind } from '@domain/models/Protocol.Model'
import { IRule, RULE_BODY_MAX, RULE_TITLE_MAX } from '@domain/models/Rule.Model'
import { IDocHit, IGuidanceRepository, TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'

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

/** O que o serviço precisa saber de um agente: o projeto dele decide que specs ele pode carregar. */
export interface IContextAgent {
  id: string
  projectId?: string
}

/** Quem carrega uma spec inteira: os projetos e os agentes (o selo da página Specs). */
export interface ILoadedIn {
  projects: string[]
  agents: string[]
}

/** As seções que o ambiente põe no prompt, cada uma o texto dela (ausente = não entra). */
export interface IEnvironmentParts {
  rules?: string
  projectSpecs?: string
  agentSpecs?: string
  index?: string
  skills?: string
  commands?: string
  /** Só no construtor: o complemento do protocolo (o global, depois o do projeto). */
  protocol?: string
  /** Só no construtor: o que já existe do tipo que ele constrói (id e descrição). */
  existing?: string
}

export type { IBuilderDraft }

export interface IResourceInput {
  id?: string
  kind?: TResourceKind
  projectId?: string | null
  description?: string
  body?: string
  docIds?: string[]
}

/** Um `/command` expandido: o que vai ao modelo e o que a conversa grava (o que a pessoa digitou). */
export interface IExpandedCommand {
  text: string
  label: string
  command: string
}

export { estimateTokens }

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
    /** O agente existe, e de que projeto é? (o contexto inicial do agente). Ausente = nenhum agente. */
    private readonly agentOf: (agentId: string) => IContextAgent | undefined = () => undefined,
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
   * ⛔ A busca de texto nos documentos que a conversa pode ler: os globais e os do projeto dela. Termos soltos, em
   * qualquer ordem e sem acento; cada um casa também como prefixo ("flag" acha "flags"). Os mais relevantes primeiro.
   */
  searchDocs(query: string, projectId?: string, kind?: TDocKind): IDocHit[] {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 8))]
    if (!terms.length) return []
    // ⛔ O termo vai entre aspas: nada do que o modelo digitar vira operador do FTS5 (AND, NEAR, coluna:).
    const match = terms.map((term) => `"${term}"*`).join(' OR ')
    return this.repository.searchDocs(match, [null, ...(projectId ? [projectId] : [])], kind)
  }

  /**
   * O CONTEXTO INICIAL do projeto: as specs que vão INTEIRAS no prompt de toda conversa dele, na ordem marcada.
   * ⚖️ O que deixou de valer (virou ADR, foi para outro projeto, sumiu) fica de fora sem apagar a marca: voltar a
   * valer, volta a entrar.
   */
  initialContext(projectId: string): IProjectDoc[] {
    return this.validSpecs(this.repository.contextDocs(projectId), projectId)
  }

  /** O contexto inicial como a tela o mostra: sem o corpo, com os tokens estimados. */
  initialContextView(projectId: string): { docs: IContextDoc[]; totalTokens: number } {
    this.requireProject(projectId)
    return contextView(this.initialContext(projectId))
  }

  /** ⛔ Só spec, e só a global ou a do próprio projeto. Troca a lista inteira, na ordem dada. */
  setInitialContext(projectId: string, docIds: readonly string[], by: string): { docs: IContextDoc[]; totalTokens: number } {
    this.requireProject(projectId)
    this.checkSpecs(docIds, projectId, 'another project')
    this.repository.setContextDocs(projectId, docIds, by)
    return this.initialContextView(projectId)
  }

  /**
   * O CONTEXTO INICIAL do AGENTE: as specs que ele carrega inteiras ALÉM das do projeto (o agente desenvolvedor e as
   * de arquitetura). ⛔ Agente de projeto: as globais e as do projeto dele. Agente global: só as globais — ele roda
   * em qualquer projeto, e uma spec de um projeto vazaria para os outros.
   */
  agentContext(agentId: string): IProjectDoc[] {
    const agent = this.agentOf(agentId)
    return agent ? this.validSpecs(this.repository.agentContextDocs(agentId), agent.projectId) : []
  }

  agentContextView(agentId: string): { docs: IContextDoc[]; totalTokens: number } {
    this.requireAgent(agentId)
    return contextView(this.agentContext(agentId))
  }

  setAgentContext(agentId: string, docIds: readonly string[], by: string): { docs: IContextDoc[]; totalTokens: number } {
    const agent = this.requireAgent(agentId)
    this.checkSpecs(docIds, agent.projectId, agent.projectId ? 'another project' : 'a project (a global agent loads only global specs)')
    this.repository.setAgentContextDocs(agentId, docIds, by)
    return this.agentContextView(agentId)
  }

  /** O agente foi apagado: o contexto inicial e os recursos liberados dele vão junto. */
  removeAgent(agentId: string): void {
    this.repository.deleteAgentContext(agentId)
    this.repository.deleteAgentResources(agentId)
  }

  /** Quem carrega o documento inteiro, projetos e agentes (o selo da página Specs). */
  loadedIn(docId: string): ILoadedIn {
    return {
      projects: this.repository.contextProjectsOf(docId).filter((projectId) => this.initialContext(projectId).some((doc) => doc.id === docId)),
      agents: this.repository.agentContextOf(docId).filter((agentId) => this.agentContext(agentId).some((doc) => doc.id === docId)),
    }
  }

  /** Há documento no índice desta conversa? É o que liga o `read_doc` nela. */
  hasDocs(projectId?: string, agentId?: string): boolean {
    return this.visibleDocs(projectId, agentId).length > 0
  }

  /**
   * O que vai no system prompt da conversa: as rules ligadas (globais, depois as do projeto, numeradas), as specs
   * inteiras do projeto e as do agente, e o índice dos documentos. `undefined` sem nada cadastrado — a seção nem
   * aparece.
   */
  environmentFor(projectId?: string, agentId?: string): string | undefined {
    const parts = this.environmentParts(projectId, agentId)
    const sections = [parts.rules, parts.projectSpecs, parts.agentSpecs, parts.skills, parts.commands, parts.index, parts.protocol, parts.existing].filter(
      (part): part is string => !!part,
    )
    return sections.length ? sections.join('\n\n') : undefined
  }

  /** As seções do ambiente separadas (a guia Tamanho do agente pesa cada uma). */
  environmentParts(projectId?: string, agentId?: string): IEnvironmentParts {
    const rules = [...this.repository.rules(null), ...(projectId ? this.repository.rules(projectId) : [])].filter((rule) => rule.enabled)
    const { project: loaded, agent: own } = this.loadedFor(projectId, agentId)
    const docs = this.visibleDocs(projectId, agentId)
    const parts: IEnvironmentParts = {}
    if (rules.length) {
      parts.rules = [
        '## Regras do ambiente',
        'Valem em toda resposta e em toda ferramenta que você usar. Em conflito com um pedido, a regra vence: diga qual regra impede.',
        ...rules.map((rule, index) => `${index + 1}. **${rule.title}** — ${rule.body}`),
      ].join('\n')
    }
    if (loaded.length) {
      parts.projectSpecs = [
        '## Specs do projeto',
        'Carregadas inteiras: valem como as regras do ambiente. Siga-as em toda resposta e em toda ferramenta que você usar.',
        ...loaded.map((doc) => `### ${doc.title}\n${doc.body.trim()}`),
      ].join('\n\n')
    }
    if (own.length) {
      parts.agentSpecs = [
        '## Specs do agente',
        'Carregadas inteiras para o seu papel, além das do projeto: valem como as regras do ambiente.',
        ...own.map((doc) => `### ${doc.title}\n${doc.body.trim()}`),
      ].join('\n\n')
    }
    const skills = this.usableResources('skill', agentId)
    if (skills.length) {
      parts.skills = [
        '## Skills',
        `Modos de fazer prontos para o seu trabalho. Antes de fazer algo que uma delas cobre, carregue-a inteira com ${USE_SKILL_TOOL} (pelo id) e siga o que ela diz.`,
        ...skills.map((skill) => `- ${skill.id} — ${skill.description}`),
      ].join('\n')
    }
    const commands = this.usableResources('command', agentId)
    if (commands.length) {
      parts.commands = [
        '## Commands',
        'Pedidos prontos que a pessoa dispara com /nome. Quando ela mandar um, a mensagem chega já expandida; se perguntar o que dá para pedir, são estes.',
        ...commands.map((command) => `- /${command.id} — ${command.description}`),
      ].join('\n')
    }
    if (docs.length) {
      // ⚖️ Acima do limite, os mais recentes; o resto o agente acha com a busca — o índice não cresce sem fim no prompt.
      const listed = docs.length > DOC_INDEX_LIMIT ? [...docs].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, DOC_INDEX_LIMIT) : docs
      parts.index = [
        '## Documentos de referência',
        `Specs (como algo deve ser), ADRs (decisões e o porquê) e conhecimento (o estudo de um tema, com as fontes). Antes de decidir algo que um deles cobre, leia-o inteiro com ${READ_DOC_TOOL} (pelo id). Para achar pelo assunto — inclusive no texto, não só no título —, use ${SEARCH_DOCS_TOOL}.`,
        ...listed.map((doc) => `- [${doc.kind}] ${doc.id} — ${doc.title}${doc.summary ? `: ${doc.summary}` : ''}`),
        ...(listed.length < docs.length ? [`- … e mais ${docs.length - listed.length} documento(s): ache com ${SEARCH_DOCS_TOOL}.`] : []),
      ].join('\n')
    }
    const building = builderKindOf(agentId)
    if (building) Object.assign(parts, this.builderParts(building, projectId))
    return parts
  }

  /** O protocolo como vale no escopo: o do core e os complementos (o global e, com projeto, o dele). */
  protocol(kind: TProtocolKind, projectId?: string): IProtocolView {
    this.requireKind(kind)
    if (projectId) this.requireProject(projectId)
    const global = this.repository.protocolAddendum(kind, null)
    const project = projectId ? this.repository.protocolAddendum(kind, projectId) : undefined
    return { core: PROTOCOLS[kind], addenda: { ...(global ? { global } : {}), ...(project ? { project } : {}) } }
  }

  /** Grava o complemento do escopo (`null` = global). Corpo vazio apaga. ⚖️ Soma ao core, nunca o substitui. */
  setProtocolAddendum(kind: TProtocolKind, projectId: string | null, body: string, by: string): IProtocolView {
    this.requireKind(kind)
    const text = body.trim()
    const issues: TIssues = text.length > PROTOCOL_ADDENDUM_MAX ? [{ field: 'body', message: `at most ${PROTOCOL_ADDENDUM_MAX} characters` }] : []
    this.check(issues, projectId ?? undefined)
    const addendum: IProtocolAddendum | undefined = text ? { kind, ...(projectId ? { projectId } : {}), body: text, updatedAt: this.now(), updatedBy: by } : undefined
    this.repository.setProtocolAddendum(kind, projectId, addendum)
    return this.protocol(kind, projectId ?? undefined)
  }

  /**
   * Os problemas do rascunho, campo a campo, SEM gravar — as mesmas regras do cadastro do tipo.
   * ⚖️ Um id que já existe, do mesmo tipo, é o rascunho de um AJUSTE: vale (`updates: true`); de outro tipo, não. A rule
   * não tem id no rascunho: é sempre uma nova (o ajuste de uma rule se faz na tela, onde ela é escolhida).
   */
  draftIssues(draft: IBuilderDraft, projectId?: string): { issues: TIssues; updates: boolean; id?: string; projectId?: string } {
    const scope = draft.global ? undefined : projectId
    const issues: TIssues = []
    let updates = false
    const id = draft.id?.trim() ?? ''
    if (draft.kind === 'rule') {
      issues.push(...ruleIssues({ title: draft.title?.trim() ?? '', body: draft.body?.trim() ?? '' } as IRule))
    } else if (draft.kind === 'spec' || draft.kind === 'adr' || draft.kind === 'knowledge') {
      issues.push(...docIssues({ kind: draft.kind, title: draft.title?.trim() ?? '', summary: draft.summary?.trim() ?? '', body: draft.body ?? '' } as IProjectDoc))
      const existing = DOC_ID_PATTERN.test(id) ? this.repository.doc(id) : undefined
      if (!DOC_ID_PATTERN.test(id)) issues.unshift({ field: 'id', message: 'use 2–64 lowercase letters, digits or hyphens' })
      else if (existing && existing.kind !== draft.kind) issues.unshift({ field: 'id', message: `already taken by an ${existing.kind}: ${id}` })
      updates = !!existing && existing.kind === draft.kind
    } else {
      issues.push(
        ...this.resourceIssues({
          id,
          kind: draft.kind,
          ...(scope ? { projectId: scope } : {}),
          description: draft.description?.trim() ?? '',
          body: draft.body ?? '',
          docIds: draft.docIds ?? [],
          createdAt: this.now(),
          updatedAt: this.now(),
        }),
      )
      const existing = RESOURCE_ID_PATTERN.test(id) ? this.repository.resource(id) : undefined
      if (!RESOURCE_ID_PATTERN.test(id)) issues.unshift({ field: 'id', message: 'use 2–48 lowercase letters, digits or hyphens' })
      else if (existing && existing.kind !== draft.kind) issues.unshift({ field: 'id', message: `already taken by a ${existing.kind}: ${id}` })
      updates = !!existing && existing.kind === draft.kind
    }
    if (scope && !this.projectExists(scope)) issues.push({ field: 'projectId', message: `no such project: ${scope}` })
    return { issues, updates, ...(draft.kind !== 'rule' ? { id } : {}), ...(scope ? { projectId: scope } : {}) }
  }

  /** O que o construtor recebe além do ambiente: o complemento do protocolo e o que já existe do tipo dele. */
  private builderParts(kind: TProtocolKind, projectId?: string): Pick<IEnvironmentParts, 'protocol' | 'existing'> {
    const parts: Pick<IEnvironmentParts, 'protocol' | 'existing'> = {}
    const { global, project } = this.protocol(kind, projectId && this.projectExists(projectId) ? projectId : undefined).addenda
    if (global || project) {
      parts.protocol = [
        '## Complemento do protocolo',
        'Regras de quem administra este gateway, SOMADAS ao protocolo acima. Em conflito, vale o complemento.',
        ...(global ? [`### Global\n${global.body}`] : []),
        ...(project ? [`### Do projeto ${projectId}\n${project.body}`] : []),
      ].join('\n\n')
    }
    const lines = this.existingLines(kind, projectId)
    parts.existing = [`## O que já existe (${EXISTING_LABEL[kind]})`, ...(lines.length ? lines : ['Nada ainda: este será o primeiro.'])].join('\n')
    return parts
  }

  /** Uma linha por registro do tipo, globais e do projeto da conversa — o bastante para não duplicar. */
  private existingLines(kind: TProtocolKind, projectId?: string): string[] {
    const scopes: TGuidanceScope[] = [null, ...(projectId ? [projectId] : [])]
    if (kind === 'rule')
      return scopes.flatMap((scope) =>
        this.repository.rules(scope).map((rule) => `- Rule ${rule.position} [${scope ?? 'global'}]${rule.enabled ? '' : ' (desligada)'} — ${rule.title}: ${rule.body}`),
      )
    if (kind === 'spec' || kind === 'adr' || kind === 'knowledge')
      return scopes.flatMap((scope) => this.repository.docs(scope, kind).map((doc) => `- ${doc.id} [${scope ?? 'global'}] — ${doc.title}${doc.summary ? `: ${doc.summary}` : ''}`))
    return scopes.flatMap((scope) =>
      this.repository.resources(scope, kind).map((resource) => `- ${kind === 'command' ? '/' : ''}${resource.id} [${scope ?? 'global'}] — ${resource.description}`),
    )
  }

  resources(scope: TGuidanceScope, kind?: TResourceKind): IResource[] {
    return this.repository.resources(scope, kind)
  }

  resource(id: string): IResource {
    const resource = this.repository.resource(id)
    if (!resource) throw new GuidanceNotFoundError('resource', id)
    return resource
  }

  createResource(input: IResourceInput, by: string): IResource {
    const resource: IResource = {
      id: input.id?.trim() ?? '',
      kind: input.kind ?? 'skill',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      description: input.description?.trim() ?? '',
      body: input.body ?? '',
      docIds: input.docIds ?? [],
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = this.resourceIssues(resource)
    if (!RESOURCE_ID_PATTERN.test(resource.id)) issues.unshift({ field: 'id', message: 'use 2–48 lowercase letters, digits or hyphens' })
    else if (this.repository.resource(resource.id)) issues.unshift({ field: 'id', message: `already exists: ${resource.id}` })
    this.check(issues, resource.projectId)
    this.repository.saveResource(resource)
    return resource
  }

  /** O id e o tipo ficam; o escopo pode mudar (e os docs anexados têm de caber no novo). */
  updateResource(id: string, input: IResourceInput, by: string): IResource {
    const current = this.resource(id)
    const scope = input.projectId === undefined ? current.projectId : input.projectId || undefined
    const next: IResource = {
      ...current,
      ...(scope ? { projectId: scope } : { projectId: undefined }),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.docIds !== undefined ? { docIds: input.docIds } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    }
    if (!next.projectId) delete next.projectId
    this.check(this.resourceIssues(next), next.projectId)
    this.repository.saveResource(next)
    return next
  }

  deleteResource(id: string): void {
    this.resource(id)
    this.repository.deleteResource(id)
  }

  /** O que o agente pode usar (a guia Recursos dele): sem marcação, `['*']`; "nenhum" de propósito, `[]`. */
  agentResources(agentId: string): IAgentResources {
    this.requireAgent(agentId)
    return effective(this.repository.agentResources(agentId))
  }

  /**
   * ⛔ Agente de projeto: os recursos globais e os do projeto dele. Agente global: só os globais — ele roda em
   * qualquer projeto. `*` sozinho = todos os que ele pode ver. Troca as duas listas inteiras.
   */
  setAgentResources(agentId: string, input: Partial<IAgentResources>, by: string): IAgentResources {
    const agent = this.requireAgent(agentId)
    const next: IAgentResources = { skills: input.skills ?? [], commands: input.commands ?? [] }
    const issues: TIssues = []
    for (const [field, kind] of [
      ['skills', 'skill'],
      ['commands', 'command'],
    ] as const) {
      const ids = next[field]
      if (ids.includes(ALL_RESOURCES) && ids.length > 1) issues.push({ field, message: `"${ALL_RESOURCES}" goes alone` })
      for (const id of ids.filter((item) => item !== ALL_RESOURCES)) {
        const resource = this.repository.resource(id)
        if (!resource || resource.kind !== kind) issues.push({ field, message: `no such ${kind}: ${id}` })
        else if (resource.projectId && resource.projectId !== agent.projectId)
          issues.push({
            field,
            message: agent.projectId ? `${id} belongs to another project (${resource.projectId})` : `${id} belongs to a project (a global agent uses only global resources)`,
          })
      }
    }
    if (issues.length) throw new InvalidGuidanceError(issues)
    // Lista vazia é "nenhum" DE PROPÓSITO: gravada com a marca, senão voltaria ao padrão (todos).
    this.repository.setAgentResources(agentId, { skills: next.skills.length ? next.skills : [NO_RESOURCES], commands: next.commands.length ? next.commands : [NO_RESOURCES] }, by)
    return next
  }

  /**
   * Os recursos que o agente pode usar AGORA: os que ele vê (globais e, num agente de projeto, os do projeto dele) e
   * que a guia Recursos libera (sem marcação, todos). Sem agente, nenhum.
   */
  usableResources(kind: TResourceKind, agentId?: string): IResource[] {
    // ⛔ O construtor não usa skills nem commands: ele os ESCREVE (e o índice só pesaria no prompt dele).
    const agent = agentId && !builderKindOf(agentId) ? this.agentOf(agentId) : undefined
    if (!agent) return []
    const granted = effective(this.repository.agentResources(agent.id))[kind === 'skill' ? 'skills' : 'commands']
    if (!granted.length) return []
    const visible = [...this.repository.resources(null, kind), ...(agent.projectId ? this.repository.resources(agent.projectId, kind) : [])]
    return granted.includes(ALL_RESOURCES) ? visible : visible.filter((resource) => granted.includes(resource.id))
  }

  /** Há skill para o `use_skill` carregar? É o que liga a ferramenta no agente. */
  hasSkills(agentId?: string): boolean {
    return this.usableResources('skill', agentId).length > 0
  }

  /** ⛔ A skill inteira, com os documentos anexados — só uma que o agente pode usar; outra responde como inexistente. */
  loadSkill(id: string, agentId?: string): string | undefined {
    const skill = this.usableResources('skill', agentId).find((resource) => resource.id === id)
    return skill ? `# Skill: ${skill.id}\n\n${skill.body.trim()}${this.attachments(skill)}` : undefined
  }

  /**
   * `/nome argumentos` → o que vai ao modelo, com os documentos anexados. `undefined` quando a mensagem não é um
   * recurso conhecido (segue como texto). ⛔ O que existe mas não está liberado para este agente é recusado com o motivo.
   * - COMMAND: o texto dele, com `$ARGUMENTS` trocado (sem ele, os argumentos vão no fim).
   * - SKILL: a pessoa a escolheu de propósito — ela vai inteira, já carregada, com o pedido depois (sem o `use_skill`).
   */
  expandCommand(text: string, agentId?: string, projectId?: string): IExpandedCommand | undefined {
    const doc = this.expandDoc(text, projectId)
    if (doc) return doc
    const match = /^\/([a-z0-9][a-z0-9-]{1,47})(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return undefined
    const [, id, rawArgs] = match
    const existing = this.repository.resource(id)
    if (!existing) return undefined
    const resource = this.usableResources(existing.kind, agentId).find((item) => item.id === id)
    if (!resource) throw new InvalidGuidanceError([{ field: 'message', message: `${existing.kind} /${id} is not enabled for this agent` }])
    const args = (rawArgs ?? '').trim()
    if (resource.kind === 'skill') {
      const skill = `[A pessoa pediu a skill ${resource.id}: ela já está carregada abaixo — siga-a.]\n\n# Skill: ${resource.id}\n\n${resource.body.trim()}${this.attachments(resource)}`
      return { text: `${skill}\n\n# Pedido\n\n${args || '(sem texto: aplique a skill ao que estamos fazendo)'}`, label: text.trim(), command: id }
    }
    const body = resource.body.includes('$ARGUMENTS') ? resource.body.replace(/\$ARGUMENTS/g, args) : `${resource.body.trim()}${args ? `\n\nArgumentos: ${args}` : ''}`
    return { text: `${body.trim()}${this.attachments(resource)}`, label: text.trim(), command: id }
  }

  /**
   * `/spec:<id> pedido` (também `adr:` e `knowledge:`): a pessoa escolheu um DOCUMENTO no `/` — ele vai inteiro, com o
   * pedido depois (sem o agente precisar achá-lo). ⛔ Só o global ou o do projeto da conversa, como o `read_doc`; o
   * que não existe ou é de outro projeto segue como texto.
   */
  private expandDoc(text: string, projectId?: string): IExpandedCommand | undefined {
    const match = /^\/(spec|adr|knowledge):([a-z0-9][a-z0-9-]{1,63})(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return undefined
    const [, kind, id, rawArgs] = match
    const doc = this.readDoc(id, projectId)
    if (!doc || doc.kind !== kind) return undefined
    const args = (rawArgs ?? '').trim()
    return {
      text: `[A pessoa anexou o documento ${doc.id} (${doc.kind}): ele está abaixo, inteiro.]\n\n# ${doc.title} [${doc.kind}]\n\n${doc.body.trim()}\n\n# Pedido\n\n${args || '(sem texto: use o documento no que estamos fazendo)'}`,
      label: text.trim(),
      command: `${kind}:${id}`,
    }
  }

  /** O projeto foi apagado: as rules e os documentos dele vão junto. */
  removeProject(projectId: string): void {
    this.repository.deleteProject(projectId)
  }

  /** As specs inteiras da conversa: as do projeto e as do agente — a que está nas duas fica só na do projeto. */
  private loadedFor(projectId?: string, agentId?: string): { project: IProjectDoc[]; agent: IProjectDoc[] } {
    const project = projectId ? this.initialContext(projectId) : []
    const taken = new Set(project.map((doc) => doc.id))
    return { project, agent: agentId ? this.agentContext(agentId).filter((doc) => !taken.has(doc.id)) : [] }
  }

  /** O índice da conversa: os globais e os do projeto, menos os que já vão inteiros no prompt. */
  private visibleDocs(projectId?: string, agentId?: string): IProjectDoc[] {
    const { project, agent } = this.loadedFor(projectId, agentId)
    const loaded = new Set([...project, ...agent].map((doc) => doc.id))
    return [...this.repository.docs(null), ...(projectId ? this.repository.docs(projectId) : [])].filter((doc) => !loaded.has(doc.id))
  }

  /** As marcadas que ainda valem: spec, e global ou do escopo dado. ⚖️ A marca do que deixou de valer fica. */
  private validSpecs(docIds: readonly string[], projectId: string | undefined): IProjectDoc[] {
    return docIds.map((id) => this.repository.doc(id)).filter((doc): doc is IProjectDoc => !!doc && doc.kind === 'spec' && (!doc.projectId || doc.projectId === projectId))
  }

  /** ⛔ Só spec, global ou do escopo dado, sem repetir. Todos os problemas de uma vez. */
  private checkSpecs(docIds: readonly string[], projectId: string | undefined, outside: string): void {
    const issues: TIssues = []
    const seen = new Set<string>()
    for (const id of docIds) {
      const doc = this.repository.doc(id)
      if (seen.has(id)) issues.push({ field: 'docIds', message: `repeated: ${id}` })
      else if (!doc) issues.push({ field: 'docIds', message: `no such document: ${id}` })
      else if (doc.kind !== 'spec') issues.push({ field: 'docIds', message: `only specs load in full: ${id} is an ${doc.kind}` })
      else if (doc.projectId && doc.projectId !== projectId) issues.push({ field: 'docIds', message: `${id} belongs to ${outside} (${doc.projectId})` })
      seen.add(id)
    }
    if (issues.length) throw new InvalidGuidanceError(issues)
  }

  /** Os documentos anexados a um recurso, inteiros (os que ainda existem). */
  private attachments(resource: IResource): string {
    const docs = resource.docIds.map((id) => this.repository.doc(id)).filter((doc): doc is IProjectDoc => !!doc)
    if (!docs.length) return ''
    return `\n\n## Documentos anexados\n\n${docs.map((doc) => `### ${doc.title} [${doc.kind}]\n${doc.body.trim()}`).join('\n\n')}`
  }

  private resourceIssues(resource: IResource): TIssues {
    const issues: TIssues = []
    if (!RESOURCE_KINDS.includes(resource.kind)) issues.push({ field: 'kind', message: `one of ${RESOURCE_KINDS.join(', ')}` })
    if (!resource.description) issues.push({ field: 'description', message: 'required: it is what the agent reads to know when to use it' })
    else if (resource.description.length > RESOURCE_DESCRIPTION_MAX) issues.push({ field: 'description', message: `at most ${RESOURCE_DESCRIPTION_MAX} characters` })
    if (!resource.body.trim()) issues.push({ field: 'body', message: 'required' })
    else if (resource.body.length > RESOURCE_BODY_MAX) issues.push({ field: 'body', message: `at most ${RESOURCE_BODY_MAX} characters` })
    for (const id of resource.docIds) {
      const doc = this.repository.doc(id)
      if (!doc) issues.push({ field: 'docIds', message: `no such document: ${id}` })
      else if (doc.projectId && doc.projectId !== resource.projectId) issues.push({ field: 'docIds', message: `${id} belongs to another project (${doc.projectId})` })
    }
    return issues
  }

  private requireKind(kind: TProtocolKind): void {
    if (!PROTOCOL_KINDS.includes(kind)) throw new InvalidGuidanceError([{ field: 'kind', message: `one of ${PROTOCOL_KINDS.join(', ')}` }])
  }

  private requireProject(projectId: string): void {
    if (!this.projectExists(projectId)) throw new ProjectNotFoundError(projectId)
  }

  private requireAgent(agentId: string): IContextAgent {
    const agent = this.agentOf(agentId)
    if (!agent) throw new AgentNotFoundError(agentId)
    return agent
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

/** O que vale para o agente: sem marcação, todos (`*`); a marca de "nenhum", nenhum. */
function effective(stored: IAgentResources): IAgentResources {
  const of = (ids: string[]) => (!ids.length ? [ALL_RESOURCES] : ids.filter((id) => id !== NO_RESOURCES))
  return { skills: of(stored.skills), commands: of(stored.commands) }
}

const EXISTING_LABEL: Readonly<Record<TProtocolKind, string>> = { skill: 'skills', command: 'commands', rule: 'rules', spec: 'specs', adr: 'ADRs', knowledge: 'conhecimento' }

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

function contextView(docs: readonly IProjectDoc[]): { docs: IContextDoc[]; totalTokens: number } {
  const view = docs.map((doc) => ({
    id: doc.id,
    title: doc.title,
    summary: doc.summary,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    tokens: estimateTokens(doc.body),
  }))
  return { docs: view, totalTokens: view.reduce((sum, doc) => sum + doc.tokens, 0) }
}
