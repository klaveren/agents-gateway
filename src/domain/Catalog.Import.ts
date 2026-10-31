import { createHash } from 'node:crypto'
import {
  AGENT_LINKS_SHAPE,
  AGENT_SHAPE,
  canonicalize,
  catalogHash,
  CATALOG_KINDS,
  DOC_SHAPE,
  ICatalogDocument,
  MCP_SHAPE,
  mcpSecretRefs,
  parseProtocolItemId,
  PERMISSION_RULE_SHAPE,
  PROJECT_SHAPE,
  PROTOCOL_SHAPE,
  RESOURCE_SHAPE,
  RULE_SHAPE,
  shaped,
  stableJson,
  TCanonicalBody,
  TCanonicalValue,
  TCatalogKind,
} from './Catalog.Document'
import { CATALOG_FORMAT, documentsFromFiles, ICatalogFilesError, ICatalogMasked, MANIFEST_PATH, TCatalogFiles } from './Catalog.Files'
import type { IWidening } from './Catalog.Widening'
import type { ITextDiff } from './Text.Diff'
import { AGENT_TOOL_PREFIX } from './models/Delegation.Model'
import { IMcpServerConfig, isMcpToolRef, mcpServerKey, parseMcpToolRef } from './models/McpServer.Model'
import { ALL_RESOURCES, NO_RESOURCES } from './models/Resource.Model'

/**
 * O PLANO DE IMPORT, a parte pura (docs/integration/plano-catalogo-historico.md §2.6, PR 8): o pacote em documentos
 * (`parsePackage`), o documento de fora de volta à forma canônica (`normalizeDocument`), as referências de cada item, as
 * atenções, a ORDEM de aplicação e o `planHash`. ⛔ Nada daqui grava: quem compõe com o catálogo de hoje é
 * `CatalogImport.Plan` (aplicação), e quem aplica é o PR 9.
 */

export type TImportIssue = { field: string; message: string }

/**
 * O que o import faria com o item:
 * - `create`/`update`: grava (o PR 9), com o diff contra o atual;
 * - `unchanged`: o pacote é igual ao catálogo, nada a fazer;
 * - `conflict`: não se aplica sem decisão (id de outro tipo ou de fora do escopo, campo mascarado no export);
 * - `error`: não passa nas regras do cadastro, ou depende de um item que não passa;
 * - `delete`: só no modo espelho (decisão 4: depois do PR 9) — hoje nunca sai.
 */
export type TImportOp = 'create' | 'update' | 'unchanged' | 'conflict' | 'error' | 'delete'

/** A referência estável do item, a mesma do histórico: `<kind>/<id>` (no MCP, a chave com o projeto). */
export function itemRef(kind: TCatalogKind, id: string, projectId?: string): string {
  return kind === 'mcp' ? `mcp/${mcpServerKey({ id, projectId })}` : `${kind}/${id}`
}

export const refOfDocument = (document: Pick<ICatalogDocument, 'kind' | 'id' | 'projectId'>) => itemRef(document.kind, document.id, document.projectId)

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// --- O pacote em documentos ---------------------------------------------------------------------------------------

/** O que o plano usa do manifesto: o escopo do export e o que a máscara trocou. */
export interface IPackageManifest {
  scope?: string
  masked: ICatalogMasked[]
}

export interface IParsedPackage {
  documents: ICatalogDocument[]
  /** Arquivo fora do formato, por caminho (os outros seguem). */
  errors: ICatalogFilesError[]
  manifest?: IPackageManifest
}

/**
 * NÍVEL 1: o pacote (os arquivos do export, `catalog.json` incluso ou à parte em `manifest`) → os documentos canônicos
 * e os erros por arquivo. Reaproveita `Catalog.Files` (a ida e a volta do export são exatas).
 */
export function parsePackage(files: TCatalogFiles, manifest?: unknown): IParsedPackage {
  const errors: ICatalogFilesError[] = []
  let raw = manifest
  if (raw === undefined && typeof files[MANIFEST_PATH] === 'string') {
    try {
      raw = JSON.parse(files[MANIFEST_PATH])
    } catch {
      errors.push({ path: MANIFEST_PATH, message: 'JSON inválido' })
    }
  }
  const parsed = manifestOf(raw, errors)
  const read = documentsFromFiles(files)
  return { documents: read.documents, errors: [...errors, ...read.errors], ...(parsed ? { manifest: parsed } : {}) }
}

function manifestOf(raw: unknown, errors: ICatalogFilesError[]): IPackageManifest | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ path: MANIFEST_PATH, message: 'esperado um objeto JSON' })
    return undefined
  }
  const value = raw as { format?: unknown; scope?: unknown; masked?: unknown }
  if (value.format !== undefined && value.format !== CATALOG_FORMAT)
    errors.push({ path: MANIFEST_PATH, message: `formato não suportado: ${String(value.format)} (esperado ${CATALOG_FORMAT})` })
  const masked = Array.isArray(value.masked)
    ? (value.masked.filter(
        (item) => !!item && typeof item === 'object' && typeof (item as ICatalogMasked).kind === 'string' && typeof (item as ICatalogMasked).id === 'string',
      ) as ICatalogMasked[])
    : []
  return { ...(typeof value.scope === 'string' ? { scope: value.scope } : {}), masked }
}

// --- O documento de fora de volta à forma canônica ----------------------------------------------------------------

type TAnyShape = Readonly<Record<string, unknown>>

/** A forma de cada tipo, com o que o documento leva além do modelo (vínculos, contexto inicial, `secrets`). */
const IMPORT_SHAPES: Readonly<Record<TCatalogKind, TAnyShape>> = {
  agent: { ...AGENT_SHAPE, ...AGENT_LINKS_SHAPE },
  skill: RESOURCE_SHAPE,
  command: RESOURCE_SHAPE,
  rule: RULE_SHAPE,
  spec: DOC_SHAPE,
  adr: DOC_SHAPE,
  knowledge: DOC_SHAPE,
  protocol: PROTOCOL_SHAPE,
  project: { ...PROJECT_SHAPE, initialContext: 'list' },
  'project-permissions': { projectId: 'value', rules: { list: PERMISSION_RULE_SHAPE } },
  // `secrets` é DERIVADO (as variáveis e o `auth`): entra na conferência de tipo, e sai recalculado.
  mcp: { ...MCP_SHAPE, secrets: 'set' },
}

const isOmit = (spec: unknown) => typeof spec === 'object' && spec !== null && 'omit' in spec
const isScalar = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function valueIssues(spec: unknown, value: unknown, field: string, out: TImportIssue[]): void {
  if (value === undefined || value === null) return
  if (spec === 'value') {
    if (!isScalar(value)) out.push({ field, message: 'expected text, a number or a boolean' })
    return
  }
  if (spec === 'list' || spec === 'set') {
    if (!Array.isArray(value) || !value.every(isScalar)) out.push({ field, message: 'expected a list of values' })
    return
  }
  if (spec === 'record') {
    if (!isObject(value) || !Object.values(value).every(isScalar)) out.push({ field, message: 'expected a map of values' })
    return
  }
  const nested = spec as { list?: TAnyShape; set?: TAnyShape; object?: TAnyShape }
  if (nested.object) {
    if (!isObject(value)) out.push({ field, message: 'expected an object' })
    else objectIssues(nested.object, value, field, out)
    return
  }
  const item = (nested.list ?? nested.set)!
  if (!Array.isArray(value)) {
    out.push({ field, message: 'expected a list' })
    return
  }
  value.forEach((entry, index) => {
    if (isObject(entry)) objectIssues(item, entry, `${field}[${index}]`, out)
    else out.push({ field: `${field}[${index}]`, message: 'expected an object' })
  })
}

/** ⛔ LISTA DE PERMITIDOS: campo fora da forma é erro (não some em silêncio — quem editou o arquivo precisa saber). */
function objectIssues(shape: TAnyShape, value: Record<string, unknown>, path: string, out: TImportIssue[]): void {
  for (const [key, item] of Object.entries(value)) {
    const spec = shape[key]
    const field = path ? `${path}.${key}` : key
    if (spec === undefined || isOmit(spec)) out.push({ field, message: 'not a field of the catalog document' })
    else valueIssues(spec, item, field, out)
  }
}

/**
 * O documento que veio de fora (o pacote ou o importador) na forma canônica: só os campos permitidos, com o tipo certo,
 * as listas-conjunto ordenadas, os derivados recalculados — o mesmo `text`/`hash` que o leitor daria ao item gravado.
 * A chave tem de bater com o corpo (`id`, `projectId`, o tipo do complemento). Problema = sem documento.
 */
export function normalizeDocument(document: ICatalogDocument): { document?: ICatalogDocument; issues: TImportIssue[] } {
  const { kind, id } = document
  const shape = IMPORT_SHAPES[kind]
  if (!shape) return { issues: [{ field: 'kind', message: `unknown kind: ${String(kind)}` }] }
  const body = document.body as Record<string, unknown>
  if (!isObject(body)) return { issues: [{ field: 'document', message: 'expected an object' }] }
  const issues: TImportIssue[] = []
  objectIssues(shape, body, '', issues)

  const own = kind === 'project' || kind === 'project-permissions'
  const projectId = own ? id : document.projectId || undefined
  if (own && document.projectId !== undefined && document.projectId !== id) issues.push({ field: 'projectId', message: `a project is its own scope: ${id}` })
  if (kind === 'project-permissions') {
    if (body.projectId !== id) issues.push({ field: 'projectId', message: `differs from the item (${id})` })
  } else if (kind !== 'project' && (body.projectId ?? undefined) !== projectId) issues.push({ field: 'projectId', message: 'differs from the item scope' })
  if (kind === 'protocol') {
    const key = parseProtocolItemId(id)
    if (!key || key.kind !== body.kind || key.projectId !== projectId) issues.push({ field: 'kind', message: `differs from the item (${id})` })
  } else if (kind !== 'project-permissions' && body.id !== id) issues.push({ field: 'id', message: `differs from the item (${id})` })
  if (issues.length) return { issues }

  const canonical: TCanonicalBody = shaped(shape, body)
  if (kind === 'mcp') canonical.secrets = mcpSecretRefs(canonical as unknown as IMcpServerConfig)
  return { document: withBody({ kind, id, ...(projectId ? { projectId } : {}) }, canonical), issues }
}

/** O documento com outro corpo (o `text` e o `hash` refeitos). */
export function withBody(key: Pick<ICatalogDocument, 'kind' | 'id' | 'projectId'>, body: TCanonicalBody): ICatalogDocument {
  const text = canonicalize(body)
  return { kind: key.kind, id: key.id, ...(key.projectId ? { projectId: key.projectId } : {}), body, text, hash: catalogHash(text) }
}

// --- As referências -----------------------------------------------------------------------------------------------

/** O que um item cita: `doc` é qualquer documento (spec, ADR, knowledge); `spec`, só do contexto inicial. */
export type TRefTarget = 'project' | 'doc' | 'spec' | 'skill' | 'command' | 'mcp' | 'agent'

export interface IDocumentRef {
  /** O campo de quem cita: `docIds`, `resources.skills`, `initialContext`, `allowedTools`, `projectId`. */
  field: string
  target: TRefTarget
  id: string
  /** No MCP: o escopo de quem cita (o agente de projeto vê os globais e os do projeto dele). */
  projectId?: string
}

const strings = (value: TCanonicalValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/** As referências do item, sem repetir, na ordem em que aparecem. */
export function referencesOf(document: ICatalogDocument): IDocumentRef[] {
  const { kind, body } = document
  const out = new Map<string, IDocumentRef>()
  const add = (ref: IDocumentRef) => out.set(`${ref.field}|${ref.target}|${ref.id}|${ref.projectId ?? ''}`, ref)
  if (document.projectId && kind !== 'project') add({ field: 'projectId', target: 'project', id: document.projectId })
  switch (kind) {
    case 'skill':
    case 'command':
    case 'spec':
    case 'adr':
    case 'knowledge':
      for (const id of strings(body.docIds)) add({ field: 'docIds', target: 'doc', id })
      break
    case 'project':
      for (const id of strings(body.initialContext)) add({ field: 'initialContext', target: 'spec', id })
      break
    case 'agent': {
      const resources = isObject(body.resources) ? (body.resources as Record<string, TCanonicalValue>) : {}
      for (const [field, target] of [
        ['skills', 'skill'],
        ['commands', 'command'],
      ] as const)
        for (const id of strings(resources[field])) if (id !== ALL_RESOURCES && id !== NO_RESOURCES) add({ field: `resources.${field}`, target, id })
      for (const id of strings(body.initialContext)) add({ field: 'initialContext', target: 'spec', id })
      for (const tool of strings(body.allowedTools)) {
        if (tool.startsWith(AGENT_TOOL_PREFIX)) {
          const target = tool.slice(AGENT_TOOL_PREFIX.length)
          if (target) add({ field: 'allowedTools', target: 'agent', id: target })
        } else if (isMcpToolRef(tool)) {
          const ref = parseMcpToolRef(tool)
          if (ref) add({ field: 'allowedTools', target: 'mcp', id: ref.server, ...(document.projectId ? { projectId: document.projectId } : {}) })
        }
      }
      break
    }
    default:
      break
  }
  return [...out.values()]
}

// --- As atenções (aparecem no plano, sem trava) ------------------------------------------------------------------

/** O que muda sem ampliar acesso, mas merece olho (§2.4, coluna "Atenção"). */
export interface IAttention {
  kind: TCatalogKind
  id: string
  projectId?: string
  /** Estável, no estilo da ampliação: `agent/theo#systemPrompt~`. */
  key: string
  description: string
}

const same = (a: TCanonicalValue | undefined, b: TCanonicalValue | undefined) => (a === undefined ? b === undefined : b !== undefined && stableJson(a) === stableJson(b))
const sortedRules = (value: TCanonicalValue | undefined) => (Array.isArray(value) ? value.map((item) => stableJson(item)).sort(byText) : [])

export function attentionsOf(before: ICatalogDocument | undefined, after: ICatalogDocument): IAttention[] {
  const { kind, id, projectId, body } = after
  const was = before?.body
  const out: IAttention[] = []
  const scope = projectId && projectId !== id ? `@${projectId}` : ''
  const add = (detail: string, description: string) =>
    out.push({
      kind,
      id,
      ...(projectId ? { projectId } : {}),
      key: `${kind}/${id}${scope}#${detail}`,
      description: `${kind} ${id}${scope ? ` (projeto ${projectId})` : ''}: ${description}`,
    })
  switch (kind) {
    case 'agent':
      if (!was) break
      if (!same(was.soul, body.soul)) add('soul~', 'a alma (soul) muda')
      if (!same(was.systemPrompt, body.systemPrompt)) add('systemPrompt~', 'o prompt muda')
      if (!same(was.providers, body.providers)) add('providers~', 'provider ou modelo trocado')
      break
    case 'project-permissions':
      if (was && !same(was.rules, body.rules) && stableJson(sortedRules(was.rules)) === stableJson(sortedRules(body.rules))) add('rules~order', 'as regras mudam só de ordem')
      break
    case 'mcp':
      if (was && !same(was.name, body.name)) add('name~', `o nome muda para "${String(body.name)}"`)
      break
    case 'skill':
    case 'command':
      if (!was && !projectId) add('new-global', 'criada global: vale para todos os agentes com "*"')
      else if (was?.projectId && !projectId) add('projectId-', 'vira global: vale para todos os agentes com "*"')
      break
    case 'rule':
      if (was && was.enabled !== false && body.enabled === false) add('enabled-', 'desligada')
      if (was && !same(was.body, body.body)) add('body~', 'o corpo muda')
      break
    default:
      break
  }
  return out
}

// --- A ordem de aplicação -----------------------------------------------------------------------------------------

/**
 * As fases, na ordem (§2.6): o projeto antes de tudo o que é dele; docs → recursos → rules → complementos → MCPs →
 * agentes → vínculos (o contexto inicial do projeto que cita doc novo do pacote) → permissões do projeto.
 */
export type TImportPhase = 'project' | 'docs' | 'resources' | 'rules' | 'protocols' | 'mcps' | 'agents' | 'links' | 'permissions'
export const IMPORT_PHASES: readonly TImportPhase[] = ['project', 'docs', 'resources', 'rules', 'protocols', 'mcps', 'agents', 'links', 'permissions']

const PHASE_OF: Readonly<Record<TCatalogKind, TImportPhase>> = {
  project: 'project',
  knowledge: 'docs',
  spec: 'docs',
  adr: 'docs',
  skill: 'resources',
  command: 'resources',
  rule: 'rules',
  protocol: 'protocols',
  mcp: 'mcps',
  agent: 'agents',
  'project-permissions': 'permissions',
}

export interface IOrderInput {
  ref: string
  kind: TCatalogKind
  id: string
  projectId?: string
  op: 'create' | 'update' | 'delete'
  /** O item amplia acesso (tem ampliação). */
  widens: boolean
  /** As referências dos itens DESTE plano de que ele depende (os do catálogo já existem). */
  dependsOn: readonly string[]
  /** Projeto: o contexto inicial cita doc que o pacote cria — o vínculo vai na fase `links`, depois dos docs. */
  linksLater?: boolean
}

export interface IImportStep {
  ref: string
  kind: TCatalogKind
  id: string
  projectId?: string
  op: 'create' | 'update' | 'delete'
  phase: TImportPhase
  /** `record`: o item sem os vínculos (que vêm no passo `links`). Ausente: o item inteiro. */
  part?: 'record' | 'links'
  widens: boolean
  /** Entrou fora da ordem das dependências: havia um ciclo entre os que faltavam (docs que se anexam). */
  cycle?: true
}

/**
 * ⚖️ A ORDEM: a fase manda; dentro dela, quem é citado vem antes de quem cita (o doc anexado antes de quem o anexa, o
 * agente que recebe a delegação antes de quem delega) e, entre os livres, o que RESTRINGE (sem ampliação) antes do que
 * AMPLIA — um lote que pare no meio nunca deixa o ambiente mais aberto do que estava. Empate: o tipo, o escopo, o id.
 * Ciclo não trava: entra o primeiro pela mesma prioridade, marcado.
 */
export function importOrder(items: readonly IOrderInput[]): IImportStep[] {
  const steps: Array<IImportStep & { deps: readonly string[] }> = []
  for (const item of items) {
    const base = { ref: item.ref, kind: item.kind, id: item.id, ...(item.projectId ? { projectId: item.projectId } : {}), op: item.op, widens: item.widens }
    if (item.kind === 'project' && item.linksLater) {
      steps.push({ ...base, phase: 'project', part: 'record', deps: [] })
      steps.push({ ...base, phase: 'links', part: 'links', deps: [] })
    } else steps.push({ ...base, phase: PHASE_OF[item.kind], deps: item.dependsOn.filter((ref) => ref !== item.ref) })
  }
  const kindOrder = (kind: TCatalogKind) => CATALOG_KINDS.indexOf(kind)
  const before = (a: IImportStep, b: IImportStep) =>
    Number(a.widens) - Number(b.widens) || kindOrder(a.kind) - kindOrder(b.kind) || byText(a.projectId ?? '', b.projectId ?? '') || byText(a.id, b.id)

  const ordered: IImportStep[] = []
  for (const phase of IMPORT_PHASES) {
    const members = steps.filter((step) => step.phase === phase)
    const inPhase = new Set(members.map((step) => step.ref))
    const done = new Set<string>()
    const left = new Set(members)
    while (left.size) {
      const ready = [...left].filter((step) => step.deps.every((ref) => !inPhase.has(ref) || done.has(ref)))
      const cycle = !ready.length
      const pick = (cycle ? [...left] : ready).sort(before)[0]
      left.delete(pick)
      done.add(pick.ref)
      const { deps: _deps, ...step } = pick
      ordered.push(cycle ? { ...step, cycle: true } : step)
    }
  }
  return ordered
}

// --- O hash do plano ----------------------------------------------------------------------------------------------

export interface IPlanHashInput {
  scope: string
  /** Os documentos do pacote (normalizados; o que não normaliza, pelo hash de entrada). */
  documents: ReadonlyArray<{ ref: string; hash: string }>
  fileErrors: readonly ICatalogFilesError[]
  /** O estado atual USADO: os itens tocados e os citados que resolvem no catálogo (`hash` ausente = não existe). */
  current: ReadonlyArray<{ ref: string; hash?: string }>
  /** O resultado, item a item: o que o PR 9 faria. */
  items: ReadonlyArray<{ ref: string; op: TImportOp; hash?: string; widenings: readonly string[]; issues: readonly string[]; missingSecrets: readonly string[] }>
}

/**
 * O `planHash`: sha256 do JSON estável de (escopo, documentos do pacote, estado atual usado, resultado de cada item).
 * Ordem de entrada não importa (tudo sai ordenado). O PR 9 recalcula o plano e só aplica se o hash for o mesmo: um
 * item tocado, um item citado ou uma regra do cadastro que mudou no meio muda o hash.
 */
export function planHashOf(input: IPlanHashInput): string {
  const byRef = <T extends { ref: string }>(list: readonly T[]) => [...list].sort((a, b) => byText(a.ref, b.ref))
  const unique = (list: readonly string[]) => [...new Set(list)].sort(byText)
  const value = {
    v: 1,
    scope: input.scope,
    documents: byRef(input.documents).map(({ ref, hash }) => [ref, hash]),
    fileErrors: [...input.fileErrors].map(({ path, message }) => [path, message]).sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1])),
    current: byRef(dedupe(input.current)).map(({ ref, hash }) => [ref, hash ?? null]),
    items: byRef(input.items).map((item) => [item.ref, item.op, item.hash ?? null, unique(item.widenings), [...item.issues].sort(byText), unique(item.missingSecrets)]),
  }
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function dedupe<T extends { ref: string }>(list: readonly T[]): T[] {
  const seen = new Map<string, T>()
  for (const item of list) if (!seen.has(item.ref)) seen.set(item.ref, item)
  return [...seen.values()]
}

// --- O plano ------------------------------------------------------------------------------------------------------

/** Uma referência que não resolve: o que cita, o quê, e por quê. */
export interface IBrokenRef {
  /** Quem cita. */
  from: string
  field: string
  target: TRefTarget
  id: string
  /**
   * `missing`: não existe nem no catálogo nem no pacote; `package-error`: só vem no pacote, e lá o item não se aplica
   * (erro ou conflito); `disabled`: o MCP existe mas está desligado, ou entra desligado (falta segredo).
   */
  reason: 'missing' | 'package-error' | 'disabled'
  message: string
}

export interface IImportPlanItem {
  ref: string
  kind: TCatalogKind
  id: string
  projectId?: string
  op: TImportOp
  /** O hash do documento que seria gravado (no MCP que entra desligado, o desligado). */
  hash?: string
  currentHash?: string
  /** Do atual (vazio se não existe) para o que seria gravado. Ausente quando não há documento (não normalizou) ou nada muda. */
  diff?: ITextDiff
  /** O que o item amplia (só em `create`/`update`): o `confirm` do PR 9 traz estas chaves. */
  widenings: IWidening[]
  attentions: IAttention[]
  /** Por que é `error` ou `conflict`. */
  issues: TImportIssue[]
  brokenRefs: IBrokenRef[]
  /** MCP: o que o servidor pede ao cofre e ainda não está lá (`env:<NOME>`, `header`). */
  missingSecrets?: string[]
  /** MCP ligado no pacote que entra DESLIGADO por falta de segredo (ligar depois é outra ampliação). */
  entersDisabled?: true
  /** ⛔ Pedido por token de acesso e o item amplia: o PR 9 não o aplica por token (só admin pela tela). */
  blockedByToken?: true
}

export interface ICatalogImportPlan {
  /** `all`, `global` ou `project:<id>`. */
  scope: string
  /** Ver `planHashOf`. */
  planHash: string
  /** Na ordem do catálogo (tipo, depois id). */
  items: IImportPlanItem[]
  /** Os itens a gravar (`create`/`update`), na ordem de aplicação. */
  order: IImportStep[]
  widenings: IWidening[]
  attentions: IAttention[]
  brokenRefs: IBrokenRef[]
  /** Os MCPs com segredo faltando. */
  missingSecrets: Array<{ ref: string; id: string; projectId?: string; secrets: string[] }>
  /** Arquivo do pacote fora do formato (não vira item). */
  fileErrors: ICatalogFilesError[]
  summary: Record<TImportOp, number> & { widenings: number; brokenRefs: number; fileErrors: number }
  /**
   * ⛔ Decisão do dono (30/10): import por token de acesso NUNCA aplica ampliação. `wideningsApplicable: false` com
   * ampliações = o PR 9 recusa por token; a ampliação só passa por admin na tela.
   */
  caller: { viaAccessToken: boolean; wideningsApplicable: boolean }
}

/** O pacote no formato da API (o mesmo do export JSON). */
export interface IPackageInput {
  manifest?: unknown
  files: TCatalogFiles
}

/** Quantos de cada operação (todas as chaves presentes). */
export function emptySummary(): ICatalogImportPlan['summary'] {
  return { create: 0, update: 0, unchanged: 0, conflict: 0, error: 0, delete: 0, widenings: 0, brokenRefs: 0, fileErrors: 0 }
}
