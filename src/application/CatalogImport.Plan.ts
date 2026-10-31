import type { TCatalogScope } from '@application/Catalog.Reader'
import { agentIssues, IAgentRules } from '@domain/Agent.Policy'
import { CORE_AGENT_IDS } from '@domain/Builder.Agents'
import { CATALOG_KINDS, ICatalogDocument, parseProtocolItemId, TCanonicalValue, TCatalogKind } from '@domain/Catalog.Document'
import type { ICatalogFilesError, ICatalogMasked } from '@domain/Catalog.Files'
import {
  attentionsOf,
  emptySummary,
  IBrokenRef,
  ICatalogImportPlan,
  IDocumentRef,
  IImportPlanItem,
  importOrder,
  IOrderInput,
  IPackageInput,
  itemRef,
  normalizeDocument,
  parsePackage,
  planHashOf,
  referencesOf,
  refOfDocument,
  TImportIssue,
  TImportOp,
  withBody,
} from '@domain/Catalog.Import'
import { wideningsOf } from '@domain/Catalog.Widening'
import { IAgent } from '@domain/models/Agent.Model'
import { AGENT_TOOL_PREFIX } from '@domain/models/Delegation.Model'
import { IMcpServerConfig, MCP_SERVER_ID_PATTERN, mcpServerKey } from '@domain/models/McpServer.Model'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { DOC_ID_PATTERN, TDocKind } from '@domain/models/ProjectDoc.Model'
import { ALL_RESOURCES, RESOURCE_ID_PATTERN, TResourceKind } from '@domain/models/Resource.Model'
import { permissionIssues } from '@domain/Permission.Policy'
import { diffText } from '@domain/Text.Diff'
import { attachIssuesIn, docIssues, grantIssuesIn, IGuidanceLookup, resourceIssuesIn, ruleIssues, specIssuesIn } from './Guidance.Service'
import { mcpScopeIssue, mcpServerIssues, McpServersService, SELF_MCP_SERVER_ID } from './McpServers.Service'
import { projectIssues } from './Projects.Service'

export { parsePackage }
export type { ICatalogImportPlan, IImportPlanItem, IPackageInput }

export interface ICatalogImportPlanDeps {
  /** O catálogo de hoje (o mesmo leitor do histórico e do export). */
  reader: { list(scope: TCatalogScope): ICatalogDocument[] }
  /** As regras do cadastro de agente, lidas AGORA (as do `PUT /agents/:id`). Ausente: todo agente a gravar vira erro. */
  agentRules?: () => Promise<Omit<IAgentRules, 'takenIds'>>
  /** O cofre dos MCPs: o que já está cadastrado para um servidor que existe. */
  mcpSecrets: Pick<McpServersService, 'secretStatus' | 'envStatus'>
}

export interface IPlanOptions {
  /** ⛔ O pedido chegou com token de acesso (CI): o plano marca que ampliação não se aplica assim. */
  viaAccessToken?: boolean
  /** O que o export mascarou (`catalog.json.masked`): o campo do pacote não é o valor real. */
  masked?: readonly ICatalogMasked[]
  /** Os arquivos do pacote fora do formato (do `parsePackage`): entram no plano e no hash. */
  fileErrors?: readonly ICatalogFilesError[]
}

type TIssues = TImportIssue[]

/** Um item durante o plano: o documento normalizado (`document`) e o que seria gravado (`target`). */
interface IDraft {
  input: ICatalogDocument
  ref: string
  op: TImportOp
  document?: ICatalogDocument
  target?: ICatalogDocument
  current?: ICatalogDocument
  issues: TIssues
  refs: IDocumentRef[]
  brokenRefs: IBrokenRef[]
  missingSecrets?: string[]
  entersDisabled?: true
}

/** O marcador da máscara de segredos do export (`Secret.Mask`). */
const MASK_MARK = '[segredo:'

const DOC_KINDS_SET: readonly TCatalogKind[] = ['spec', 'adr', 'knowledge']
const RESOURCE_KINDS_SET: readonly TCatalogKind[] = ['skill', 'command']

/** O grupo de unicidade do id: os docs dividem o espaço de ids, as skills e os commands também. */
function groupOf(kind: TCatalogKind): string {
  if (DOC_KINDS_SET.includes(kind)) return 'doc'
  if (RESOURCE_KINDS_SET.includes(kind)) return 'resource'
  return kind
}

const keyOf = (kind: TCatalogKind, id: string, projectId?: string) => `${groupOf(kind)}/${kind === 'mcp' ? mcpServerKey({ id, projectId }) : id}`
const keyOfDocument = (document: Pick<ICatalogDocument, 'kind' | 'id' | 'projectId'>) => keyOf(document.kind, document.id, document.projectId)

const text = (value: TCanonicalValue | undefined): string => (typeof value === 'string' ? value : '')
const list = (value: TCanonicalValue | undefined): string[] => (Array.isArray(value) ? value.map(String) : [])
const scopeLabel = (scope: TCatalogScope) => (scope.kind === 'project' ? `project:${scope.projectId}` : scope.kind)

function inScope(document: Pick<ICatalogDocument, 'projectId'>, scope: TCatalogScope): boolean {
  if (scope.kind === 'all') return true
  return scope.kind === 'global' ? !document.projectId : document.projectId === scope.projectId
}

/**
 * O CATÁLOGO COMO FICARIA: o de hoje com o que o pacote cria ou atualiza por cima. É onde as regras de vínculo procuram
 * o que é citado — o doc, a skill, o agente ou o MCP que vem no mesmo pacote conta como existente.
 */
class CatalogView {
  private readonly current = new Map<string, ICatalogDocument>()
  private readonly incoming = new Map<string, ICatalogDocument>()

  constructor(current: readonly ICatalogDocument[]) {
    for (const document of current) this.current.set(keyOfDocument(document), document)
  }

  currentOf(document: Pick<ICatalogDocument, 'kind' | 'id' | 'projectId'>): ICatalogDocument | undefined {
    return this.current.get(keyOfDocument(document))
  }

  bring(document: ICatalogDocument): void {
    this.incoming.set(keyOfDocument(document), document)
  }

  /** O item, e de onde vem: o pacote ganha do catálogo. */
  find(kind: TCatalogKind, id: string, projectId?: string): { document: ICatalogDocument; source: 'incoming' | 'current' } | undefined {
    const key = keyOf(kind, id, projectId)
    const incoming = this.incoming.get(key)
    if (incoming) return { document: incoming, source: 'incoming' }
    const current = this.current.get(key)
    return current ? { document: current, source: 'current' } : undefined
  }

  get(kind: TCatalogKind, id: string, projectId?: string): ICatalogDocument | undefined {
    return this.find(kind, id, projectId)?.document
  }

  /** O MCP que um agente do escopo dado alcança pelo id: o do projeto dele, senão o global (a regra de `resolve`). */
  mcp(server: string, projectId: string | undefined): { document: ICatalogDocument; source: 'incoming' | 'current' } | undefined {
    return (projectId ? this.find('mcp', server, projectId) : undefined) ?? this.find('mcp', server)
  }

  /** Os MCPs do catálogo como ficaria (para a regra de id ambíguo), menos o de `except`. */
  mcps(except: string): Array<{ id: string; projectId?: string }> {
    const keys = new Set([...this.current.keys(), ...this.incoming.keys()].filter((key) => key.startsWith('mcp/') && key !== except))
    return [...keys]
      .map((key) => this.incoming.get(key) ?? this.current.get(key)!)
      .map((document) => ({ id: document.id, ...(document.projectId ? { projectId: document.projectId } : {}) }))
  }

  readonly lookup: IGuidanceLookup = {
    doc: (id) => this.slim(this.get('spec', id)),
    resource: (id) => this.slim(this.get('skill', id)),
  }

  private slim<K extends string>(document: ICatalogDocument | undefined): { kind: K; projectId?: string } | undefined {
    return document ? { kind: document.kind as K, ...(document.projectId ? { projectId: document.projectId } : {}) } : undefined
  }
}

/**
 * O PLANO DE IMPORT (dry-run; docs/integration/plano-catalogo-historico.md §2.6, PR 8). ⛔ NADA GRAVA: lê o catálogo,
 * o cofre (só "configurado ou não") e as regras do cadastro.
 *
 * DOIS NÍVEIS (plano-importador.md): `parsePackage` (pacote de arquivos → documentos canônicos, em `Catalog.Import`) e
 * `planDocuments` (documentos canônicos → plano). O importador entra direto no segundo: o rascunho aprovado vira
 * documento canônico sem passar por arquivos. `planPackage` junta os dois.
 *
 * Por item: a operação, o diff contra o atual (`Text.Diff`), as ampliações (`Catalog.Widening`, inclusive as das
 * permissões do projeto e do MCP), as atenções, as referências quebradas, os problemas nas MESMAS regras do cadastro
 * (as funções dos serviços, com o catálogo-como-ficaria no lugar do repositório) e os segredos que faltam no cofre. E a
 * ordem de aplicação (`importOrder`) e o `planHash` (`planHashOf`).
 */
export class CatalogImportPlanner {
  constructor(private readonly deps: ICatalogImportPlanDeps) {}

  /** NÍVEL 1 + 2: o pacote do export (`.tar.gz` já aberto ou `{ manifest, files }`) → o plano. */
  async planPackage(input: IPackageInput, options: IPlanOptions & { scope?: TCatalogScope } = {}): Promise<ICatalogImportPlan> {
    const parsed = parsePackage(input.files, input.manifest)
    const scope = options.scope ?? scopeOfManifest(parsed.manifest?.scope) ?? { kind: 'all' }
    return this.planDocuments(parsed.documents, scope, {
      ...options,
      masked: [...(options.masked ?? []), ...(parsed.manifest?.masked ?? [])],
      fileErrors: [...(options.fileErrors ?? []), ...parsed.errors],
    })
  }

  /**
   * NÍVEL 2: documentos canônicos → o plano. `scope` limita o que o pacote pode tocar: documento de fora dele é erro, e
   * id que já existe fora dele é conflito. Só cria e atualiza: o que falta no pacote não é apagado (o modo espelho é
   * depois do PR 9).
   */
  async planDocuments(documents: readonly ICatalogDocument[], scope: TCatalogScope, options: IPlanOptions = {}): Promise<ICatalogImportPlan> {
    const view = new CatalogView(this.deps.reader.list({ kind: 'all' }))
    const masked = new Set((options.masked ?? []).map((item) => itemRef(item.kind, item.id, item.projectId)))
    const drafts = this.classify(documents, scope, view, masked)
    const writing = (draft: IDraft) => draft.op === 'create' || draft.op === 'update'

    // O MCP que pede segredo que o cofre não tem entra desligado (o PR 9 aplica assim): é o desligado que se compara.
    for (const draft of drafts.filter(writing)) {
      const document = draft.document!
      draft.target = document
      if (document.kind !== 'mcp') continue
      const missing = this.missingSecrets(document, draft.current)
      if (!missing.length) continue
      draft.missingSecrets = missing
      if (document.body.enabled === true) {
        draft.target = withBody(document, { ...document.body, enabled: false })
        draft.entersDisabled = true
      }
    }
    for (const draft of drafts.filter(writing)) view.bring(draft.target!)

    const rules = this.deps.agentRules ? await this.deps.agentRules() : undefined
    for (const draft of drafts.filter(writing)) {
      draft.refs = referencesOf(draft.target!)
      const issues = this.validate(draft.target!, draft.current, view, rules)
      if (issues.length) {
        draft.op = 'error'
        draft.issues.push(...issues)
      }
    }
    this.brokenRefs(drafts, view)

    // As ampliações e as atenções só de quem grava; o diff de todo item com documento que muda.
    const items: IImportPlanItem[] = drafts.map((draft) => this.item(draft, writing(draft), !!options.viaAccessToken))
    const writes = drafts.filter(writing)
    const order = importOrder(
      writes.map((draft): IOrderInput => {
        const item = items[drafts.indexOf(draft)]
        const incoming = (ref: IDocumentRef) => this.resolve(ref, view)
        const dependsOn = draft.refs.flatMap((ref) => {
          const found = incoming(ref)
          return found?.source === 'incoming' ? [refOfDocument(found.document)] : []
        })
        const linksLater =
          draft.target!.kind === 'project' &&
          draft.refs.some((ref) => ref.field === 'initialContext' && drafts.some((other) => other.op === 'create' && other.target?.kind === 'spec' && other.target.id === ref.id))
        return {
          ref: draft.ref,
          kind: draft.target!.kind,
          id: draft.target!.id,
          ...(draft.target!.projectId ? { projectId: draft.target!.projectId } : {}),
          op: draft.op as 'create' | 'update',
          widens: item.widenings.length > 0,
          dependsOn,
          ...(linksLater ? { linksLater } : {}),
        }
      }),
    )

    const summary = emptySummary()
    for (const item of items) summary[item.op]++
    const widenings = items.flatMap((item) => item.widenings)
    const brokenRefs = items.flatMap((item) => item.brokenRefs)
    const fileErrors = [...(options.fileErrors ?? [])]
    summary.widenings = widenings.length
    summary.brokenRefs = brokenRefs.length
    summary.fileErrors = fileErrors.length

    const label = scopeLabel(scope)
    return {
      scope: label,
      planHash: planHashOf({
        scope: label,
        documents: drafts.map((draft) => ({ ref: draft.ref, hash: draft.document?.hash ?? draft.input.hash })),
        fileErrors,
        current: this.usedState(drafts, view),
        items: items.map((item) => ({
          ref: item.ref,
          op: item.op,
          ...(item.hash ? { hash: item.hash } : {}),
          widenings: item.widenings.map((widening) => widening.key),
          issues: item.issues.map((issue) => `${issue.field}: ${issue.message}`),
          missingSecrets: item.missingSecrets ?? [],
        })),
      }),
      items,
      order,
      widenings,
      attentions: items.flatMap((item) => item.attentions),
      brokenRefs,
      missingSecrets: items
        .filter((item) => item.missingSecrets?.length)
        .map((item) => ({ ref: item.ref, id: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), secrets: item.missingSecrets! })),
      fileErrors,
      summary,
      caller: { viaAccessToken: !!options.viaAccessToken, wideningsApplicable: !options.viaAccessToken },
    }
  }

  /** A operação de cada documento, antes das regras: normaliza, confere o escopo, a repetição e o id. */
  private classify(documents: readonly ICatalogDocument[], scope: TCatalogScope, view: CatalogView, masked: ReadonlySet<string>): IDraft[] {
    const seen = new Set<string>()
    const drafts: IDraft[] = []
    for (const input of documents) {
      const ref = refOfDocument(input)
      const draft: IDraft = { input, ref, op: 'error', issues: [], refs: [], brokenRefs: [] }
      drafts.push(draft)
      const normalized = normalizeDocument(input)
      if (!normalized.document) {
        draft.issues.push(...normalized.issues)
        continue
      }
      const document = normalized.document
      draft.document = document
      if (seen.has(keyOfDocument(document))) {
        draft.issues.push({ field: 'id', message: `repeated in the package: ${ref}` })
        continue
      }
      seen.add(keyOfDocument(document))
      if (!inScope(document, scope)) {
        draft.issues.push({ field: 'projectId', message: `outside the plan scope (${scopeLabel(scope)})` })
        continue
      }
      const current = view.currentOf(document)
      if (current && current.kind !== document.kind) {
        draft.op = 'conflict'
        draft.issues.push({ field: 'id', message: `already used by the ${current.kind} ${current.id}` })
        continue
      }
      draft.current = current
      if (current && !inScope(current, scope)) {
        draft.op = 'conflict'
        draft.issues.push({ field: 'id', message: `already exists outside the plan scope (${current.projectId ? `project ${current.projectId}` : 'global'})` })
        continue
      }
      if (current?.hash === document.hash) {
        draft.op = 'unchanged'
        continue
      }
      // ⛔ O export mascarou um campo: o valor do pacote é o marcador, não o real. Não sobrescreve sem decisão.
      if (masked.has(ref) || document.text.includes(MASK_MARK)) {
        draft.op = 'conflict'
        draft.issues.push({ field: 'body', message: 'a field was masked by the export (secret): the package does not carry the real value' })
        continue
      }
      draft.op = current ? 'update' : 'create'
    }
    // Na ordem do catálogo (a do leitor e a do pacote): o tipo, o id, o escopo.
    const order = (draft: IDraft) => CATALOG_KINDS.indexOf(draft.input.kind)
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    return drafts.sort((a, b) => order(a) - order(b) || byText(a.input.id, b.input.id) || byText(a.input.projectId ?? '', b.input.projectId ?? ''))
  }

  /** O que o servidor pede ao cofre e ainda não está lá. Servidor novo: tudo. */
  private missingSecrets(document: ICatalogDocument, current: ICatalogDocument | undefined): string[] {
    const refs = list(document.body.secrets)
    if (!refs.length || !current) return refs
    const key = mcpServerKey({ id: document.id, projectId: document.projectId })
    try {
      const env = this.deps.mcpSecrets.envStatus(key)
      const header = this.deps.mcpSecrets.secretStatus(key).configured
      return refs.filter((ref) => (ref === 'header' ? !header : !env.some((item) => `env:${item.name}` === ref && item.configured)))
    } catch {
      return refs
    }
  }

  private resolve(ref: IDocumentRef, view: CatalogView): { document: ICatalogDocument; source: 'incoming' | 'current' } | undefined {
    switch (ref.target) {
      case 'mcp':
        return view.mcp(ref.id, ref.projectId)
      case 'doc':
      case 'spec':
        return view.find('spec', ref.id)
      default:
        return view.find(ref.target, ref.id)
    }
  }

  /**
   * As referências quebradas de cada item que grava (ou que só não grava por causa delas). ⚖️ Item que depende de outro
   * que só vem no pacote e lá não se aplica (erro, conflito) também não se aplica: até não mudar mais nada.
   */
  private brokenRefs(drafts: IDraft[], view: CatalogView): void {
    const byRef = new Map(drafts.filter((draft) => draft.document).map((draft) => [refOfDocument(draft.document!), draft]))
    const applicable = (draft: IDraft | undefined) => !!draft && (draft.op === 'create' || draft.op === 'update' || draft.op === 'unchanged')
    let changed = true
    while (changed) {
      changed = false
      for (const draft of drafts) {
        if (!draft.target) continue
        draft.brokenRefs = []
        for (const ref of draft.refs) {
          const resolved = this.resolve(ref, view)
          // A skill que o agente libera tem de ser skill (e o command, command): o id é do mesmo espaço.
          const found = resolved && (ref.target === 'skill' || ref.target === 'command') && resolved.document.kind !== ref.target ? undefined : resolved
          const from = draft.ref
          const base = { from, field: ref.field, target: ref.target, id: ref.id }
          if (!found) {
            draft.brokenRefs.push({ ...base, reason: 'missing', message: `${ref.target} ${ref.id} does not exist in the catalog nor in the package` })
            continue
          }
          if (found.source === 'incoming' && !view.currentOf(found.document) && !applicable(byRef.get(refOfDocument(found.document)))) {
            draft.brokenRefs.push({ ...base, reason: 'package-error', message: `${ref.target} ${ref.id} comes only in the package, and there it is not applied` })
            if (draft.op === 'create' || draft.op === 'update') {
              draft.op = 'error'
              draft.issues.push({ field: ref.field, message: `depends on ${refOfDocument(found.document)}, which is not applied (see that item)` })
              changed = true
            }
            continue
          }
          if (ref.target === 'mcp' && found.document.body.enabled !== true) {
            const entering = byRef.get(refOfDocument(found.document))?.entersDisabled
            draft.brokenRefs.push({
              ...base,
              reason: 'disabled',
              message: entering ? `MCP ${ref.id} comes in the package, but enters disabled (missing secret)` : `MCP ${ref.id} is disabled`,
            })
          }
        }
      }
    }
  }

  /** O estado atual usado: os itens tocados e os citados que existem hoje. */
  private usedState(drafts: readonly IDraft[], view: CatalogView): Array<{ ref: string; hash?: string }> {
    const state: Array<{ ref: string; hash?: string }> = []
    for (const draft of drafts) {
      const key = draft.document ?? draft.input
      const current = view.currentOf(key)
      state.push({ ref: refOfDocument(key), ...(current ? { hash: current.hash } : {}) })
      for (const ref of draft.refs) {
        const found = this.resolve(ref, view)
        const current = found ? view.currentOf(found.document) : undefined
        if (current) state.push({ ref: refOfDocument(current), hash: current.hash })
      }
    }
    return state
  }

  private item(draft: IDraft, writes: boolean, viaAccessToken: boolean): IImportPlanItem {
    const document = draft.target ?? draft.document
    const key = document ?? draft.input
    const widenings = writes ? wideningsOf(draft.current, draft.target) : []
    const changes = document && draft.op !== 'unchanged'
    return {
      ref: draft.ref,
      kind: key.kind,
      id: key.id,
      ...(key.projectId ? { projectId: key.projectId } : {}),
      op: draft.op,
      ...(document ? { hash: document.hash } : {}),
      ...(draft.current ? { currentHash: draft.current.hash } : {}),
      ...(changes ? { diff: diffText(draft.current?.text ?? '', document.text, { fromLabel: draft.current ? 'catalog' : 'absent', toLabel: 'package' }) } : {}),
      widenings,
      attentions: writes ? attentionsOf(draft.current, draft.target!) : [],
      issues: draft.issues,
      brokenRefs: draft.brokenRefs,
      ...(draft.missingSecrets ? { missingSecrets: draft.missingSecrets } : {}),
      ...(draft.entersDisabled ? { entersDisabled: true as const } : {}),
      ...(viaAccessToken && widenings.length ? { blockedByToken: true as const } : {}),
    }
  }

  // --- As regras do cadastro, com o catálogo-como-ficaria ----------------------------------------------------------

  private validate(document: ICatalogDocument, current: ICatalogDocument | undefined, view: CatalogView, rules: Omit<IAgentRules, 'takenIds'> | undefined): TIssues {
    const { kind, id, projectId, body } = document
    const issues: TIssues = []
    const projectIssue = () => {
      if (projectId && !view.get('project', projectId)) issues.push({ field: 'projectId', message: `no such project: ${projectId}` })
    }
    switch (kind) {
      case 'agent':
        return this.agentIssues(document, current, view, rules)
      case 'skill':
      case 'command':
        if (!RESOURCE_ID_PATTERN.test(id)) issues.push({ field: 'id', message: 'use 2–48 lowercase letters, digits or hyphens' })
        issues.push(
          ...resourceIssuesIn(view.lookup, {
            kind: kind as TResourceKind,
            ...(projectId ? { projectId } : {}),
            description: text(body.description),
            body: text(body.body),
            docIds: list(body.docIds),
            docRefs: list(body.docRefs),
          }),
        )
        projectIssue()
        return issues
      case 'spec':
      case 'adr':
      case 'knowledge':
        if (!DOC_ID_PATTERN.test(id)) issues.push({ field: 'id', message: 'use 2–64 lowercase letters, digits or hyphens' })
        issues.push(
          ...docIssues({ kind: kind as TDocKind, title: text(body.title), summary: text(body.summary), body: text(body.body) }),
          ...attachIssuesIn(view.lookup, { ...(projectId ? { projectId } : {}), docIds: list(body.docIds), docRefs: list(body.docRefs) }, id),
        )
        projectIssue()
        return issues
      case 'rule':
        issues.push(...ruleIssues({ title: text(body.title), body: text(body.body) }))
        projectIssue()
        return issues
      case 'protocol':
        if (!parseProtocolItemId(id)) issues.push({ field: 'kind', message: `not a protocol addendum: ${id}` })
        // Corpo vazio APAGA o complemento (`setProtocolAddendum`): apagar não é import.
        if (!text(body.body).trim()) issues.push({ field: 'body', message: 'required (an empty addendum would delete it)' })
        projectIssue()
        return issues
      case 'project':
        if (!PROJECT_ID_PATTERN.test(id)) issues.push({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
        issues.push(
          ...projectIssues({ name: text(body.name), ...(body.description !== undefined ? { description: text(body.description) } : {}) }),
          ...specIssuesIn(view.lookup, list(body.initialContext), id, 'another project').map((issue) => ({ ...issue, field: 'initialContext' })),
        )
        return issues
      case 'project-permissions':
        issues.push(...permissionIssues(body.rules ?? []))
        if (!view.get('project', id)) issues.push({ field: 'projectId', message: `no such project: ${id}` })
        return issues
      case 'mcp':
        return this.mcpIssues(document, current, view)
    }
  }

  private agentIssues(document: ICatalogDocument, current: ICatalogDocument | undefined, view: CatalogView, rules: Omit<IAgentRules, 'takenIds'> | undefined): TIssues {
    if (!rules) return [{ field: 'agent', message: 'agents cannot be checked here (the agent rules are not wired)' }]
    const { resources, initialContext, ...fields } = document.body
    const agent = { name: '', providers: [], systemPrompt: '', modes: [], allowedTools: [], ...fields } as unknown as IAgent
    const projectId = agent.projectId
    const issues: TIssues = []

    // O que o controller confere além do domínio (`projectIssues`): o projeto existe, sem sandbox `full` no projeto e
    // delegação só no mesmo projeto (ou a um global) — com o catálogo-como-ficaria.
    if (projectId && !view.get('project', projectId)) issues.push({ field: 'projectId', message: `no such project: ${projectId}` })
    if (projectId)
      for (const target of agent.providers.filter((candidate) => candidate.sandbox === 'full'))
        issues.push({ field: 'providers', message: `${target.provider}: a project agent cannot use the full sandbox (it would run outside the project folder)` })
    for (const entry of agent.allowedTools.filter((tool) => tool.startsWith(AGENT_TOOL_PREFIX))) {
      const target = view.get('agent', entry.slice(AGENT_TOOL_PREFIX.length))
      if (target?.projectId && target.projectId !== projectId) issues.push({ field: 'allowedTools', message: `${entry} is in another project (${target.projectId})` })
    }

    issues.push(
      ...agentIssues(agent, {
        ...rules,
        // ⛔ Criar com o id de um agente do core é recusado, como no cadastro; atualizar não toma id.
        takenIds: current ? [] : CORE_AGENT_IDS,
        // O MCP e o agente que vêm no pacote contam; o MCP, só ligado (como no cadastro).
        mcpServerExists: (server, scope) => view.mcp(server, scope)?.document.body.enabled === true,
        agentExists: (target) => {
          const found = view.find('agent', target)
          return found?.source === 'incoming' || (!!found && !!rules.agentExists?.(target))
        },
      }),
    )
    // Os vínculos: o documento traz o efetivo; ausente = todos (o padrão do cadastro).
    const links = resources && typeof resources === 'object' && !Array.isArray(resources) ? resources : undefined
    const grant = { skills: links ? list(links.skills) : [ALL_RESOURCES], commands: links ? list(links.commands) : [ALL_RESOURCES] }
    issues.push(
      ...grantIssuesIn(view.lookup, grant, projectId).map((issue) => ({ ...issue, field: `resources.${issue.field}` })),
      ...specIssuesIn(view.lookup, list(initialContext), projectId, projectId ? 'another project' : 'a project (a global agent loads only global specs)').map((issue) => ({
        ...issue,
        field: 'initialContext',
      })),
    )
    return issues
  }

  private mcpIssues(document: ICatalogDocument, current: ICatalogDocument | undefined, view: CatalogView): TIssues {
    const { id, projectId, body } = document
    const config = {
      ...(body as unknown as IMcpServerConfig),
      kind: (text(body.kind) || 'remote') as IMcpServerConfig['kind'],
      url: text(body.url),
      transport: text(body.transport) || 'auto',
      auth: text(body.auth) || 'none',
    } as IMcpServerConfig
    const issues: TIssues = mcpServerIssues(config)
    if (!MCP_SERVER_ID_PATTERN.test(id)) issues.unshift({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
    else {
      const scope = mcpScopeIssue(id, projectId, view.mcps(keyOf('mcp', id, projectId)))
      if (scope) issues.unshift({ field: 'id', message: scope })
    }
    if (projectId && !view.get('project', projectId)) issues.unshift({ field: 'projectId', message: `no such project: ${projectId}` })
    if (current && (text(current.body.kind) || 'remote') !== config.kind)
      issues.push({
        field: 'kind',
        message: `the server is now "${text(current.body.kind) || 'remote'}" and the package says "${config.kind}": the kind does not change by import`,
      })
    if (id === SELF_MCP_SERVER_ID && !projectId && current) {
      if (text(current.body.url) !== config.url) issues.push({ field: 'url', message: 'the gateway server URL is fixed' })
      if (text(current.body.auth) !== text(body.auth) || text(current.body.headerName) !== text(body.headerName))
        issues.push({ field: 'auth', message: "the gateway server always uses the caller's credential" })
    }
    return issues
  }
}

/** O escopo do manifesto (`all`, `global`, `project:<id>`); o que não se reconhece fica de fora. */
export function scopeOfManifest(scope: string | undefined): TCatalogScope | undefined {
  if (scope === 'all' || scope === 'global') return { kind: scope }
  if (scope?.startsWith('project:')) {
    const projectId = scope.slice('project:'.length)
    return PROJECT_ID_PATTERN.test(projectId) ? { kind: 'project', projectId } : undefined
  }
  return undefined
}
