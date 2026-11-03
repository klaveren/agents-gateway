import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { lanesOf } from '@domain/Subscription.Policy'
import { createHash } from 'node:crypto'
import { ICatalogDocument, TCanonicalValue, TCatalogKind } from '@domain/Catalog.Document'
import { ICatalogImportPlan, refOfDocument, TRefTarget, withBody } from '@domain/Catalog.Import'
import { IApprovedEntry, IAgentExtras, importDocuments } from '@domain/Import.Documents'
import { ILinkWorld, restoreImportLinks, withImportIssues } from '@domain/Import.Issues'
import { IImportProblem, problemList } from '@domain/models/ImportProblem.Model'
import { currentRuleIssues, draftKindForItem, IImportDraft, verifyImportDraft } from '@domain/Import.Draft'
import { canTransition } from '@domain/Import.Job'
import { planAgentBatch, prefixedId } from '@domain/Import.Order'
import { confirmedRules, IReachTranslation, ruleKey } from '@domain/Import.Permissions'
import { TInventoryKind } from '@domain/models/ImportInventory.Model'
import { IImportJobItem, TImportItemState } from '@domain/models/ImportJob.Model'
import { IPermissionRule } from '@domain/Permission.Policy'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'
import type { CatalogReader, TCatalogScope } from './Catalog.Reader'
import type { CatalogImportApplier, IImportApplyResult } from './CatalogImport.Apply'
import type { IRestoreCaller } from './CatalogRestore.Usecase'
import { draftSources, IImportSourceFile, ImportBuildError, lastDraft } from './ImportBuild.Service'
import type { ImportScanUseCase } from './ImportScan.Usecase'
import { importFilesOf } from '@domain/Import.Files'
import { IResourceFile, RESOURCE_FILE_MAX_BYTES, sortFiles } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'

/** O que a pessoa escolhe na tela de gravação. */
export interface IImportApplySelection {
  /** Um lote salvo do trabalho: os aprovados dele. */
  batchId?: string
  /** Ou as chaves (os aprovados entre elas). Sem nenhum dos dois: todos os aprovados do trabalho. */
  keys?: readonly string[]
  /**
   * Por agente (a chave do item): as regras AMPLAS do tradutor que a pessoa INCLUIU (`ruleKey`). ⛔ Padrão: nenhuma — o
   * agente nasce sem elas. Incluída ou não, toda liberação ainda passa pela confirmação de ampliação do catálogo.
   */
  wide?: Readonly<Record<string, readonly string[]>>
  /** Por agente (a chave do item): o modelo que ele vai usar (o agente novo precisa de um). */
  models?: Readonly<Record<string, { provider: string; model: string }>>
  /**
   * Só os PRONTOS: o item com documento bloqueado (erro ou conflito no plano) fica de fora, com o motivo, em `heldBack`.
   * ⚖️ Quem só CITAVA o que ficou de fora não vai junto: entra sem o vínculo, com o problema `link-pending` registrado
   * nele (ver `Import.Issues`), e o vínculo volta quando o citado for gravado.
   */
  ready?: boolean
}

/** Uma regra do alcance proposto: a do tradutor, se é ampla, e se entra. */
export interface IReachRuleView {
  key: string
  rule: IPermissionRule
  /** Ampla (terminal com qualquer comando, `read **`, servidor MCP inteiro, `*`…): só entra se a pessoa incluir. */
  wide?: string
  included: boolean
  /** Fica de fora mesmo incluída: cita um agente ou servidor MCP que não existe (o problema guardado no agente). */
  held?: string
}

/** O agente na gravação: o modelo, e o alcance traduzido com o que entra. */
export interface IImportApplyAgent {
  key: string
  id: string
  exists: boolean
  /** O modelo escolhido (ou o do agente que já existe). */
  model?: { provider: string; model: string }
  rules: IReachRuleView[]
  allowedTools: string[]
  /** `resources.skills`: as que ele libera e existem (ou entram no lote); `pendingSkills`: as que faltam. */
  skills: string[]
  pendingSkills: string[]
  commands: string[]
  /** De onde veio o alcance: o tradutor do opencode, ou nada (nasce fechado e o alcance é escolhido na tela do agente). */
  reach: 'opencode' | 'none'
  notes: string[]
}

export interface IImportApplyPreview {
  jobId: string
  repository: string
  head?: string
  /** `project:<id>` (ou `all`, quando um item é global por escolha). */
  scope: string
  /** Os aprovados que viram documento, e quais; `issues`: os problemas da importação com que cada documento dele é gravado (não bloqueiam). */
  items: Array<{ key: string; kind: string; refs: string[]; issues?: Array<IImportProblem & { ref: string }> }>
  /** Os artefatos do catálogo que recebem de volta um vínculo pendente (o alvo entra nesta gravação), e os problemas que saem. */
  resolved: Array<{ ref: string; issues: IImportProblem[] }>
  /** Os escolhidos que não entram, e por quê (não aprovados, trigger sem agente…). */
  skipped: Array<{ key: string; reason: string }>
  agents: IImportApplyAgent[]
  /** Os modelos ativos no gateway, para o agente novo escolher. */
  models: Array<{ provider: string; models: string[] }>
  /** O plano do catálogo sobre os documentos: diff, ampliações, referências quebradas, segredos, ordem e `planHash`. */
  plan: ICatalogImportPlan
  /** O que falta (nem no catálogo, nem no pacote), com o item do trabalho que o produz, quando há. */
  missing: IImportMissingRef[]
  /** Com `ready`: os itens que ficaram de fora por bloqueio (o deles ou o de quem citam), e o motivo. */
  heldBack: Array<{ key: string; ref: string; reason: string }>
}

/** Uma referência que falta no catálogo e no pacote, e o item do trabalho que a resolve (ausente: não vem deste repositório). */
export interface IImportMissingRef {
  target: TRefTarget
  id: string
  /** Quem cita (`knowledge/x`). */
  from: string[]
  item?: { key: string; kind: TInventoryKind; state: TImportItemState; path: string }
  /** Sem documento com o id, mas um item de outro tipo tem (um command): o vínculo está errado, não a falta. */
  wrongKind?: { key: string; kind: TInventoryKind }
  /** As chaves do trabalho de quem cita (para pedir ajuste no rascunho). */
  fromKeys: string[]
}

/** Os tipos do inventário que produzem cada alvo de referência (o `doc` é qualquer documento de texto). */
const KINDS_OF_TARGET: Partial<Record<TRefTarget, readonly TInventoryKind[]>> = {
  doc: ['spec', 'adr', 'knowledge'],
  spec: ['spec'],
  skill: ['skill'],
  command: ['command'],
  agent: ['agent'],
  mcp: ['mcp'],
}

export interface IImportApplyOutcome extends IImportApplyResult {
  /** Os itens do trabalho que viraram `applied`; os outros continuam `approved`. */
  items: { applied: string[]; notApplied: string[] }
}

export interface IImportApplyDeps {
  repository: IImportRepository
  /** ⛔ Lê um arquivo do repositório DESTE projeto, contido e mascarado (o mesmo do construtor). */
  readSource: (projectId: string, repository: string, path: string) => IImportSourceFile | undefined
  scan: Pick<ImportScanUseCase, 'inventory' | 'catalogState'>
  catalog: Pick<CatalogImportApplier, 'plan' | 'apply'>
  reader: Pick<CatalogReader, 'read' | 'list'>
  /** Os modelos ativos (provider → modelos ligados). Ausente: nenhum listado. */
  models?: () => Array<{ provider: string; protocol?: EProvider; models: string[] }>
  now?: () => Date
  /**
   * Os ARQUIVOS de recurso (ver `Import.Files`): os bytes crus de um arquivo do repositório (contido), o depósito e os
   * segredos de um texto. Ausentes: a importação não leva arquivo.
   */
  readRaw?: (projectId: string, repository: string, path: string) => Buffer | undefined
  files?: Pick<IResourceFilesPort, 'put'>
  secretsIn?: (text: string) => string[]
}

interface IPrepared {
  record: IImportJobRecord
  scope: TCatalogScope
  documents: ICatalogDocument[]
  produced: Record<string, string[]>
  entries: IApprovedEntry[]
  skipped: Array<{ key: string; reason: string }>
  agents: Array<{ view: IImportApplyAgent; extras: IAgentExtras }>
  /** Todos os itens do trabalho e o prefixo do lote: para achar quem produz o que falta. */
  all: IImportJobItem[]
  prefix: string
  /** O conteúdo dos arquivos de recurso que vão junto: entra no depósito antes da gravação. */
  blobs: Buffer[]
  projectId: string
  /** O catálogo de hoje: onde os vínculos procuram o citado, e os pendentes que podem voltar. */
  snapshot: ICatalogDocument[]
}

/** Os documentos como vão ao plano: os vínculos que valem, os problemas, e os artefatos do catálogo com vínculo de volta. */
interface ILinked {
  documents: ICatalogDocument[]
  resolved: IImportApplyPreview['resolved']
}

const DOC_KINDS: readonly string[] = ['spec', 'adr', 'knowledge']
const RESOURCE_KINDS: readonly string[] = ['skill', 'command']
/** Os campos dos vínculos que a importação tira do documento (ver `Import.Issues`). */
const LINK_FIELDS: readonly string[] = ['docIds', 'docRefs', 'initialContext', 'resources.skills', 'resources.commands']

/**
 * A GRAVAÇÃO DO IMPORTADOR pelo caminho do catálogo (`docs/integration/plano-importador.md` §2.4, PR 9): os itens
 * APROVADOS de um trabalho (ou de um lote salvo dele) viram documentos canônicos, que seguem pelo plano e pelo apply do
 * catálogo — um caminho de escrita só, com a mesma trava de ampliação, as revisões e a reversão de lote.
 *
 * ⛔ NADA AUTOMÁTICO: `preview` só lê; `apply` só grava com o clique (o `planHash` do plano visto) e as confirmações
 * (`confirm`, uma caixa por ampliação), e só por admin na tela (token de acesso recebe 403 na ampliação).
 *
 * ⛔ O TEXTO NÃO MUDA: antes de gerar o documento, cada rascunho é conferido de novo contra a fonte NO DISCO (o mesmo
 * `sha256` do trabalho e o mesmo texto final de fonte + operações). Fonte mudada recusa tudo: analise de novo.
 *
 * ⛔ O AGENTE NASCE FECHADO: as regras amplas do tradutor ficam de fora a não ser que a pessoa as inclua, uma a uma; o
 * alcance (ferramentas e permissões) entra num passo à parte, depois de todos os agentes (fase `reach` do catálogo), e
 * cada liberação é uma ampliação a confirmar. `resources.skills` = as skills que ele libera, nunca `*`.
 */
export class ImportApplyUseCase {
  constructor(private readonly deps: IImportApplyDeps) {}

  async preview(projectId: string, jobId: string, selection: IImportApplySelection, caller?: Pick<IRestoreCaller, 'viaAccessToken'>): Promise<IImportApplyPreview> {
    const { prepared, documents, resolved, plan, heldBack } = await this.planned(this.prepare(projectId, jobId, selection), !!selection.ready, !!caller?.viaAccessToken)
    const issuesOf = (refs: readonly string[]) =>
      documents
        .filter((document) => refs.includes(refOfDocument(document)))
        .flatMap((document) => problemList(document.body.importIssues).map((issue) => ({ ...issue, ref: refOfDocument(document) })))
    return {
      jobId: prepared.record.id,
      repository: prepared.record.repository,
      ...(prepared.record.head ? { head: prepared.record.head } : {}),
      scope: plan.scope,
      items: prepared.entries
        .filter((entry) => prepared.produced[entry.key])
        .map((entry) => {
          const issues = issuesOf(prepared.produced[entry.key])
          return { key: entry.key, kind: entry.kind, refs: prepared.produced[entry.key], ...(issues.length ? { issues } : {}) }
        }),
      resolved,
      skipped: prepared.skipped,
      agents: prepared.agents.map((agent) => agent.view),
      models: this.deps.models?.() ?? [],
      plan,
      missing: missingRefs(plan, prepared.all, prepared.prefix, prepared.produced),
      heldBack,
    }
  }

  /**
   * O plano do catálogo sobre os documentos, até não mudar mais nada. O que bloqueia (erro, conflito) sai dos VÍNCULOS
   * dos outros: quem o citava entra sem o vínculo, com `link-pending` (a cascata não segura mais ninguém). Com `ready`,
   * o item bloqueado sai também do plano (`heldBack`); sem, fica nele, com o erro, e a gravação é recusada. O artefato do
   * catálogo cujo vínculo voltaria e não passa no plano fica como está. O mesmo cálculo na prévia e na gravação: o
   * `planHash` confere.
   */
  private async planned(
    prepared: IPrepared,
    ready: boolean,
    viaAccessToken: boolean,
  ): Promise<{ prepared: IPrepared; documents: ICatalogDocument[]; resolved: ILinked['resolved']; plan: ICatalogImportPlan; heldBack: IImportApplyPreview['heldBack'] }> {
    const heldBack: IImportApplyPreview['heldBack'] = []
    const excluded = new Set<string>()
    const keepAsIs = new Set<string>()
    let current = prepared
    for (;;) {
      const linked = this.linked(current, excluded, keepAsIs)
      const { plan } = await this.deps.catalog.plan({ documents: linked.documents, scope: current.scope }, { viaAccessToken })
      const done = { prepared: current, documents: linked.documents, resolved: linked.resolved, plan, heldBack }
      const failing = plan.items.filter((item) => item.op === 'error' || item.op === 'conflict')
      if (!failing.length) return done
      // ⚖️ Só a RAIZ do bloqueio sai nesta volta: o item com problema que não é de vínculo. Quem só tem problema de
      // vínculo (cita outro do lote que não se aplica) espera — na volta seguinte o vínculo dele já saiu. Sem raiz,
      // saem todos.
      const roots = failing.filter((item) => item.issues.some((issue) => !LINK_FIELDS.includes(issue.field)))
      const blocked = new Map((roots.length ? roots : failing).map((item) => [item.ref, item.issues[0]?.message ?? item.op]))
      let changed = false
      for (const { ref } of linked.resolved)
        if (blocked.has(ref) && !keepAsIs.has(ref)) {
          keepAsIs.add(ref)
          changed = true
        }
      const held = new Set<string>()
      for (const [key, refs] of Object.entries(current.produced)) {
        const ref = refs.find((one) => blocked.has(one))
        if (!ref) continue
        for (const one of refs)
          if (!excluded.has(one)) {
            excluded.add(one)
            changed = true
          }
        if (!ready) continue
        held.add(key)
        heldBack.push({ key, ref, reason: blocked.get(ref)! })
        changed = true
      }
      // Nada mais a tirar (o bloqueio não é de um item, ou já saiu dos vínculos): o plano volta como está.
      if (!changed) return done
      if (held.size)
        current = {
          ...current,
          documents: current.documents.filter((document) => !excluded.has(refOfDocument(document))),
          produced: Object.fromEntries(Object.entries(current.produced).filter(([key]) => !held.has(key))),
          entries: current.entries.filter((entry) => !held.has(entry.key)),
        }
    }
  }

  /**
   * Os vínculos de cada documento contra o que esta gravação escreve (menos os `excluded`) e o catálogo de hoje: o que
   * não vale sai e vira problema no documento (`Import.Issues`). E os artefatos do catálogo, do projeto, com vínculo
   * pendente para o que entra agora: voltam com ele (menos os `keepAsIs`).
   */
  private linked(prepared: IPrepared, excluded: ReadonlySet<string>, keepAsIs: ReadonlySet<string>): ILinked {
    const writing = prepared.documents.filter((document) => !excluded.has(refOfDocument(document)))
    const writtenDocs = new Map(writing.filter((document) => DOC_KINDS.includes(document.kind)).map((document) => [document.id, document.kind as string]))
    const writtenResources = new Map(writing.filter((document) => RESOURCE_KINDS.includes(document.kind)).map((document) => [document.id, document.kind as string]))
    const byId = (kinds: readonly string[]) => new Map(prepared.snapshot.filter((document) => kinds.includes(document.kind)).map((document) => [document.id, document]))
    const catalogDocs = byId(DOC_KINDS)
    const catalogResources = byId(RESOURCE_KINDS)
    const catalogOthers = byId(['agent', 'mcp'])
    // O alcance do agente cita agentes e servidores MCP: os que existem ou entram agora (o MCP, com o escopo).
    const agentIds = new Set([...writing, ...prepared.snapshot].filter((document) => document.kind === 'agent').map((document) => document.id))
    const mcps = [...writing, ...prepared.snapshot].filter((document) => document.kind === 'mcp')
    const slim = (document: ICatalogDocument | undefined) => (document ? { kind: document.kind, ...(document.projectId ? { projectId: document.projectId } : {}) } : undefined)
    // Os ids que cada item do trabalho tem no gateway (o do rascunho, o escolhido, o proposto com o prefixo, o candidato).
    const idsOf = (one: IImportJobItem) => {
      const kind = one.kind ?? one.item.kind
      return [lastDraft(one)?.outputs[0]?.meta.id, one.targetId, prefixedId(kind, one.item.candidateId, prepared.prefix).id, one.item.candidateId].filter(Boolean) as string[]
    }
    const jobKinds = new Map<string, string>()
    for (const one of prepared.all) for (const id of idsOf(one)) if (!jobKinds.has(id) || DOC_KINDS.includes(one.kind ?? one.item.kind)) jobKinds.set(id, one.kind ?? one.item.kind)
    const excludedDocs = new Set(prepared.documents.filter((document) => excluded.has(refOfDocument(document)) && DOC_KINDS.includes(document.kind)).map((document) => document.id))
    const world: ILinkWorld = {
      projectId: prepared.projectId,
      writtenDocs,
      writtenResources,
      catalogDoc: (id) => slim(catalogDocs.get(id)),
      catalogResource: (id) => slim(catalogResources.get(id)),
      pendingDoc: (id) => excludedDocs.has(id) || DOC_KINDS.includes(jobKinds.get(id) ?? ''),
      otherKind: (id) => jobKinds.get(id) ?? catalogResources.get(id)?.kind ?? catalogOthers.get(id)?.kind,
      agentExists: (id) => agentIds.has(id),
      mcpExists: (id, projectId) => mcps.some((mcp) => mcp.id === id && (!mcp.projectId || mcp.projectId === projectId)),
    }
    const documents = prepared.documents.map((document) => withImportIssues(document, world))

    // O agente na tela: as skills e os commands que ele libera de fato, e os pendentes; as regras e as ferramentas que
    // ficaram de fora por citar o que não existe.
    for (const agent of prepared.agents) {
      const document = documents.find((one) => one.kind === 'agent' && one.id === agent.view.id)
      const reach = problemList(document?.body.importIssues).filter((issue) => issue.link === 'reach')
      for (const rule of agent.view.rules) {
        const issue = reach.find((one) => one.rules?.some((held) => ruleKey(held) === rule.key))
        if (issue) rule.held = issue.message
        else delete rule.held
      }
      if (document) agent.view.allowedTools = agent.extras.allowedTools.filter((tool) => !reach.some((issue) => issue.tools?.includes(tool)))
      const resources = document?.body.resources as { skills?: string[]; commands?: string[] } | undefined
      if (!resources) continue
      agent.view.skills = resources.skills ?? []
      agent.view.commands = resources.commands ?? []
      agent.view.pendingSkills = agent.extras.skills.filter((id) => !agent.view.skills.includes(id))
    }

    const incoming = new Set(documents.map(refOfDocument))
    const written = {
      docs: new Set(writtenDocs.keys()),
      skills: kindIds(writtenResources, 'skill'),
      commands: kindIds(writtenResources, 'command'),
      agents: new Set(writing.filter((document) => document.kind === 'agent').map((document) => document.id)),
      mcps: new Set(writing.filter((document) => document.kind === 'mcp').map((document) => document.id)),
    }
    const resolved: ILinked['resolved'] = []
    const restored: ICatalogDocument[] = []
    for (const document of prepared.snapshot) {
      const ref = refOfDocument(document)
      if (document.projectId !== prepared.projectId || incoming.has(ref) || keepAsIs.has(ref) || !document.body.importIssues) continue
      const back = restoreImportLinks(document, written)
      if (!back) continue
      const left = problemList(back.body.importIssues)
      resolved.push({ ref, issues: problemList(document.body.importIssues).filter((one) => !left.some((other) => other.code === one.code && other.target === one.target)) })
      restored.push(back)
    }
    return { documents: [...documents, ...restored], resolved }
  }

  async apply(
    projectId: string,
    jobId: string,
    request: IImportApplySelection & { planHash: string; confirm?: readonly string[] },
    caller: IRestoreCaller,
  ): Promise<IImportApplyOutcome> {
    const { prepared, documents, resolved, heldBack } = await this.planned(this.prepare(projectId, jobId, request), !!request.ready, !!caller.viaAccessToken)
    const { record, produced } = prepared
    const provenance = {
      importJob: record.id,
      repository: record.repository,
      ...(record.head ? { head: record.head } : {}),
      items: prepared.entries.filter((entry) => produced[entry.key]).map((entry) => ({ key: entry.key, refs: produced[entry.key], sources: entry.draft.sources })),
      ...(resolved.length ? { resolved: resolved.map((one) => one.ref) } : {}),
    }
    // O conteúdo dos arquivos entra no depósito ANTES: a gravação confere que cada um está lá.
    for (const blob of prepared.blobs) this.deps.files?.put(blob)
    const result = await this.deps.catalog.apply(
      { documents, scope: prepared.scope, planHash: request.planHash, ...(request.confirm ? { confirm: request.confirm } : {}), provenance },
      caller,
    )

    // O item está gravado quando TODOS os documentos dele entraram (o último passo de cada um) ou já estavam iguais.
    const done = new Set(result.applied.filter((step) => step.part !== 'record').map((step) => step.ref))
    const pending = new Set([...(result.failed ? [result.failed.ref] : []), ...result.pending.map((step) => step.ref)])
    const at = (this.deps.now ?? (() => new Date()))()
    // O que ficou de fora por bloqueio (`ready`) não foi gravado: continua aprovado.
    const items = { applied: [] as string[], notApplied: [...new Set(heldBack.map((one) => one.key))] }
    for (const entry of prepared.entries) {
      const refs = produced[entry.key]
      if (!refs) continue
      const ok = refs.every((ref) => !pending.has(ref) && (done.has(ref) || !result.failed))
      const current = this.deps.repository.item(record.id, entry.key)
      if (!ok || !current || !canTransition(current.state, 'applied')) {
        items.notApplied.push(entry.key)
        continue
      }
      this.deps.repository.updateItem(record.id, entry.key, { state: 'applied', ...(result.batch ? { batchId: result.batch.id } : {}), by: caller.by, at })
      items.applied.push(entry.key)
    }
    return { ...result, items }
  }

  // --- A montagem ---------------------------------------------------------------------------------------------------

  private prepare(projectId: string, jobId: string, selection: IImportApplySelection): IPrepared {
    const record = this.deps.repository.get(projectId, jobId)
    if (!record) throw new ImportBuildError('not_found', `import job not found: ${jobId}`)
    const all = this.deps.repository.items(record.id)
    const byKey = new Map(all.map((entry) => [entry.key, entry]))
    const batch = selection.batchId ? this.deps.repository.batch(record.id, selection.batchId) : undefined
    if (selection.batchId && !batch) throw new ImportBuildError('not_found', `batch not found in this import job: ${selection.batchId}`, 'batchId')
    const prefix = batch?.prefix ?? ''
    const explicit = batch ? [...new Set([...batch.order, ...batch.keys])] : selection.keys ? [...new Set(selection.keys)] : undefined
    const skipped: IPrepared['skipped'] = []
    const chosen: IImportJobItem[] = []
    for (const key of explicit ?? all.map((entry) => entry.key)) {
      const entry = byKey.get(key)
      if (!entry) {
        skipped.push({ key, reason: 'não está neste trabalho' })
        continue
      }
      // ⛔ Saiu da fonte: não há fonte para conferir o rascunho. Fica de fora com o motivo (a gravação dos outros segue).
      if (entry.goneAt) {
        if (explicit || entry.state === 'approved') skipped.push({ key, reason: 'saiu da fonte: o item não está mais no repositório' })
        continue
      }
      if (entry.state !== 'approved') {
        if (explicit && entry.state !== 'applied') skipped.push({ key, reason: `estado ${entry.state}: só o aprovado é gravado` })
        continue
      }
      chosen.push(entry)
    }

    // ⛔ O rascunho conferido de novo contra o disco: a mesma fonte (sha256) e o mesmo texto final.
    const entries: IApprovedEntry[] = []
    for (const entry of chosen) {
      const draft = lastDraft(entry)
      const kind = draftKindForItem(entry.kind ?? entry.item.kind)
      if (!draft || !kind || draft.kind !== kind) {
        skipped.push({ key: entry.key, reason: 'sem rascunho do tipo do item' })
        continue
      }
      // ⛔ Aprovado antes das regras de hoje (a rule de 43 KB): fica de fora, com o motivo — peça ajuste ao construtor.
      const current = currentRuleIssues(kind, draft.outputs)
      if (current.length) {
        skipped.push({ key: entry.key, reason: `o rascunho não passa nas regras de hoje (${current.map((one) => one.message).join('; ')}): peça ajuste ao construtor` })
        continue
      }
      const issues = verifyImportDraft(draft, this.sourceTexts(record, entry, draft))
      if (issues.length) throw new ImportBuildError('invalid', `the draft of ${entry.key} does not match source + operations`, 'key', issues)
      entries.push({ key: entry.key, kind, ...(entry.item.parent ? { parent: entry.item.parent } : {}), draft })
    }

    const idOfKey = (key: string): string | undefined => {
      const approved = entries.find((entry) => entry.key === key)
      if (approved) return approved.draft.outputs[0].meta.id
      const entry = byKey.get(key)
      return entry ? (entry.targetId ?? prefixedId(entry.kind ?? entry.item.kind, entry.item.candidateId, prefix).id) : undefined
    }

    const agents = this.agents(record, entries, byKey, prefix, selection, idOfKey)
    const extras = new Map(agents.map((agent) => [agent.view.key, agent.extras]))
    const scopeRules = (projectId: string | undefined) =>
      this.deps.reader.list(projectId ? { kind: 'project', projectId } : { kind: 'global' }).filter((document) => document.kind === 'rule' && document.projectId === projectId)
    const built = importDocuments({
      projectId,
      entries,
      current: (kind: TCatalogKind, id: string) => this.deps.reader.read(kind, id),
      ruleByTitle: (title, scope) => scopeRules(scope).find((rule) => rule.body.title === title),
      ruleCount: (scope) => scopeRules(scope).length,
      agentIdOf: (agentKey) => idOfKey(agentKey),
      agent: (agentKey) => extras.get(agentKey)!,
    })

    // ⚖️ Os vínculos (docs citados, as skills e os commands liberados) são decididos no plano (`linked`): dependem do que
    // entra de fato nesta gravação.
    const blobs: Buffer[] = []
    const documents = built.documents.map((document) => this.withFiles(record, document, built.produced, byKey, all, skipped, blobs))
    const global = documents.some((document) => !document.projectId && document.kind !== 'project')
    return {
      record,
      scope: global ? { kind: 'all' } : { kind: 'project', projectId },
      documents,
      produced: built.produced,
      entries,
      skipped: [...skipped, ...built.skipped],
      agents,
      all,
      prefix,
      blobs,
      projectId,
      snapshot: this.deps.reader.list({ kind: 'all' }),
    }
  }

  /**
   * O documento da skill ou do agente com os ARQUIVOS do repositório (ver `Import.Files`), conferidos: o mesmo `sha256`
   * da análise (senão, "analise de novo"), só texto, até 1 MB e sem segredo — o que não passa fica de fora, com o motivo.
   * Sem arquivo no repositório, ficam os que o recurso já tem no catálogo (os da guia Arquivos).
   */
  private withFiles(
    record: IImportJobRecord,
    document: ICatalogDocument,
    produced: Record<string, string[]>,
    byKey: ReadonlyMap<string, IImportJobItem>,
    all: readonly IImportJobItem[],
    skipped: IPrepared['skipped'],
    blobs: Buffer[],
  ): ICatalogDocument {
    if (!this.deps.readRaw || (document.kind !== 'skill' && document.kind !== 'agent')) return document
    const ref = refOfDocument(document)
    const key = Object.keys(produced).find((one) => produced[one].includes(ref) && (byKey.get(one)?.kind ?? byKey.get(one)?.item.kind) === document.kind)
    const entry = key ? byKey.get(key) : undefined
    if (!entry) return document
    const found = importFilesOf(
      entry.item,
      document.kind,
      all.map((one) => one.item),
    )
    for (const odd of found.skipped) skipped.push({ key: entry.key, reason: `arquivo ${odd.path} fica de fora: ${odd.reason}` })
    const kept: IResourceFile[] = []
    for (const file of found.files) {
      const raw = this.deps.readRaw(record.projectId, record.repository, file.source)
      if (!raw) throw new ImportBuildError('source_changed', `source not found anymore: ${file.source} — analyse the repository again`, 'path')
      if (createHash('sha256').update(raw).digest('hex') !== file.sha256)
        throw new ImportBuildError('source_changed', `source changed since the analysis: ${file.source} — analyse the repository again`, 'path')
      const reason = raw.subarray(0, 8192).includes(0)
        ? 'binário (só texto vai para a pasta)'
        : raw.length > RESOURCE_FILE_MAX_BYTES
          ? 'maior que 1 MB'
          : (this.deps.secretsIn?.(raw.toString('utf8')) ?? []).length
            ? 'parece ter segredo (a credencial vai numa variável do gateway)'
            : undefined
      if (reason) {
        skipped.push({ key: entry.key, reason: `arquivo ${file.source} fica de fora: ${reason}` })
        continue
      }
      blobs.push(raw)
      kept.push({ path: file.path, sha256: file.sha256, bytes: raw.length })
    }
    const current = kept.length ? undefined : this.deps.reader.read(document.kind, document.id)?.body.files
    const files = kept.length ? (sortFiles(kept) as unknown as TCanonicalValue[]) : Array.isArray(current) ? current : []
    return files.length ? withBody(document, { ...document.body, files }) : document
  }

  /** O modelo e o alcance de cada agente aprovado: o tradutor (#131) com a política de "nasce fechado". */
  private agents(
    record: IImportJobRecord,
    entries: readonly IApprovedEntry[],
    byKey: ReadonlyMap<string, IImportJobItem>,
    prefix: string,
    selection: IImportApplySelection,
    idOfKey: (key: string) => string | undefined,
  ): Array<{ view: IImportApplyAgent; extras: IAgentExtras }> {
    const agents = entries.filter((entry) => entry.kind === 'agent')
    if (!agents.length) return []
    const inventory = this.deps.scan.inventory(record.projectId, record.repository)
    const catalog = (query: { kind: Parameters<ImportScanUseCase['catalogState']>[0]['kind']; id: string; parent?: string; title?: string }) =>
      this.deps.scan.catalogState({ ...query, projectId: record.projectId })
    return agents.map((entry) => {
      const id = entry.draft.outputs[0].meta.id
      const current = this.deps.reader.read('agent', id)
      const notes: string[] = []
      let translation: IReachTranslation | undefined
      let skills: string[] = []
      try {
        const batch = planAgentBatch({
          items: inventory.scan.items,
          agent: entry.key,
          prefix,
          reach: inventory.reach,
          agentByName: inventory.agentByName,
          ...(inventory.instructions ? { instructions: inventory.instructions } : {}),
          catalog,
          protocolTokens: () => 0,
        })
        translation = batch.reach?.translation
        skills = batch.reach ? batch.reach.skills.proposed : []
        if (batch.reach?.skills.note) notes.push(batch.reach.skills.note)
      } catch (error) {
        notes.push(`o alcance não foi traduzido: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Sem tradução: as skills e os commands que ele (e os triggers dele) citam.
      const item = byKey.get(entry.key)?.item
      const triggers = entries.filter((one) => one.parent === entry.key).map((one) => byKey.get(one.key)?.item)
      const cited = (kind: string) =>
        [item, ...triggers]
          .flatMap((one) => one?.refs ?? [])
          .map((ref) => ref.item)
          .filter((key): key is string => !!key && byKey.get(key)?.item.kind === kind)
          .map((key) => idOfKey(key)!)
          .filter(Boolean)
      if (!translation) skills = [...new Set(cited('skill'))]
      const commands = [...new Set(cited('command'))]

      const included = new Set(selection.wide?.[entry.key] ?? [])
      const wide = new Map((translation?.widenings ?? []).map((widening) => [ruleKey(widening.rule), widening.reason]))
      const rules: IReachRuleView[] = (translation?.rules ?? []).map((rule) => {
        const key = ruleKey(rule)
        const reason = wide.get(key)
        return { key, rule, ...(reason ? { wide: reason } : {}), included: !reason || included.has(key) }
      })
      const permissions = translation ? confirmedRules(translation, [...included]) : []
      const allowedTools = translation?.allowedTools ?? []
      const chosen = selection.models?.[entry.key]
      const providers = chosen ? [{ provider: chosen.provider, models: [chosen.model] }] : undefined
      // As lanes do modelo escolhido: o protocolo do provider (o id dos oficiais é o próprio protocolo).
      const protocol = chosen
        ? (this.deps.models?.().find((one) => one.provider === chosen.provider)?.protocol ??
          (Object.values(EProvider).includes(chosen.provider as EProvider) ? (chosen.provider as EProvider) : undefined))
        : undefined
      const lanes = protocol ? lanesOf(protocol) : undefined
      if (lanes && !lanes.includes(EMode.CHAT)) notes.push(`${chosen!.provider} roda só no modo agente: o agente entra só com ele`)
      const currentModel = (current?.body.providers as Array<{ provider: string; models: string[] }> | undefined)?.[0]
      const model = chosen ?? (currentModel?.models[0] ? { provider: currentModel.provider, model: currentModel.models[0] } : undefined)
      if (!translation) notes.push('sem alcance do opencode para traduzir: o agente nasce fechado e o alcance é escolhido na tela do agente')
      if (!model) notes.push('escolha o modelo do agente (os ativos no gateway)')
      return {
        view: {
          key: entry.key,
          id,
          exists: !!current,
          ...(model ? { model } : {}),
          rules,
          allowedTools,
          skills,
          pendingSkills: [],
          commands,
          reach: translation ? 'opencode' : 'none',
          notes,
        },
        extras: { ...(providers ? { providers } : {}), ...(lanes ? { lanes } : {}), allowedTools, permissions, skills, commands },
      }
    })
  }

  private sourceTexts(record: IImportJobRecord, entry: IImportJobItem, draft: Pick<IImportDraft, 'sources'>): Array<{ path: string; aliases: string[]; text: string }> {
    return draftSources(entry, draft).map((source) => {
      const file = this.deps.readSource(record.projectId, record.repository, source.path)
      if (!file) throw new ImportBuildError('source_changed', `source not found anymore: ${source.path} — analyse the repository again`, 'path')
      if (file.sha256 !== source.sha256) throw new ImportBuildError('source_changed', `source changed since the analysis: ${source.path} — analyse the repository again`, 'path')
      if (file.binary) throw new ImportBuildError('invalid', `binary file: ${source.path}`, 'path')
      return { path: source.path, aliases: source.aliases, text: file.text }
    })
  }
}

/**
 * As referências que faltam (`missing`), uma por alvo, com o item do trabalho que as produz: o do tipo certo cujo id no
 * gateway (o do rascunho, o escolhido ou o proposto com o prefixo do lote) é o citado. A tela leva até ele.
 */
export function missingRefs(
  plan: Pick<ICatalogImportPlan, 'items'>,
  items: readonly IImportJobItem[],
  prefix: string,
  produced: Readonly<Record<string, readonly string[]>> = {},
): IImportMissingRef[] {
  const keyOfRef = new Map(Object.entries(produced).flatMap(([key, refs]) => refs.map((ref) => [ref, key] as const)))
  const idsOf = (one: IImportJobItem) => {
    const kind = one.kind ?? one.item.kind
    return [lastDraft(one)?.outputs[0]?.meta.id, one.targetId, prefixedId(kind, one.item.candidateId, prefix).id, one.item.candidateId]
  }
  const found = new Map<string, IImportMissingRef>()
  for (const planned of plan.items) {
    for (const broken of planned.brokenRefs) {
      if (broken.reason !== 'missing') continue
      const ref = `${broken.target}/${broken.id}`
      const fromKey = keyOfRef.get(broken.from)
      const known = found.get(ref)
      if (known) {
        if (!known.from.includes(broken.from)) known.from.push(broken.from)
        if (fromKey && !known.fromKeys.includes(fromKey)) known.fromKeys.push(fromKey)
        continue
      }
      const kinds = KINDS_OF_TARGET[broken.target] ?? []
      const withId = items.filter((one) => idsOf(one).includes(broken.id))
      const entry = withId.find((one) => kinds.includes(one.kind ?? one.item.kind))
      const other = entry ? undefined : withId[0]
      found.set(ref, {
        target: broken.target,
        id: broken.id,
        from: [broken.from],
        fromKeys: fromKey ? [fromKey] : [],
        ...(entry ? { item: { key: entry.key, kind: entry.kind ?? entry.item.kind, state: entry.state, path: entry.item.sources[0]?.path ?? entry.key } } : {}),
        ...(other ? { wrongKind: { key: other.key, kind: other.kind ?? other.item.kind } } : {}),
      })
    }
  }
  return [...found.values()]
}

const kindIds = (ids: ReadonlyMap<string, string>, kind: string) => new Set([...ids].filter(([, one]) => one === kind).map(([id]) => id))
