import { createHash } from 'node:crypto'
import type { IAgentFallback, IFallbackStep } from './Fallback.Policy'
import type { IAgent, IAgentDiagnostics, IAgentTarget, IAgentTerminal, IAgentTrigger } from './models/Agent.Model'
import type { IMcpContainer, IMcpProcess, IMcpServerConfig } from './models/McpServer.Model'
import { mcpEnvNames } from './models/McpServer.Model'
import type { IProject } from './models/Project.Model'
import type { IProjectDoc } from './models/ProjectDoc.Model'
import type { IProtocolAddendum, TProtocolKind } from './models/Protocol.Model'
import { PROTOCOL_KINDS } from './models/Protocol.Model'
import type { IAgentResources, IResource } from './models/Resource.Model'
import type { IRule } from './models/Rule.Model'
import type { IPermissionRule } from './Permission.Policy'

/**
 * O DOCUMENTO CANÔNICO de cada item do catálogo: a forma única que o histórico, o diff, o export, o import e o rollback
 * comparam (ver docs/integration/plano-catalogo-historico.md §2.1).
 *
 * ⛔ LISTA DE CAMPOS PERMITIDOS, NUNCA DE PROIBIDOS. Cada modelo tem uma `TShape` que classifica TODOS os campos dele:
 * campo novo no `IAgent` (ou em qualquer tipo aninhado) quebra o `tsc` aqui até alguém decidir se entra. Assim um
 * segredo futuro não vaza por omissão. O que não está na forma (um campo a mais no JSON gravado) não sai.
 *
 * ⚖️ O que entra é só o CONTEÚDO: `createdAt`, `updatedAt` e `updatedBy` vão para o histórico, não para o documento —
 * senão toda gravação daria diff. Os vínculos entram no DONO (o agente leva `resources` e `initialContext`; o projeto,
 * `initialContext`; a skill e o command, `docIds`).
 *
 * Normalização estável: chaves em ordem, campo ausente (`undefined`/`null`) omitido, lista em que a ordem não importa
 * ordenada (`set`), lista em que importa preservada (`list`), JSON com indentação de 2, LF e quebra no fim.
 */

export type TCatalogKind = 'agent' | 'skill' | 'command' | 'rule' | 'spec' | 'adr' | 'knowledge' | 'protocol' | 'project' | 'project-permissions' | 'mcp'

/** Na ordem em que o catálogo os lista (e em que o import aplica: docs antes de quem os cita). */
export const CATALOG_KINDS: readonly TCatalogKind[] = ['project', 'knowledge', 'spec', 'adr', 'skill', 'command', 'rule', 'protocol', 'mcp', 'agent', 'project-permissions']

/** Um valor do documento canônico: só o que o JSON representa. */
export type TCanonicalValue = string | number | boolean | TCanonicalValue[] | { [key: string]: TCanonicalValue }
export type TCanonicalBody = { [key: string]: TCanonicalValue }

/** Um item do catálogo na forma canônica. A chave é `(kind, id)`; `projectId` é o escopo (ausente = global ou do sistema). */
export interface ICatalogDocument {
  kind: TCatalogKind
  id: string
  projectId?: string
  body: TCanonicalBody
  /** `body` serializado de forma estável. */
  text: string
  /** sha256 do `text`, em hex. */
  hash: string
}

/** Fora do documento, com o motivo (fica no código, para a revisão ler). */
export interface IOmit {
  omit: string
}

/**
 * Como cada campo entra. ⚖️ Escalar: `value`. Lista de escalares: `list` (ordem importa) ou `set` (ordenada). Lista de
 * objetos: `{ list }`/`{ set }` com a forma do item. Objeto: `{ object }` com a forma dele, ou `record` (mapa texto →
 * texto, chaves ordenadas).
 */
export type TFieldSpec<V> =
  | IOmit
  | (NonNullable<V> extends readonly (infer E)[]
      ? E extends object
        ? { list: TShape<E> } | { set: TShape<E> }
        : 'list' | 'set'
      : NonNullable<V> extends Date
        ? never
        : NonNullable<V> extends object
          ? { object: TShape<NonNullable<V>> } | 'record'
          : 'value')

/** A classificação de TODOS os campos de `T` (o `-?` obriga a citar também os opcionais). */
export type TShape<T> = { readonly [K in keyof T]-?: TFieldSpec<T[K]> }

const META = 'metadado: vai para o histórico (quem e quando), não para o documento'
const KEY = 'vai na chave do item (kind)'

// --- As formas, tipo a tipo ----------------------------------------------------------------------------------------

export const TARGET_SHAPE: TShape<IAgentTarget> = {
  provider: 'value',
  // O primeiro modelo é o padrão do provider: a ordem importa.
  models: 'list',
  sandbox: 'value',
  network: 'value',
}

export const TERMINAL_SHAPE: TShape<IAgentTerminal> = { timeoutSeconds: 'value', maxOutputChars: 'value' }

export const DIAGNOSTICS_SHAPE: TShape<IAgentDiagnostics> = { typecheck: 'value', lint: 'value', format: 'value', timeoutSeconds: 'value' }

export const TRIGGER_SHAPE: TShape<IAgentTrigger> = { id: 'value', when: 'value', body: 'value' }

export const FALLBACK_STEP_SHAPE: TShape<IFallbackStep> = { provider: 'value', model: 'value' }

export const FALLBACK_SHAPE: TShape<IAgentFallback> = { mode: 'value', chain: { list: FALLBACK_STEP_SHAPE } }

/**
 * ⚖️ Lista ORDENADA, e não conjunto: negar vence permitir qualquer que seja a ordem, mas a ordem é o que a pessoa vê na
 * tela, e o plano trata reordenação como "atenção" (§2.4) — o diff precisa enxergá-la.
 */
export const PERMISSION_RULE_SHAPE: TShape<IPermissionRule> = { category: 'value', pattern: 'value', decision: 'value', note: 'value' }

export const AGENT_SHAPE: TShape<IAgent> = {
  id: 'value',
  name: 'value',
  // O primeiro provider é o padrão.
  providers: { list: TARGET_SHAPE },
  soul: 'value',
  systemPrompt: 'value',
  // A ordem dos níveis é a da tela.
  reasoningEfforts: 'list',
  modes: 'set',
  allowedTools: 'set',
  role: 'value',
  adminOnly: 'value',
  projectId: 'value',
  permissions: { list: PERMISSION_RULE_SHAPE },
  terminal: { object: TERMINAL_SHAPE },
  diagnostics: { object: DIAGNOSTICS_SHAPE },
  // A ordem é a do índice "## Triggers" no prompt.
  triggers: { list: TRIGGER_SHAPE },
  fallback: { object: FALLBACK_SHAPE },
  /**
   * ⚖️ ENTRA, nomes e valores: é dado do agente (a autoria do git, um idioma), e o contrato do campo é "nunca segredo" —
   * a regra (`envIssues`) recusa nome com cara de chave, e segredo mora em Segredos e nas contas do projeto. ⚠️ A regra
   * olha o NOME: um valor secreto sob nome inocente passaria. A rede de segurança é a do export (PR 7), que passa os
   * valores pela máscara de segredos (`Secret.Mask`: forma e formato de token).
   */
  env: 'record',
}

/** O que o agente leva além do `IAgent`: os vínculos que moram em outras tabelas. */
export interface IAgentLinks {
  /** O efetivo, como a API: `['*']` = todos, `[]` = nenhum de propósito. */
  resources: IAgentResources
  /** As specs do contexto inicial, na ordem. */
  initialContext: string[]
}

/** Liberar é sim ou não por id: a ordem não importa. */
export const AGENT_RESOURCES_SHAPE: TShape<IAgentResources> = { skills: 'set', commands: 'set' }

export const AGENT_LINKS_SHAPE: TShape<IAgentLinks> = {
  resources: { object: AGENT_RESOURCES_SHAPE },
  initialContext: 'list',
}

export const RESOURCE_SHAPE: TShape<IResource> = {
  id: 'value',
  kind: { omit: KEY },
  projectId: 'value',
  description: 'value',
  body: 'value',
  // Vão junto na ordem.
  docIds: 'list',
  // Subconjunto de `docIds`: só diz QUAIS vão por referência.
  docRefs: 'set',
  createdAt: { omit: META },
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

export const RULE_SHAPE: TShape<IRule> = {
  id: 'value',
  projectId: 'value',
  position: 'value',
  title: 'value',
  body: 'value',
  enabled: 'value',
  createdAt: { omit: META },
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

export const DOC_SHAPE: TShape<IProjectDoc> = {
  id: 'value',
  kind: { omit: KEY },
  projectId: 'value',
  title: 'value',
  summary: 'value',
  body: 'value',
  createdAt: { omit: META },
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

/** Só o complemento: o core chega com a imagem e não é item do catálogo. */
export const PROTOCOL_SHAPE: TShape<IProtocolAddendum> = {
  kind: 'value',
  projectId: 'value',
  body: 'value',
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

/** ⛔ Membros não entram (moram em outra tabela e são gente, não catálogo). */
export const PROJECT_SHAPE: TShape<IProject> = {
  id: 'value',
  name: 'value',
  description: 'value',
  createdAt: { omit: META },
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

export const MCP_CONTAINER_SHAPE: TShape<IMcpContainer> = {
  image: 'value',
  args: 'list',
  writable: 'set',
  memoryMb: 'value',
  cpus: 'value',
  network: 'value',
  allowedHosts: 'set',
  // Só os NOMES: os valores estão cifrados no cofre (`mcp:<id>:env:<NOME>`).
  env: 'set',
}

export const MCP_PROCESS_SHAPE: TShape<IMcpProcess> = {
  package: 'value',
  command: 'value',
  args: 'list',
  // Só os NOMES, como no contêiner.
  env: 'set',
  scope: 'value',
}

/**
 * ⛔ SEM SEGREDO, por construção: o modelo não guarda valor nenhum (o header de `auth: header` e as variáveis estão no
 * cofre). Entram o NOME do header e os NOMES das variáveis, e o documento lista em `secrets` o que o servidor pede ao
 * cofre — é o que o import usa para dizer "falta cadastrar o segredo".
 */
export const MCP_SHAPE: TShape<IMcpServerConfig> = {
  id: 'value',
  name: 'value',
  kind: 'value',
  container: { object: MCP_CONTAINER_SHAPE },
  process: { object: MCP_PROCESS_SHAPE },
  url: 'value',
  transport: 'value',
  auth: 'value',
  headerName: 'value',
  identity: 'value',
  enabled: 'value',
  projectId: 'value',
  createdAt: { omit: META },
  updatedAt: { omit: META },
  updatedBy: { omit: META },
}

// --- A normalização -----------------------------------------------------------------------------------------------

type TAnyShape = Readonly<Record<string, unknown>>

const isOmit = (spec: unknown): spec is IOmit => typeof spec === 'object' && spec !== null && 'omit' in spec

/** Compara por código de unidade, não por locale: o resultado não pode depender da máquina. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function scalar(value: unknown): TCanonicalValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new TypeError(`catalog: expected a scalar, got ${typeof value}`)
}

function field(spec: unknown, value: unknown): TCanonicalValue {
  if (spec === 'value') return scalar(value)
  if (spec === 'list' || spec === 'set') {
    const items = (value as unknown[]).map(scalar)
    return spec === 'set' ? [...items].sort((a, b) => byText(stableJson(a), stableJson(b))) : items
  }
  if (spec === 'record') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scalar(item)]))
  }
  const nested = spec as { list?: TAnyShape; set?: TAnyShape; object?: TAnyShape }
  if (nested.object) return shaped(nested.object, value as Record<string, unknown>)
  const items = (value as Record<string, unknown>[]).map((item) => shaped((nested.list ?? nested.set)!, item))
  return nested.set ? [...items].sort((a, b) => byText(stableJson(a), stableJson(b))) : items
}

/** Aplica a forma: só os campos permitidos, ausentes omitidos. */
export function shaped<T>(shape: TShape<T> | TAnyShape, value: T | Record<string, unknown>): TCanonicalBody {
  const source = value as Record<string, unknown>
  const body: TCanonicalBody = {}
  for (const [key, spec] of Object.entries(shape)) {
    if (isOmit(spec)) continue
    const item = source[key]
    if (item === undefined || item === null) continue
    body[key] = field(spec, item)
  }
  return body
}

/** JSON com as chaves em ordem, em todos os níveis. */
export function stableJson(value: TCanonicalValue, indent = 0): string {
  return JSON.stringify(sortKeys(value), null, indent || undefined)
}

function sortKeys(value: TCanonicalValue): TCanonicalValue {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(byText)
        .map((key) => [key, sortKeys(value[key])]),
    )
  }
  return value
}

/** O texto canônico: chaves ordenadas, indentação de 2, LF, quebra no fim. */
export function canonicalize(body: TCanonicalBody): string {
  return `${stableJson(body, 2)}\n`
}

export function catalogHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function documentOf(kind: TCatalogKind, id: string, projectId: string | undefined, body: TCanonicalBody): ICatalogDocument {
  const text = canonicalize(body)
  return { kind, id, ...(projectId ? { projectId } : {}), body, text, hash: catalogHash(text) }
}

// --- Os documentos, tipo a tipo ------------------------------------------------------------------------------------

export function agentDocument(agent: IAgent, links: IAgentLinks): ICatalogDocument {
  return documentOf('agent', agent.id, agent.projectId, { ...shaped(AGENT_SHAPE, agent), ...shaped(AGENT_LINKS_SHAPE, links) })
}

export function resourceDocument(resource: IResource): ICatalogDocument {
  return documentOf(resource.kind, resource.id, resource.projectId, shaped(RESOURCE_SHAPE, resource))
}

export function ruleDocument(rule: IRule): ICatalogDocument {
  return documentOf('rule', rule.id, rule.projectId, shaped(RULE_SHAPE, rule))
}

export function docDocument(doc: IProjectDoc): ICatalogDocument {
  return documentOf(doc.kind, doc.id, doc.projectId, shaped(DOC_SHAPE, doc))
}

/** O id do complemento: o tipo (global) ou `<projeto>/<tipo>`. */
export function protocolItemId(kind: TProtocolKind, projectId?: string): string {
  return projectId ? `${projectId}/${kind}` : kind
}

/** `undefined` = não é um id de complemento. */
export function parseProtocolItemId(id: string): { kind: TProtocolKind; projectId?: string } | undefined {
  const slash = id.indexOf('/')
  const kind = (slash < 0 ? id : id.slice(slash + 1)) as TProtocolKind
  const projectId = slash < 0 ? undefined : id.slice(0, slash)
  if (projectId === '' || !PROTOCOL_KINDS.includes(kind)) return undefined
  return { kind, ...(projectId ? { projectId } : {}) }
}

export function protocolDocument(addendum: IProtocolAddendum): ICatalogDocument {
  return documentOf('protocol', protocolItemId(addendum.kind, addendum.projectId), addendum.projectId, shaped(PROTOCOL_SHAPE, addendum))
}

/** O projeto leva o contexto inicial dele (ids dos docs, em ordem). */
export function projectDocument(project: IProject, initialContext: readonly string[]): ICatalogDocument {
  return documentOf('project', project.id, project.id, { ...shaped(PROJECT_SHAPE, project), initialContext: [...initialContext] })
}

/** As permissões do projeto: as regras na ordem da tela (ver `PERMISSION_RULE_SHAPE`). Sem `updatedAt`/`updatedBy`. */
export function projectPermissionsDocument(projectId: string, rules: readonly IPermissionRule[]): ICatalogDocument {
  return documentOf('project-permissions', projectId, projectId, { projectId, rules: field({ list: PERMISSION_RULE_SHAPE }, rules) })
}

/** O que o servidor pede ao cofre: `env:<NOME>` por variável e `header` com `auth: header`. Ordenado. */
export function mcpSecretRefs(server: IMcpServerConfig): string[] {
  return [...mcpEnvNames(server).map((name) => `env:${name}`), ...(server.auth === 'header' ? ['header'] : [])].sort(byText)
}

export function mcpDocument(server: IMcpServerConfig): ICatalogDocument {
  return documentOf('mcp', server.id, server.projectId, { ...shaped(MCP_SHAPE, server), secrets: mcpSecretRefs(server) })
}
