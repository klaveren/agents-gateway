import { randomUUID } from 'node:crypto'
import { builderKindOf, PROTOCOLS } from '@domain/Builder.Agents'
import { estimateTokens } from '@domain/Token.Estimate'
import { triggerIssues } from '@domain/Agent.Policy'
import { normalizeShares, SHAREABLE_DOC_KINDS, SHAREABLE_RESOURCE_KINDS, shareIssues, sharedInto, visibleIn } from '@domain/Share.Policy'
import { normalizeTags, tagIssues } from '@domain/Tag.Policy'
import type { IAgentTrigger } from '@domain/models/Agent.Model'
import { AgentNotFoundError, GuidanceNotFoundError, InvalidGuidanceError, ProjectNotFoundError } from '@domain/errors/Domain.Error'
import {
  DOC_ID_PATTERN,
  DOC_INDEX_LIMIT,
  DOC_KINDS,
  DOC_STATUSES,
  DOC_SUMMARY_MAX,
  DOC_TITLE_MAX,
  IProjectDoc,
  isInactiveDoc,
  READ_DOC_TOOL,
  SEARCH_DOCS_TOOL,
  TDocKind,
  TDocStatus,
} from '@domain/models/ProjectDoc.Model'
import {
  ALL_RESOURCES,
  effectiveResources,
  IAgentResources,
  NO_RESOURCES,
  IResource,
  RESOURCE_DESCRIPTION_MAX,
  RESOURCE_ID_PATTERN,
  RESOURCE_KINDS,
  TResourceKind,
  TUsableKind,
  USE_RESOURCE_TOOL,
} from '@domain/models/Resource.Model'
import { IBuilderDraft, IProtocolAddendum, IProtocolView, PROTOCOL_KINDS, TProtocolKind } from '@domain/models/Protocol.Model'
import { IImportProblem, describeMatch, IImportProblemMatch, withoutProblem } from '@domain/models/ImportProblem.Model'
import { IRule, RULE_TITLE_MAX } from '@domain/models/Rule.Model'
import { IDocHit, IGuidanceRepository, TGuidanceScope } from '@domain/ports/GuidanceRepository.Port'
import { fileIssues, filesNote, IResourceFile, sortFiles } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'
import { protocolItemId } from '@domain/Catalog.Document'
import { CatalogHistoryHook, ICatalogItemKey } from './CatalogHistory.Service'

type TIssues = Array<{ field: string; message: string }>

export interface IRuleInput {
  projectId?: string | null
  title?: string
  body?: string
  enabled?: boolean
  /** As tags (ver `Tag.Policy`). Ausente na edição = mantém; `[]` tira todas. */
  tags?: string[]
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
  /** Os triggers do agente (ver `IAgent.triggers`): o índice "## Triggers" e o `use_resource`. */
  triggers?: ReadonlyArray<{ id: string; when: string; body: string }>
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
  triggers?: string
  /** O índice do ledger do agente (tema → gatilho) e a regra de leitura e escrita (ver `Ledger.Policy`). */
  ledger?: string
  /** Só no construtor: o complemento do protocolo (o global, depois o do projeto). */
  protocol?: string
  /** Só no construtor: o que já existe do tipo que ele constrói (id e descrição). */
  existing?: string
}

export type { IBuilderDraft }

/** O conferente do registro de agente (ver `GuidanceService.useAgentChecker`). */
export type TAgentChecker = (agent: Record<string, unknown>) => Promise<{ issues: Array<{ field: string; message: string }>; exists: boolean }>

export interface IResourceInput {
  id?: string
  kind?: TResourceKind
  projectId?: string | null
  description?: string
  body?: string
  docIds?: string[]
  /** Das anexadas, as que vão por referência (ver `IResource.docRefs`). Ausente na edição = mantém as de antes. */
  docRefs?: string[]
  /** Os arquivos da pasta (o conteúdo já no depósito). Ausente na edição = mantém os de antes; `[]` tira todos. */
  files?: IResourceFile[]
  /** Os problemas da importação (só o caminho do catálogo grava; ver `ImportProblem.Model`). Ausente na edição = mantém. */
  importIssues?: IImportProblem[]
  /** Os triggers do recurso (ver `IResource.triggers`). Ausente na edição = mantém; `[]` tira todos. */
  triggers?: IAgentTrigger[]
  /** As tags (ver `Tag.Policy`). Ausente na edição = mantém; `[]` tira todas. */
  tags?: string[]
}

/**
 * Um documento que o agente lê pelo ANEXO, e por onde (ver `attachedDoc`): uma skill ou command que ele pode carregar,
 * ou um documento que ele já pode ler (`doc`) — o pai na cadeia de anexos.
 */
export interface IAttachedDoc {
  doc: IProjectDoc
  via: Array<{ kind: TResourceKind | 'doc'; id: string }>
}

/** Quem anexa documentos: um recurso (skill/command) ou outro documento. Os dois com a mesma semântica. */
interface IAttacher {
  projectId?: string
  docIds?: readonly string[]
  docRefs?: readonly string[]
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
  /** Outros documentos anexados (ver `IProjectDoc.docIds`). Ausente na edição = mantém. */
  docIds?: string[]
  /** Dos anexados, os que vão por referência (ver `IProjectDoc.docRefs`). Ausente na edição = mantém os de antes. */
  docRefs?: string[]
  /** Os problemas da importação (só o caminho do catálogo grava; ver `ImportProblem.Model`). Ausente na edição = mantém. */
  importIssues?: IImportProblem[]
  /** As tags (ver `Tag.Policy`). Ausente na edição = mantém; `[]` tira todas. */
  tags?: string[]
  /** Ver `TDocStatus`. Ausente na edição = mantém. */
  status?: TDocStatus
  /** Os que este substitui (ver `IProjectDoc.supersedes`). Ausente na edição = mantém; `[]` tira todos. */
  supersedes?: string[]
}

/**
 * ⚖️ ANEXO DE DOCUMENTO A DOCUMENTO — a profundidade. Inteiro, só no PRIMEIRO nível a partir da raiz da carga (o
 * documento lido, a spec do contexto inicial, o recurso carregado); do segundo nível em diante, tudo vira referência, e
 * a referência não se expande (o agente a lê com `read_doc`, que mostra os anexos DELA). Assim a carga tem teto
 * conhecido — a raiz, os anexos dela, e uma lista de referências — e um encadeamento longo não infla o prompt sem
 * ninguém ter escolhido. ⛔ Cada documento entra no máximo UMA vez por carga (o conjunto de visitados começa com as
 * raízes): A anexa B que anexa A não repete nem recursa.
 */
const INLINE_DEPTH = 1

/**
 * As RULES e os DOCUMENTOS (specs e ADRs) do ambiente: o cadastro, que é de admin, e o que a conversa recebe.
 *
 * ⚖️ O QUE VALE NUMA CONVERSA são os globais mais os do projeto DELA (não o do agente: o Atlas, global, numa
 * conversa do projeto XPTO recebe as do XPTO). Fixado na criação: editar uma rule vale para as próximas.
 */
export class GuidanceService {
  /** O histórico do catálogo: toda escrita grava a revisão dos itens que mudaram (ver `CatalogHistory.Service`). */
  readonly history = new CatalogHistoryHook()

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
      ...(normalizeTags(input.tags).length ? { tags: normalizeTags(input.tags) } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    this.check([...tagIssues(input.tags), ...ruleIssues(rule)], rule.projectId)
    this.repository.insertRule(rule)
    this.history.record([ruleKey(rule.id)], { by })
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
      ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
    }
    this.check([...tagIssues(input.tags), ...ruleIssues(next)], scope ?? undefined)
    // Trocar de escopo renumera o antigo: as vizinhas também mudam.
    const touched = moved ? this.history.withDependents(ruleKey(id)) : [ruleKey(id)]
    const saved = this.repository.updateRule(id, {
      title: next.title,
      body: next.body,
      enabled: next.enabled,
      tags: next.tags ?? [],
      ...(moved ? { projectId: scope, position: this.nextPosition(scope) } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
    if (moved) this.renumber(current.projectId ?? null)
    this.history.record(touched, { by })
    return saved
  }

  deleteRule(id: string, by: string): void {
    const rule = this.rule(id)
    const touched = this.history.withDependents(ruleKey(id))
    this.repository.deleteRule(id)
    this.renumber(rule.projectId ?? null)
    this.history.record(touched, { by })
  }

  /**
   * O ROLLBACK de uma rule apagada: volta com o MESMO id (o histórico é por id), no fim da lista do escopo, pelas mesmas
   * regras de `createRule`. ⚖️ A posição antiga não volta: as vizinhas já foram renumeradas.
   */
  restoreRule(input: IRuleInput & { id: string }, by: string): IRule {
    if (this.repository.rule(input.id)) throw new InvalidGuidanceError([{ field: 'id', message: `already exists: ${input.id}` }])
    const scope = input.projectId ?? null
    const rule: IRule = {
      id: input.id,
      ...(scope ? { projectId: scope } : {}),
      position: this.nextPosition(scope),
      title: input.title?.trim() ?? '',
      body: input.body?.trim() ?? '',
      enabled: input.enabled ?? true,
      ...(normalizeTags(input.tags).length ? { tags: normalizeTags(input.tags) } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    this.check([...tagIssues(input.tags), ...ruleIssues(rule)], rule.projectId)
    this.repository.insertRule(rule)
    this.history.record([ruleKey(rule.id)], { by })
    return rule
  }

  /**
   * Os problemas dos vínculos de um agente do projeto dado (ausente = global), SEM gravar: as mesmas regras de
   * `setAgentResources` e `setAgentContext`. O rollback confere antes de gravar o agente, para não parar no meio.
   */
  agentLinkIssues(projectId: string | undefined, links: { resources: IAgentResources; initialContext: readonly string[] }): TIssues {
    return [
      ...this.grantIssues(links.resources, projectId),
      ...this.specIssues(links.initialContext, projectId, projectId ? 'another project' : 'a project (a global agent loads only global specs)'),
    ]
  }

  /** Os problemas do contexto inicial de um projeto, SEM gravar (as regras de `setInitialContext`). */
  contextIssues(projectId: string, docIds: readonly string[]): TIssues {
    return this.specIssues(docIds, projectId, 'another project')
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
      this.history.record([ruleKey(rule.id), ruleKey(other.id)], { by })
    }
    return this.repository.rules(rule.projectId ?? null)
  }

  docs(scope: TGuidanceScope, kind?: TDocKind): IProjectDoc[] {
    return this.repository.docs(scope, kind)
  }

  /** As specs e os conhecimentos que outros projetos compartilham com este (só leitura aqui). */
  sharedDocs(projectId: string, kind?: TDocKind): IProjectDoc[] {
    return this.repository.docsSharedWith(projectId, kind)
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
      docIds: input.docIds ?? [],
      ...(input.docRefs?.length ? { docRefs: input.docRefs } : {}),
      ...(input.importIssues?.length ? { importIssues: input.importIssues } : {}),
      ...(normalizeTags(input.tags).length ? { tags: normalizeTags(input.tags) } : {}),
      ...(input.status && input.status !== 'accepted' ? { status: input.status } : {}),
      ...(input.supersedes?.length ? { supersedes: [...input.supersedes] } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = [...tagIssues(input.tags), ...docIssues(doc), ...this.attachIssues(doc, doc.id), ...this.supersedeIssues(doc, doc.id)]
    if (!DOC_ID_PATTERN.test(doc.id)) issues.unshift({ field: 'id', message: 'use 2–64 lowercase letters, digits or hyphens' })
    else if (this.repository.doc(doc.id)) issues.unshift({ field: 'id', message: `already exists: ${doc.id}` })
    this.check(issues, doc.projectId)
    this.repository.insertDoc(doc)
    this.history.record([{ kind: doc.kind, id: doc.id }, ...this.markSuperseded(doc, by)], { by })
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
      ...(input.docIds !== undefined ? { docIds: input.docIds } : {}),
      ...(input.importIssues !== undefined ? { importIssues: input.importIssues } : {}),
      ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.supersedes !== undefined ? { supersedes: [...input.supersedes] } : {}),
    }
    if (next.status === 'accepted') delete next.status
    if (!next.supersedes?.length) delete next.supersedes
    if (scope) next.projectId = scope
    else delete next.projectId
    const sharedWith = sharesAfterMove(current.sharedWith, scope)
    // Sem `docRefs` na edição, ficam os de antes — menos os que deixaram de estar anexados.
    const docIds = next.docIds ?? []
    const refs = input.docRefs ?? (current.docRefs ?? []).filter((docId) => docIds.includes(docId))
    if (refs.length) next.docRefs = refs
    else delete next.docRefs
    this.check([...tagIssues(input.tags), ...docIssues(next), ...this.attachIssues(next, id), ...this.supersedeIssues(next, id)], scope ?? undefined)
    const saved = this.repository.updateDoc(id, {
      kind: next.kind,
      title: next.title,
      summary: next.summary,
      body: next.body,
      docIds,
      docRefs: next.docRefs ?? [],
      importIssues: next.importIssues ?? [],
      tags: next.tags ?? [],
      status: next.status ?? 'accepted',
      supersedes: next.supersedes ?? [],
      ...(input.projectId !== undefined ? { projectId: scope, sharedWith } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
    // O tipo faz parte da chave: spec que vira ADR sai de um e entra no outro.
    this.history.record([{ kind: current.kind, id }, { kind: saved.kind, id }, ...this.markSuperseded(saved, by)], { by })
    return saved
  }

  /**
   * "Resolvido": tira do documento os problemas da importação que casam (o código e, dado, o alvo). O resto fica como
   * está; a revisão vai para o histórico. Nenhum casou: 404.
   */
  resolveDocIssue(id: string, match: IImportProblemMatch, by: string): IProjectDoc {
    const doc = this.doc(id)
    const rest = remaining(doc.importIssues, match, `doc ${id}`)
    const saved = this.repository.updateDoc(id, { importIssues: rest, updatedAt: this.now(), updatedBy: by })!
    this.history.record([{ kind: doc.kind, id }], { by })
    return saved
  }

  /** Apaga e tira o documento de quem o citava; cada um desses ganha revisão também, com o mesmo autor. */
  deleteDoc(id: string, by: string): void {
    const doc = this.doc(id)
    const touched = this.history.withDependents({ kind: doc.kind, id })
    this.repository.deleteDoc(id)
    this.history.record(touched, { by })
  }

  /**
   * ⛔ O documento que a conversa pode ler: o global, o do projeto dela ou o COMPARTILHADO com ele (spec e conhecimento).
   * O de outro projeto que não o compartilhou responde como inexistente — o id sozinho não abre nada.
   */
  readDoc(id: string, projectId?: string): IProjectDoc | undefined {
    const doc = this.repository.doc(id)
    if (!doc) return undefined
    return usableIn(doc, projectId) ? doc : undefined
  }

  /**
   * O documento como o agente o recebe ao lê-lo (`read_doc`): o texto inteiro e, depois, os anexos dele — os inteiros
   * como seção, os por referência numa lista (ver `INLINE_DEPTH` para a profundidade e os ciclos).
   */
  docText(doc: IProjectDoc, projectId?: string): string {
    return `# ${doc.title} [${doc.kind}]\n\n${this.statusNote(doc)}${doc.body}${this.attachments(doc, new Set([doc.id]), 2, projectId)}${importIssuesNote(doc.importIssues)}`
  }

  /** O aviso no topo do documento que saiu de uso (ou que ainda é proposta): quem o substitui, e o que seguir. */
  private statusNote(doc: IProjectDoc): string {
    if (doc.status === 'superseded') {
      const by = this.supersededBy(doc)
      return `> ⚠️ SUBSTITUÍDA${by.length ? ` por ${by.join(', ')}` : ''}: não aplique esta decisão${by.length ? `; siga ${by.length > 1 ? 'as que a substituem' : by[0]} (${READ_DOC_TOOL})` : ''}. Fica para o histórico do porquê.\n\n`
    }
    if (doc.status === 'archived') return '> ⚠️ ARQUIVADA: não vale mais; fica para o histórico do porquê.\n\n'
    if (doc.status === 'proposed') return '> PROPOSTA: ainda não aceita.\n\n'
    return ''
  }

  /**
   * ⛔ A busca de texto nos documentos que a conversa pode ler: os globais, os do projeto dela e os compartilhados com ele. Termos soltos, em
   * qualquer ordem e sem acento; cada um casa também como prefixo ("flag" acha "flags"). Os mais relevantes primeiro.
   */
  searchDocs(query: string, projectId?: string, kind?: TDocKind): IDocHit[] {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 8))]
    if (!terms.length) return []
    // ⛔ O termo vai entre aspas: nada do que o modelo digitar vira operador do FTS5 (AND, NEAR, coluna:).
    const match = terms.map((term) => `"${term}"*`).join(' OR ')
    return this.repository.searchDocs(match, [null, ...(projectId ? [projectId] : [])], kind, undefined, projectId ? this.sharedIn(projectId).map((doc) => doc.id) : [])
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
    this.history.record([{ kind: 'project', id: projectId }], { by })
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
    this.history.record([{ kind: 'agent', id: agentId }], { by })
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

  /**
   * Há documento no índice desta conversa, ou anexado por referência a um recurso que o agente usa? É o que liga o
   * `read_doc` nela — o recurso carregado manda ler o anexo por ele.
   */
  hasDocs(projectId?: string, agentId?: string): boolean {
    if (this.visibleDocs(projectId, agentId).length > 0) return true
    const resources = RESOURCE_KINDS.flatMap((kind) => this.usableResources(kind, agentId))
    if (resources.some((resource) => this.attachedTo(resource, this.projectOfAgent(agentId)).some((doc) => (resource.docRefs ?? []).includes(doc.id)))) return true
    // O anexo de um documento que já vem inteiro (contexto inicial, anexo de recurso) chega por referência no 2º nível.
    const { project, agent } = this.loadedFor(projectId, agentId)
    const whole = [
      ...project,
      ...agent,
      ...resources.flatMap((resource) => this.attachedTo(resource, this.projectOfAgent(agentId)).filter((doc) => !(resource.docRefs ?? []).includes(doc.id))),
    ]
    return whole.some((doc) => this.attachedTo(doc, projectId).length > 0)
  }

  /**
   * ⛔ O documento que o agente lê pelo ANEXO — o caminho do `read_doc` quando a regra da conversa (global ou do projeto
   * dela) não o abre. Sobe a cadeia de anexos até achar uma raiz que o agente já pode ler:
   * - uma skill ou command que ESTE agente pode carregar e que o anexa (a permissão `skill` fica com quem chama);
   * - um documento que a conversa lê (global, do projeto dela, ou no contexto inicial do projeto ou do agente).
   * Cada elo vale só se cabe (o anexado é global ou do projeto de quem anexa). Nada além do que o agente alcançaria
   * lendo a cadeia de cima para baixo; cada documento é visitado uma vez (ciclo não trava). `via` diz por onde.
   */
  attachedDoc(id: string, agentId?: string, projectId?: string): IAttachedDoc | undefined {
    const doc = this.repository.doc(id)
    if (!doc) return undefined
    const resources = RESOURCE_KINDS.flatMap((kind) => this.usableResources(kind, agentId).map((resource) => ({ kind, resource })))
    const viewer = projectId ?? this.projectOfAgent(agentId)
    const { project, agent } = this.loadedFor(projectId, agentId)
    const inPrompt = new Set([...project, ...agent].map((item) => item.id))
    const via: IAttachedDoc['via'] = []
    const seen = new Set([id])
    const queue = [doc]
    for (let node = queue.shift(); node; node = queue.shift()) {
      const child = node
      for (const { kind, resource } of resources)
        if (resource.docIds.includes(child.id) && attachable(child, resource, viewer) && !via.some((item) => item.kind === kind && item.id === resource.id))
          via.push({ kind, id: resource.id })
      for (const parent of this.repository.docsAttaching(child.id)) {
        if (seen.has(parent.id) || !attachable(child, parent, viewer)) continue
        seen.add(parent.id)
        if (inPrompt.has(parent.id) || this.readDoc(parent.id, projectId)) via.push({ kind: 'doc', id: parent.id })
        else queue.push(parent)
      }
    }
    return via.length ? { doc, via } : undefined
  }

  /**
   * O que vai no system prompt da conversa: as rules ligadas (globais, depois as do projeto, numeradas), as specs
   * inteiras do projeto e as do agente, e o índice dos documentos. `undefined` sem nada cadastrado — a seção nem
   * aparece.
   */
  environmentFor(projectId?: string, agentId?: string): string | undefined {
    const parts = this.environmentParts(projectId, agentId)
    const sections = [
      parts.rules,
      parts.projectSpecs,
      parts.agentSpecs,
      parts.skills,
      parts.triggers,
      parts.commands,
      parts.index,
      parts.ledger,
      parts.protocol,
      parts.existing,
    ].filter((part): part is string => !!part)
    return sections.length ? sections.join('\n\n') : undefined
  }

  /** As seções do ambiente separadas (a guia Tamanho do agente pesa cada uma). */
  environmentParts(projectId?: string, agentId?: string): IEnvironmentParts {
    const rules = [...this.repository.rules(null), ...(projectId ? this.repository.rules(projectId) : [])].filter((rule) => rule.enabled)
    const { project: loaded, agent: own } = this.loadedFor(projectId, agentId)
    const docs = this.visibleDocs(projectId, agentId)
    // Uma carga só: o anexo de uma spec que já está no prompt (ou de duas specs) entra uma vez.
    const seen = new Set([...loaded, ...own].map((doc) => doc.id))
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
        ...loaded.map((doc) => `### ${doc.title}\n${doc.body.trim()}${this.attachments(doc, seen, 4, projectId)}`),
      ].join('\n\n')
    }
    if (own.length) {
      parts.agentSpecs = [
        '## Specs do agente',
        'Carregadas inteiras para o seu papel, além das do projeto: valem como as regras do ambiente.',
        ...own.map((doc) => `### ${doc.title}\n${doc.body.trim()}${this.attachments(doc, seen, 4, projectId)}`),
      ].join('\n\n')
    }
    const skills = this.usableResources('skill', agentId).filter((skill) => !this.skillFilter || this.skillFilter(agentId, projectId, skill.id))
    if (skills.length) {
      parts.skills = [
        '## Skills',
        `Modos de fazer prontos para o seu trabalho. Antes de fazer algo que uma delas cobre, carregue-a inteira com ${USE_RESOURCE_TOOL} (tipo skill, pelo id) e siga o que ela diz.`,
        ...skills.map((skill) => `- ${skill.id} — ${skill.description}`),
      ].join('\n')
    }
    const triggers = this.triggersOf(agentId)
    if (triggers.length) {
      parts.triggers = [
        '## Triggers — ações sob demanda',
        `Procedimentos seus. Quando o pedido se encaixar num deles, carregue-o com ${USE_RESOURCE_TOOL} (tipo trigger, pelo id) e siga o que ele diz; não carregue os outros.`,
        ...triggers.map((trigger) => `- ${trigger.id} — ${trigger.when.trim()}`),
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
    // O índice do ledger do agente: o que ele já aprendeu, para conferir antes de diagnosticar ou operar.
    const ledger = agentId ? this.ledgerSection?.(agentId) : undefined
    if (ledger) parts.ledger = ledger
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
    this.check([], projectId ?? undefined)
    const addendum: IProtocolAddendum | undefined = text ? { kind, ...(projectId ? { projectId } : {}), body: text, updatedAt: this.now(), updatedBy: by } : undefined
    this.repository.setProtocolAddendum(kind, projectId, addendum)
    this.history.record([{ kind: 'protocol', id: protocolItemId(kind, projectId ?? undefined) }], { by })
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
      const doc = {
        kind: draft.kind,
        ...(scope ? { projectId: scope } : {}),
        title: draft.title?.trim() ?? '',
        summary: draft.summary?.trim() ?? '',
        body: draft.body ?? '',
        docIds: draft.docIds ?? [],
        ...(draft.docRefs?.length ? { docRefs: draft.docRefs } : {}),
      } as IProjectDoc
      issues.push(...docIssues(doc), ...this.attachIssues(doc, id))
      const existing = DOC_ID_PATTERN.test(id) ? this.repository.doc(id) : undefined
      if (!DOC_ID_PATTERN.test(id)) issues.unshift({ field: 'id', message: 'use 2–64 lowercase letters, digits or hyphens' })
      else if (existing && existing.kind !== draft.kind) issues.unshift({ field: 'id', message: `already taken by an ${existing.kind}: ${id}` })
      updates = !!existing && existing.kind === draft.kind
    } else if (draft.kind === 'skill' || draft.kind === 'command') {
      issues.push(
        ...this.resourceIssues({
          id,
          kind: draft.kind,
          ...(scope ? { projectId: scope } : {}),
          description: draft.description?.trim() ?? '',
          body: draft.body ?? '',
          docIds: draft.docIds ?? [],
          ...(draft.docRefs?.length ? { docRefs: draft.docRefs } : {}),
          createdAt: this.now(),
          updatedAt: this.now(),
        }),
      )
      const existing = RESOURCE_ID_PATTERN.test(id) ? this.repository.resource(id) : undefined
      if (!RESOURCE_ID_PATTERN.test(id)) issues.unshift({ field: 'id', message: 'use 2–48 lowercase letters, digits or hyphens' })
      else if (existing && existing.kind !== draft.kind) issues.unshift({ field: 'id', message: `already taken by a ${existing.kind}: ${id}` })
      updates = !!existing && existing.kind === draft.kind
    } else issues.push({ field: 'kind', message: `${draft.kind} drafts are checked by agentDraftIssues` })
    if (scope && !this.projectExists(scope)) issues.push({ field: 'projectId', message: `no such project: ${scope}` })
    return { issues, updates, ...(draft.kind !== 'rule' ? { id } : {}), ...(scope ? { projectId: scope } : {}) }
  }

  /**
   * Quem confere o REGISTRO do agente com as regras do cadastro (as mesmas do `POST /agents`): o controller, que tem o
   * catálogo de ferramentas, os providers e os modelos. Ligado na composição; sem ele, o rascunho de agente é recusado.
   */
  /** As permissões de skill (ver `Permission.Policy`): o índice do prompt só lista as que o agente pode usar no projeto. */
  useSkillFilter(filter: (agentId: string | undefined, projectId: string | undefined, skillId: string) => boolean): void {
    this.skillFilter = filter
  }

  useAgentChecker(checker: TAgentChecker): void {
    this.agentChecker = checker
  }

  /** O depósito e as pastas dos arquivos de recurso (ver `ResourceFile.Model`). Sem ele, recurso com arquivo é recusado. */
  useFiles(files: IResourceFilesPort): void {
    this.files = files
  }

  private files?: IResourceFilesPort

  /**
   * ⛔ Gancho do `sharedWith` da skill/command: roda DEPOIS de toda troca da lista (rota, restaurar, import, mudança de dono, projeto
   * apagado) — a composição apaga os valores secretos de quem saiu. Um ponto só: nenhum caminho deixa valor órfão.
   */
  useSharesChanged(hook: (id: string, projects: readonly string[]) => void): void {
    this.sharesChanged = hook
  }

  private sharesChanged?: (id: string, projects: readonly string[]) => void

  /**
   * O ledger dos agentes (ver `Ledger.Service`): a seção do índice no prompt e, ligado, as ferramentas `ledger_read` e
   * `ledger_write` em toda conversa (`hasLedger`). Ligado na composição; sem ele, nada disso.
   */
  useLedger(section: (agentId: string) => string | undefined): void {
    this.ledgerSection = section
  }

  /** Há ledger neste gateway: toda conversa ganha as duas ferramentas dele (mesmo sem contexto ainda, para criar o primeiro). */
  hasLedger(): boolean {
    return !!this.ledgerSection
  }

  private ledgerSection?: (agentId: string) => string | undefined

  private agentChecker?: TAgentChecker
  private skillFilter?: (agentId: string | undefined, projectId: string | undefined, skillId: string) => boolean

  /**
   * Os problemas do rascunho de AGENTE, sem gravar: o registro (como o `save_agent` recebe), o contexto inicial e os
   * recursos — cada um com a regra do seu cadastro, todos de uma vez. ⚖️ Id que já existe é o rascunho de um AJUSTE.
   */
  async agentDraftIssues(draft: IBuilderDraft): Promise<{ issues: TIssues; updates: boolean; id?: string; projectId?: string }> {
    const agent = draft.agent
    if (!agent || typeof agent !== 'object') return { issues: [{ field: 'agent', message: 'required: the agent record, as save_agent takes it' }], updates: false }
    if (!this.agentChecker) return { issues: [{ field: 'agent', message: 'agent drafts cannot be checked here' }], updates: false }
    const checked = await this.agentChecker(agent)
    const issues: TIssues = checked.issues.map((issue) => ({ field: `agent.${issue.field}`, message: issue.message }))
    const projectId = typeof agent.projectId === 'string' && agent.projectId ? agent.projectId : undefined
    if (draft.initialContext?.length)
      issues.push(
        ...this.specIssues(draft.initialContext, projectId, projectId ? 'another project' : 'a project (a global agent loads only global specs)').map((issue) => ({
          ...issue,
          field: 'initialContext',
        })),
      )
    if (draft.resources)
      issues.push(
        ...this.grantIssues({ skills: draft.resources.skills ?? [ALL_RESOURCES], commands: draft.resources.commands ?? [ALL_RESOURCES] }, projectId).map((issue) => ({
          ...issue,
          field: `resources.${issue.field}`,
        })),
      )
    return { issues, updates: checked.exists, ...(typeof agent.id === 'string' ? { id: agent.id } : {}), ...(projectId ? { projectId } : {}) }
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
    // Os agentes vêm da ferramenta (o catálogo de agentes não mora aqui).
    if (kind === 'agent') return ['- Consulte com list_agents (do projeto e os globais) e get_agent para um inteiro.']
    const scopes: TGuidanceScope[] = [null, ...(projectId ? [projectId] : [])]
    if (kind === 'rule')
      return scopes.flatMap((scope) =>
        this.repository.rules(scope).map((rule) => `- Rule ${rule.position} [${scope ?? 'global'}]${rule.enabled ? '' : ' (desligada)'} — ${rule.title}: ${rule.body}`),
      )
    if (kind === 'spec' || kind === 'adr' || kind === 'knowledge')
      return scopes.flatMap((scope) => this.repository.docs(scope, kind).map((doc) => `- ${doc.id} [${scope ?? 'global'}] — ${doc.title}${doc.summary ? `: ${doc.summary}` : ''}`))
    if (kind !== 'skill' && kind !== 'command') return []
    return scopes.flatMap((scope) =>
      this.repository.resources(scope, kind).map((resource) => `- ${kind === 'command' ? '/' : ''}${resource.id} [${scope ?? 'global'}] — ${resource.description}`),
    )
  }

  resources(scope: TGuidanceScope, kind?: TResourceKind): IResource[] {
    return this.repository.resources(scope, kind)
  }

  /** As skills e os commands que outros projetos compartilham com este (só leitura aqui). */
  sharedResources(projectId: string, kind?: TResourceKind): IResource[] {
    return this.repository.resourcesSharedWith(projectId, kind)
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
      ...(input.docRefs?.length ? { docRefs: input.docRefs } : {}),
      ...(input.files?.length ? { files: sortFiles(input.files) } : {}),
      ...(input.importIssues?.length ? { importIssues: input.importIssues } : {}),
      ...(input.triggers?.length ? { triggers: cleanTriggers(input.triggers) } : {}),
      ...(normalizeTags(input.tags).length ? { tags: normalizeTags(input.tags) } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = [...tagIssues(input.tags), ...this.resourceIssues(resource)]
    if (!RESOURCE_ID_PATTERN.test(resource.id)) issues.unshift({ field: 'id', message: 'use 2–48 lowercase letters, digits or hyphens' })
    else if (this.repository.resource(resource.id)) issues.unshift({ field: 'id', message: `already exists: ${resource.id}` })
    this.check(issues, resource.projectId)
    this.repository.saveResource(resource)
    this.files?.sync(resource.kind, resource.id, resource.projectId, resource.files ?? [])
    this.history.record([{ kind: resource.kind, id: resource.id }], { by })
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
      ...(input.files !== undefined ? { files: sortFiles(input.files) } : {}),
      ...(input.importIssues !== undefined ? { importIssues: input.importIssues } : {}),
      ...(input.triggers !== undefined ? { triggers: cleanTriggers(input.triggers) } : {}),
      ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    }
    if (!next.files?.length) delete next.files
    if (!next.tags?.length) delete next.tags
    if (!next.importIssues?.length) delete next.importIssues
    if (!next.triggers?.length) delete next.triggers
    // Sem `docRefs` na edição, ficam as de antes — menos as que deixaram de estar anexadas.
    const refs = input.docRefs ?? (current.docRefs ?? []).filter((docId) => next.docIds.includes(docId))
    if (refs.length) next.docRefs = refs
    else delete next.docRefs
    if (!next.projectId) delete next.projectId
    const sharedWith = sharesAfterMove(current.sharedWith, next.projectId)
    if (sharedWith.length) next.sharedWith = sharedWith
    else delete next.sharedWith
    this.check([...tagIssues(input.tags), ...this.resourceIssues(next)], next.projectId)
    this.repository.saveResource(next)
    // Mudou de escopo: a pasta muda de lugar (a do escopo antigo sai).
    if (current.projectId !== next.projectId) this.files?.remove(current.kind, id, current.projectId)
    this.files?.sync(next.kind, id, next.projectId, next.files ?? [])
    this.history.record([{ kind: next.kind, id }], { by })
    // Mudou de dono: a lista se ajustou (`sharesAfterMove`) e os valores de quem saiu vão junto.
    if (current.projectId !== next.projectId) this.sharesChanged?.(id, next.sharedWith ?? [])
    return next
  }

  /** "Resolvido" na skill ou no command (ver `resolveDocIssue`). */
  resolveResourceIssue(id: string, match: IImportProblemMatch, by: string): IResource {
    const resource = this.resource(id)
    const rest = remaining(resource.importIssues, match, `resource ${id}`)
    const next: IResource = { ...resource, updatedAt: this.now(), updatedBy: by }
    if (rest.length) next.importIssues = rest
    else delete next.importIssues
    this.repository.saveResource(next)
    this.history.record([{ kind: resource.kind, id }], { by })
    return next
  }

  /**
   * ⛔ Troca a lista INTEIRA de projetos com que a skill ou o command é compartilhado (ver `Share.Policy`). Quem pode
   * (admin da origem e de cada destino novo) o controller decide; aqui, o que o item aceita. Vai para o histórico.
   */
  shareResource(id: string, projects: readonly string[], by: string): IResource {
    const resource = this.resource(id)
    const next = normalizeShares(projects)
    this.check(shareIssues(resource, next, this.projectExists), undefined)
    const saved: IResource = { ...resource, updatedAt: this.now(), updatedBy: by }
    if (next.length) saved.sharedWith = next
    else delete saved.sharedWith
    this.repository.saveResource(saved)
    this.history.record([{ kind: resource.kind, id }], { by })
    this.sharesChanged?.(id, saved.sharedWith ?? [])
    return saved
  }

  /** O mesmo na spec e no conhecimento (ADR não se compartilha). */
  shareDoc(id: string, projects: readonly string[], by: string): IProjectDoc {
    const doc = this.doc(id)
    const next = normalizeShares(projects)
    this.check(shareIssues(doc, next, this.projectExists), undefined)
    const saved = this.repository.updateDoc(id, { sharedWith: next, updatedAt: this.now(), updatedBy: by })!
    this.history.record([{ kind: doc.kind, id }], { by })
    return saved
  }

  /** Apaga e tira o recurso dos agentes que o liberavam; cada agente atingido ganha revisão também, com o mesmo autor. */
  deleteResource(id: string, by: string): void {
    const resource = this.resource(id)
    const touched = this.history.withDependents({ kind: resource.kind, id })
    this.repository.deleteResource(id)
    this.files?.remove(resource.kind, id, resource.projectId)
    this.history.record(touched, { by })
  }

  /** O que o agente pode usar (a guia Recursos dele): sem marcação, `['*']`; "nenhum" de propósito, `[]`. */
  agentResources(agentId: string): IAgentResources {
    this.requireAgent(agentId)
    return effectiveResources(this.repository.agentResources(agentId))
  }

  /**
   * ⛔ Agente de projeto: os recursos globais, os do projeto dele e os compartilhados com ele. Agente global: só os globais — ele roda em
   * qualquer projeto. `*` sozinho = todos os que ele pode ver. Troca as duas listas inteiras.
   */
  setAgentResources(agentId: string, input: Partial<IAgentResources>, by: string): IAgentResources {
    const agent = this.requireAgent(agentId)
    const next: IAgentResources = { skills: input.skills ?? [], commands: input.commands ?? [] }
    const issues = this.grantIssues(next, agent.projectId)
    if (issues.length) throw new InvalidGuidanceError(issues)
    // Lista vazia é "nenhum" DE PROPÓSITO: gravada com a marca, senão voltaria ao padrão (todos).
    this.repository.setAgentResources(agentId, { skills: next.skills.length ? next.skills : [NO_RESOURCES], commands: next.commands.length ? next.commands : [NO_RESOURCES] }, by)
    this.history.record([{ kind: 'agent', id: agentId }], { by })
    return next
  }

  /** Os problemas de uma liberação de recursos para um agente do projeto dado (ausente = agente global). */
  private grantIssues(next: IAgentResources, projectId: string | undefined): TIssues {
    return grantIssuesIn(this.lookup, next, projectId)
  }

  /**
   * Os recursos que o agente pode usar AGORA: os que ele vê (globais e, num agente de projeto, os do projeto dele e os
   * compartilhados com ele) e
   * que a guia Recursos libera (sem marcação, todos). Sem agente, nenhum.
   */
  usableResources(kind: TResourceKind, agentId?: string): IResource[] {
    // ⛔ O construtor não usa skills nem commands: ele os ESCREVE (e o índice só pesaria no prompt dele).
    const agent = agentId && !builderKindOf(agentId) ? this.agentOf(agentId) : undefined
    if (!agent) return []
    const granted = effectiveResources(this.repository.agentResources(agent.id))[kind === 'skill' ? 'skills' : 'commands']
    if (!granted.length) return []
    // ⛔ Compartilhado: lido na hora, então parar de compartilhar (ou apagar) o tira daqui; o id liberado fica gravado e é ignorado.
    const visible = [
      ...this.repository.resources(null, kind),
      ...(agent.projectId
        ? [
            ...this.repository.resources(agent.projectId, kind),
            ...this.repository.resourcesSharedWith(agent.projectId, kind).filter((resource) => usableIn(resource, agent.projectId)),
          ]
        : []),
    ]
    return granted.includes(ALL_RESOURCES) ? visible : visible.filter((resource) => granted.includes(resource.id))
  }

  /** Os triggers do agente (o construtor não tem: ele escreve recursos, não os usa). */
  private triggersOf(agentId?: string): ReadonlyArray<{ id: string; when: string; body: string }> {
    if (!agentId || builderKindOf(agentId)) return []
    return this.agentOf(agentId)?.triggers ?? []
  }

  /** Há recurso para o `use_resource` carregar (skill, command ou trigger)? É o que liga as ferramentas no agente. */
  hasResources(agentId?: string): boolean {
    return this.usableResources('skill', agentId).length > 0 || this.usableResources('command', agentId).length > 0 || this.triggersOf(agentId).length > 0
  }

  /**
   * ⛔ O recurso inteiro — só um que o agente pode usar; outro responde como inexistente. A skill e o command vêm com os
   * documentos anexados; o command, como está (o `$ARGUMENTS` é de quem o dispara pelo `/`).
   */
  loadResource(kind: TUsableKind, id: string, agentId?: string): string | undefined {
    if (kind === 'trigger') {
      const trigger = this.triggersOf(agentId).find((item) => item.id === id) ?? this.resourceTrigger(id, agentId)
      return trigger ? `# Trigger: ${id}\n\nQuando: ${trigger.when.trim()}\n\n${trigger.body.trim()}` : undefined
    }
    const resource = this.usableResources(kind, agentId).find((item) => item.id === id)
    return resource
      ? `# ${kind === 'skill' ? 'Skill' : 'Command'}: ${resource.id}\n\n${resource.body.trim()}${triggerIndexNote(resource)}${this.attachments(resource, new Set(), 2, this.projectOfAgent(agentId))}${this.filesOf(resource)}${importIssuesNote(resource.importIssues)}`
      : undefined
  }

  /** O tipo de uma skill ou command pelo id (a regra da skill vale para os triggers dela). */
  resourceKindOf(id: string): 'skill' | 'command' | undefined {
    return this.repository.resource(id)?.kind
  }

  /**
   * ⛔ O trigger de uma skill ou command (`<recurso>/<trigger>`): só do recurso que o agente pode usar — o de outro
   * responde como inexistente, igual ao próprio recurso.
   */
  private resourceTrigger(qualified: string, agentId?: string): IAgentTrigger | undefined {
    const [resourceId, triggerId, ...rest] = qualified.split('/')
    if (!resourceId || !triggerId || rest.length) return undefined
    const resource = [...this.usableResources('skill', agentId), ...this.usableResources('command', agentId)].find((item) => item.id === resourceId)
    return resource?.triggers?.find((trigger) => trigger.id === triggerId)
  }

  /** Onde estão os arquivos do recurso, para o agente rodar os scripts (a pasta é só leitura). */
  private filesOf(resource: IResource): string {
    if (!this.files || !resource.files?.length) return ''
    return filesNote(this.files.dirOf(resource.kind, resource.id, resource.projectId), resource.files, `da ${resource.kind === 'skill' ? 'skill' : 'command'} ${resource.id}`)
  }

  /** A busca por id e descrição (o "quando", no trigger) entre o que o agente pode carregar: cada palavra tem de aparecer. */
  searchResources(query: string, kind: TUsableKind | undefined, agentId?: string): Array<{ kind: TUsableKind; id: string; description: string }> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const all = [
      ...(!kind || kind === 'skill' ? this.usableResources('skill', agentId).map((item) => ({ kind: 'skill' as const, id: item.id, description: item.description })) : []),
      ...(!kind || kind === 'command' ? this.usableResources('command', agentId).map((item) => ({ kind: 'command' as const, id: item.id, description: item.description })) : []),
      ...(!kind || kind === 'trigger' ? this.triggersOf(agentId).map((item) => ({ kind: 'trigger' as const, id: item.id, description: item.when.trim() })) : []),
      ...(!kind || kind === 'trigger'
        ? [...this.usableResources('skill', agentId), ...this.usableResources('command', agentId)].flatMap((resource) =>
            (resource.triggers ?? []).map((item) => ({ kind: 'trigger' as const, id: `${resource.id}/${item.id}`, description: item.when.trim() })),
          )
        : []),
    ]
    return all.filter((item) => words.every((word) => `${item.id} ${item.description}`.toLowerCase().includes(word)))
  }

  /**
   * `/nome argumentos` → o que vai ao modelo, com os documentos anexados. `undefined` quando a mensagem não é um
   * recurso conhecido (segue como texto). ⛔ O que existe mas não está liberado para este agente é recusado com o motivo.
   * - COMMAND: o texto dele, com `$ARGUMENTS` trocado (sem ele, os argumentos vão no fim).
   * - SKILL: a pessoa a escolheu de propósito — ela vai inteira, já carregada, com o pedido depois (sem o `use_resource`).
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
      const skill = `[A pessoa pediu a skill ${resource.id}: ela já está carregada abaixo — siga-a.]\n\n# Skill: ${resource.id}\n\n${resource.body.trim()}${triggerIndexNote(resource)}${this.attachments(resource, new Set(), 2, this.projectOfAgent(agentId))}${this.filesOf(resource)}`
      return { text: `${skill}\n\n# Pedido\n\n${args || '(sem texto: aplique a skill ao que estamos fazendo)'}`, label: text.trim(), command: id }
    }
    const body = resource.body.includes('$ARGUMENTS') ? resource.body.replace(/\$ARGUMENTS/g, args) : `${resource.body.trim()}${args ? `\n\nArgumentos: ${args}` : ''}`
    return {
      text: `${body.trim()}${triggerIndexNote(resource)}${this.attachments(resource, new Set(), 2, this.projectOfAgent(agentId))}${this.filesOf(resource)}`,
      label: text.trim(),
      command: id,
    }
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
      text: `[A pessoa anexou o documento ${doc.id} (${doc.kind}): ele está abaixo, inteiro.]\n\n# ${doc.title} [${doc.kind}]\n\n${doc.body.trim()}${this.attachments(doc, new Set([doc.id]), 2, projectId)}\n\n# Pedido\n\n${args || '(sem texto: use o documento no que estamos fazendo)'}`,
      label: text.trim(),
      command: `${kind}:${id}`,
    }
  }

  /** O projeto foi apagado: as rules e os documentos dele vão junto. */
  removeProject(projectId: string): void {
    this.repository.deleteProject(projectId)
    // ⛔ O projeto apagado sai das listas de compartilhamento dos outros (um projeto novo com o mesmo id não herda).
    for (const resource of this.repository.resourcesSharedWith(projectId)) {
      const rest = (resource.sharedWith ?? []).filter((id) => id !== projectId)
      const next: IResource = { ...resource }
      if (rest.length) next.sharedWith = rest
      else delete next.sharedWith
      this.repository.saveResource(next)
      this.sharesChanged?.(resource.id, next.sharedWith ?? [])
    }
    for (const doc of this.repository.docsSharedWith(projectId)) this.repository.updateDoc(doc.id, { sharedWith: (doc.sharedWith ?? []).filter((id) => id !== projectId) })
  }

  /**
   * ⛔ O que este documento substitui: existe, não é ele, é do MESMO tipo e do MESMO escopo (global só substitui global;
   * do projeto, só do projeto) — substituir marca o outro como substituído, e uma ADR de um projeto não pode aposentar a
   * global de todos. Sem repetir.
   */
  private supersedeIssues(doc: Pick<IProjectDoc, 'kind' | 'projectId' | 'status' | 'supersedes'>, id: string): TIssues {
    const issues: TIssues = []
    if (doc.status !== undefined && !DOC_STATUSES.includes(doc.status)) issues.push({ field: 'status', message: `one of ${DOC_STATUSES.join(', ')}` })
    const ids = doc.supersedes ?? []
    for (const [index, other] of ids.entries()) {
      const target = this.repository.doc(other)
      if (ids.indexOf(other) !== index) issues.push({ field: 'supersedes', message: `repeated: ${other}` })
      else if (other === id) issues.push({ field: 'supersedes', message: 'a document does not supersede itself' })
      else if (!target) issues.push({ field: 'supersedes', message: `no such document: ${other}` })
      else if (target.kind !== doc.kind) issues.push({ field: 'supersedes', message: `${other} is a ${target.kind}, not a ${doc.kind}` })
      else if ((target.projectId ?? null) !== (doc.projectId ?? null))
        issues.push({ field: 'supersedes', message: `${other} is in another scope (${target.projectId ?? 'global'})` })
    }
    return issues
  }

  /** Os que este substitui viram `superseded` (o arquivado fica arquivado). Devolve as chaves que mudaram, para o histórico. */
  private markSuperseded(doc: IProjectDoc, by: string): ICatalogItemKey[] {
    const changed: ICatalogItemKey[] = []
    for (const other of doc.supersedes ?? []) {
      const target = this.repository.doc(other)
      if (!target || target.status === 'superseded' || target.status === 'archived') continue
      this.repository.updateDoc(other, { status: 'superseded', updatedAt: this.now(), updatedBy: by })
      changed.push({ kind: target.kind, id: other })
    }
    return changed
  }

  /** Quem substitui este documento (o inverso de `supersedes`, no mesmo escopo). */
  supersededBy(doc: Pick<IProjectDoc, 'id' | 'projectId'>): string[] {
    return this.repository
      .docs(doc.projectId ?? null)
      .filter((other) => other.supersedes?.includes(doc.id))
      .map((other) => other.id)
  }

  /** As specs inteiras da conversa: as do projeto e as do agente — a que está nas duas fica só na do projeto. */
  private loadedFor(projectId?: string, agentId?: string): { project: IProjectDoc[]; agent: IProjectDoc[] } {
    const project = projectId ? this.initialContext(projectId) : []
    const taken = new Set(project.map((doc) => doc.id))
    return { project, agent: agentId ? this.agentContext(agentId).filter((doc) => !taken.has(doc.id)) : [] }
  }

  /** O índice da conversa: os globais, os do projeto e os compartilhados com ele, menos os que já vão inteiros no prompt. */
  private visibleDocs(projectId?: string, agentId?: string): IProjectDoc[] {
    const { project, agent } = this.loadedFor(projectId, agentId)
    const loaded = new Set([...project, ...agent].map((doc) => doc.id))
    // ⚖️ O substituído e o arquivado saem do índice: a decisão morta não compete com a viva (a busca ainda os acha).
    const shared = projectId ? this.sharedIn(projectId) : []
    return [...this.repository.docs(null), ...(projectId ? this.repository.docs(projectId) : []), ...shared].filter((doc) => !loaded.has(doc.id) && !isInactiveDoc(doc))
  }

  /**
   * As marcadas que ainda valem: spec, e global, do escopo dado ou compartilhada com ele. ⚖️ A marca do que deixou de valer
   * fica (também a de uma spec que parou de ser compartilhada): ignorada aqui, volta a entrar se voltar a valer.
   */
  private validSpecs(docIds: readonly string[], projectId: string | undefined): IProjectDoc[] {
    return docIds.map((id) => this.repository.doc(id)).filter((doc): doc is IProjectDoc => !!doc && doc.kind === 'spec' && usableIn(doc, projectId) && !isInactiveDoc(doc))
  }

  /** ⛔ Só spec, global ou do escopo dado, sem repetir. Todos os problemas de uma vez. */
  private checkSpecs(docIds: readonly string[], projectId: string | undefined, outside: string): void {
    const issues = this.specIssues(docIds, projectId, outside)
    if (issues.length) throw new InvalidGuidanceError(issues)
  }

  /** Os problemas de uma lista de contexto inicial: só spec, global ou do escopo dado, sem repetir. */
  private specIssues(docIds: readonly string[], projectId: string | undefined, outside: string): TIssues {
    return specIssuesIn(this.lookup, docIds, projectId, outside)
  }

  /**
   * Os documentos anexados a um recurso ou a um documento (os que existem e ainda cabem nele): os inteiros como seção;
   * os por referência numa lista com id, título, tamanho e resumo — o agente os lê com `read_doc` só se precisar.
   * ⚖️ Profundidade e ciclos: ver `INLINE_DEPTH`. `seen` é a carga inteira (as raízes já entram nele): quem já está
   * fica de fora, e quem entra aqui passa a estar. `level` é o nível do título das seções (`##` no recurso e no
   * `read_doc`; mais fundo quando a raiz já é uma seção do prompt).
   */
  private attachments(owner: IAttacher, seen: Set<string>, level = 2, viewer?: string): string {
    const heading = '#'.repeat(level)
    const inline: IProjectDoc[] = []
    const referenced: Array<{ doc: IProjectDoc; from?: IProjectDoc }> = []
    const take = (parent: IAttacher, depth: number, from?: IProjectDoc): IProjectDoc[] => {
      const refs = parent.docRefs ?? []
      const fresh = this.attachedTo(parent, viewer).filter((doc) => !seen.has(doc.id))
      for (const doc of fresh) {
        seen.add(doc.id)
        if (depth <= INLINE_DEPTH && !refs.includes(doc.id)) inline.push(doc)
        else referenced.push({ doc, ...(from ? { from } : {}) })
      }
      return fresh
    }
    // O primeiro nível inteiro, antes de descer: o que o dono anexa direto não vira referência por ter vindo de um filho.
    const first = take(owner, 1)
    for (const doc of first.filter((item) => inline.includes(item))) take(doc, 2, doc)
    const whole = inline.length ? `\n\n${heading} Documentos anexados\n\n${inline.map((doc) => `${heading}# ${doc.title} [${doc.kind}]\n${doc.body.trim()}`).join('\n\n')}` : ''
    if (!referenced.length) return whole
    const lines = referenced.map(
      ({ doc, from }) =>
        `- ${doc.id} — ${doc.title} [${doc.kind}] · ≈ ${estimateTokens(doc.body).toLocaleString('pt-BR')} tokens${doc.summary ? `: ${doc.summary}` : ''}${from ? ` (anexo de ${from.id})` : ''}`,
    )
    return `${whole}\n\n${heading} Documentos anexados por referência\n\nNão vieram inteiros. Leia com ${READ_DOC_TOOL} (pelo id) só o que o passo pedir.\n\n${lines.join('\n')}`
  }

  /**
   * Os anexados que ainda existem e ainda cabem em quem anexa (globais, do projeto dele ou compartilhados com ele), na
   * ordem. ⛔ `viewer`: o projeto de quem LÊ. Um item compartilhado traz só os anexos que o leitor também enxerga — o anexo
   * de outro projeto que não foi compartilhado não vaza junto.
   */
  private attachedTo(owner: IAttacher, viewer?: string): IProjectDoc[] {
    return (owner.docIds ?? []).map((id) => this.repository.doc(id)).filter((doc): doc is IProjectDoc => !!doc && attachable(doc, owner, viewer))
  }

  /** O projeto do agente (ausente = global ou sem agente). */
  private projectOfAgent(agentId?: string): string | undefined {
    return agentId ? this.agentOf(agentId)?.projectId : undefined
  }

  /** Os documentos de outro projeto compartilhados com este, só dos tipos que se compartilham. */
  private sharedIn(projectId: string): IProjectDoc[] {
    return this.repository.docsSharedWith(projectId).filter((doc) => usableIn(doc, projectId))
  }

  private attachIssues(doc: IProjectDoc, selfId: string): TIssues {
    return attachIssuesIn(this.lookup, doc, selfId)
  }

  private resourceIssues(resource: IResource): TIssues {
    return [...resourceIssuesIn(this.lookup, resource), ...this.filesIssues(resource.files)]
  }

  /** A forma da lista e o conteúdo de cada arquivo no depósito (quem grava manda o conteúdo antes). */
  filesIssues(files: readonly IResourceFile[] | undefined): TIssues {
    if (!files?.length) return []
    const shape = fileIssues(files)
    if (shape.length) return shape
    if (!this.files) return [{ field: 'files', message: 'resource files are not available on this gateway' }]
    return files.flatMap((file, index) => (this.files!.has(file.sha256) ? [] : [{ field: `files[${index}].sha256`, message: `content not uploaded: ${file.path}` }]))
  }

  /** Quem as regras de vínculo consultam: o próprio repositório. */
  private readonly lookup: IGuidanceLookup = { doc: (id) => this.repository.doc(id), resource: (id) => this.repository.resource(id) }

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

/** Os problemas que ficam depois de "resolvido"; nenhum casou: não há o que resolver (404). */
export function remaining(issues: readonly IImportProblem[] | undefined, match: IImportProblemMatch, what: string): IImportProblem[] {
  const rest = withoutProblem(issues, match)
  if (!rest) throw new GuidanceNotFoundError('import issue', `${describeMatch(match)} in ${what}`)
  return rest
}

/** Os problemas da importação no fim do texto que o agente lê (`read_doc`, `use_resource`): ele pode resolvê-los. */
export function importIssuesNote(issues: readonly IImportProblem[] | undefined): string {
  if (!issues?.length) return ''
  const lines = issues.map((issue) => `- \`${issue.code}\`${issue.target ? ` (${issue.target})` : ''}: ${issue.message}`)
  return `\n\n## Problemas da importação\n\nFicaram registrados ao importar; resolvido um, marque com \`resolve_import_issue\`.\n\n${lines.join('\n')}`
}

/**
 * ⛔ O item vale neste projeto: é global, do projeto ou compartilhado com ele. O compartilhamento só vale para os tipos
 * que se compartilham (skill, command, spec, conhecimento): ADR e rule nunca entram por ele, mesmo que uma lista de
 * `sharedWith` apareça num deles.
 */
export function usableIn(item: { kind: string; projectId?: string; sharedWith?: readonly string[] }, projectId: string | undefined): boolean {
  if (!sharedInto(item, projectId)) return visibleIn(item, projectId)
  return (SHAREABLE_DOC_KINDS as readonly string[]).includes(item.kind) || (SHAREABLE_RESOURCE_KINDS as readonly string[]).includes(item.kind)
}

/**
 * O documento cabe em quem o anexa (recurso ou outro documento): global, do projeto dele ou compartilhado com ele (só
 * leitura). ⛔ `viewer`, o projeto de quem lê: um item compartilhado só traz o anexo que o leitor também pode usar.
 */
function attachable(doc: Pick<IProjectDoc, 'kind' | 'projectId' | 'sharedWith'>, owner: IAttacher, viewer?: string): boolean {
  return usableIn(doc, owner.projectId) && (viewer === undefined || viewer === owner.projectId || usableIn(doc, viewer))
}

/**
 * Onde as regras de vínculo procuram o que é citado. O serviço usa o repositório; o plano de import, o catálogo de hoje
 * somado ao pacote (o que o pacote traz já conta como existente).
 */
export interface IGuidanceLookup {
  doc(id: string): Pick<IProjectDoc, 'kind' | 'projectId' | 'sharedWith'> | undefined
  resource(id: string): Pick<IResource, 'kind' | 'projectId' | 'sharedWith'> | undefined
}

/** Os problemas de uma liberação de recursos para um agente do projeto dado (ausente = agente global). */
export function grantIssuesIn(lookup: IGuidanceLookup, next: IAgentResources, projectId: string | undefined): TIssues {
  const issues: TIssues = []
  for (const [field, kind] of [
    ['skills', 'skill'],
    ['commands', 'command'],
  ] as const) {
    const ids = next[field]
    if (ids.includes(ALL_RESOURCES) && ids.length > 1) issues.push({ field, message: `"${ALL_RESOURCES}" goes alone` })
    for (const id of ids.filter((item) => item !== ALL_RESOURCES)) {
      const resource = lookup.resource(id)
      if (!resource || resource.kind !== kind) issues.push({ field, message: `no such ${kind}: ${id}` })
      else if (!usableIn(resource, projectId))
        issues.push({
          field,
          message: projectId ? `${id} belongs to another project (${resource.projectId})` : `${id} belongs to a project (a global agent uses only global resources)`,
        })
    }
  }
  return issues
}

/** Os problemas de uma lista de contexto inicial: só spec, global ou do escopo dado, sem repetir. */
export function specIssuesIn(lookup: IGuidanceLookup, docIds: readonly string[], projectId: string | undefined, outside: string): TIssues {
  const issues: TIssues = []
  const seen = new Set<string>()
  for (const id of docIds) {
    const doc = lookup.doc(id)
    if (seen.has(id)) issues.push({ field: 'docIds', message: `repeated: ${id}` })
    else if (!doc) issues.push({ field: 'docIds', message: `no such document: ${id}` })
    else if (doc.kind !== 'spec') issues.push({ field: 'docIds', message: `only specs load in full: ${id} is an ${doc.kind}` })
    else if (!usableIn(doc, projectId)) issues.push({ field: 'docIds', message: `${id} belongs to ${outside} (${doc.projectId})` })
    seen.add(id)
  }
  return issues
}

/**
 * Os problemas dos anexos de um documento: existe, não é ele mesmo, cabe nele (global ou do mesmo projeto — o global
 * só anexa global), sem repetir; e a referência é um dos anexados. ⚖️ Ciclo (A anexa B que anexa A) é permitido: a
 * leitura visita cada um uma vez.
 */
export function attachIssuesIn(lookup: IGuidanceLookup, doc: Pick<IProjectDoc, 'projectId' | 'docIds' | 'docRefs'>, selfId: string): TIssues {
  const issues: TIssues = []
  const ids = doc.docIds ?? []
  for (const [index, id] of ids.entries()) {
    const attached = lookup.doc(id)
    if (ids.indexOf(id) !== index) issues.push({ field: 'docIds', message: `repeated: ${id}` })
    else if (id === selfId) issues.push({ field: 'docIds', message: `a document does not attach itself: ${id}` })
    else if (!attached) issues.push({ field: 'docIds', message: `no such document: ${id}` })
    else if (!attachable(attached, doc))
      issues.push({
        field: 'docIds',
        message: doc.projectId
          ? `${id} belongs to another project (${attached.projectId})`
          : `${id} belongs to a project (${attached.projectId}): a global document attaches only global ones`,
      })
  }
  const refs = doc.docRefs ?? []
  for (const [index, id] of refs.entries()) {
    if (refs.indexOf(id) !== index) issues.push({ field: 'docRefs', message: `repeated: ${id}` })
    else if (!ids.includes(id)) issues.push({ field: 'docRefs', message: `not attached: ${id} (by reference only goes one of docIds)` })
  }
  return issues
}

/**
 * A lista dos triggers do recurso carregado: só id e "quando" — o corpo de cada um entra quando a situação acontece.
 * Vazia sem triggers.
 */
export function triggerIndexNote(resource: Pick<IResource, 'id' | 'kind' | 'triggers'>): string {
  if (!resource.triggers?.length) return ''
  const what = resource.kind === 'skill' ? 'desta skill' : 'deste command'
  return [
    '',
    '',
    `## Triggers ${what}`,
    `Procedimentos de uma situação. Quando ela acontecer, carregue o trigger com ${USE_RESOURCE_TOOL} (tipo trigger, id ${resource.id}/<trigger>) e siga-o; não carregue os outros.`,
    ...resource.triggers.map((trigger) => `- ${resource.id}/${trigger.id} — ${trigger.when.trim()}`),
  ].join('\n')
}

/** Os triggers como vieram, com o "quando" e o corpo aparados (a validação é a dos do agente, `triggerIssues`). */
function cleanTriggers(triggers: readonly IAgentTrigger[]): IAgentTrigger[] {
  return triggers.map((trigger) => ({ id: trigger.id?.trim() ?? '', when: trigger.when?.trim() ?? '', body: trigger.body ?? '' }))
}

/** Os problemas de uma skill ou command (sem o id, que tem regra própria na criação). */
export function resourceIssuesIn(lookup: IGuidanceLookup, resource: Pick<IResource, 'kind' | 'projectId' | 'description' | 'body' | 'docIds' | 'docRefs' | 'triggers'>): TIssues {
  const issues: TIssues = [...triggerIssues(resource.triggers)]
  if (!RESOURCE_KINDS.includes(resource.kind)) issues.push({ field: 'kind', message: `one of ${RESOURCE_KINDS.join(', ')}` })
  if (!resource.description) issues.push({ field: 'description', message: 'required: it is what the agent reads to know when to use it' })
  else if (resource.description.length > RESOURCE_DESCRIPTION_MAX) issues.push({ field: 'description', message: `at most ${RESOURCE_DESCRIPTION_MAX} characters` })
  if (!resource.body.trim()) issues.push({ field: 'body', message: 'required' })
  for (const id of resource.docIds) {
    const doc = lookup.doc(id)
    if (!doc) issues.push({ field: 'docIds', message: `no such document: ${id}` })
    else if (!usableIn(doc, resource.projectId)) issues.push({ field: 'docIds', message: `${id} belongs to another project (${doc.projectId})` })
  }
  const refs = resource.docRefs ?? []
  for (const [index, id] of refs.entries()) {
    if (refs.indexOf(id) !== index) issues.push({ field: 'docRefs', message: `repeated: ${id}` })
    else if (!resource.docIds.includes(id)) issues.push({ field: 'docRefs', message: `not attached: ${id} (by reference only goes one of docIds)` })
  }
  return issues
}

const EXISTING_LABEL: Readonly<Record<TProtocolKind, string>> = {
  skill: 'skills',
  command: 'commands',
  rule: 'rules',
  spec: 'specs',
  adr: 'ADRs',
  knowledge: 'conhecimento',
  agent: 'agentes',
}

/**
 * ⚖️ O CORPO NÃO TEM TETO (rule, documento, skill/command, complemento de protocolo): o tamanho é de quem escreve, e a
 * tela mostra quanto pesa em tokens. Título, resumo e descrição têm, porque são uma linha de índice ou de lista.
 */
export function ruleIssues(rule: Pick<IRule, 'title' | 'body'>): TIssues {
  const issues: TIssues = []
  if (!rule.title) issues.push({ field: 'title', message: 'required' })
  else if (rule.title.length > RULE_TITLE_MAX) issues.push({ field: 'title', message: `at most ${RULE_TITLE_MAX} characters` })
  if (!rule.body) issues.push({ field: 'body', message: 'required' })
  return issues
}

export function docIssues(doc: Pick<IProjectDoc, 'kind' | 'title' | 'summary' | 'body'>): TIssues {
  const issues: TIssues = []
  if (!DOC_KINDS.includes(doc.kind)) issues.push({ field: 'kind', message: `one of ${DOC_KINDS.join(', ')}` })
  if (!doc.title) issues.push({ field: 'title', message: 'required' })
  else if (doc.title.length > DOC_TITLE_MAX) issues.push({ field: 'title', message: `at most ${DOC_TITLE_MAX} characters` })
  if (doc.summary.length > DOC_SUMMARY_MAX) issues.push({ field: 'summary', message: `at most ${DOC_SUMMARY_MAX} characters` })
  if (!doc.body.trim()) issues.push({ field: 'body', message: 'required' })
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

const ruleKey = (id: string): ICatalogItemKey => ({ kind: 'rule', id })

/** O item mudou de escopo: o novo projeto sai da lista (é dele agora); virou global, a lista some (vale para todos). */
function sharesAfterMove(shared: readonly string[] | undefined, scope: string | null | undefined): string[] {
  return scope ? (shared ?? []).filter((id) => id !== scope) : []
}
