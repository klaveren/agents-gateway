import { createHash } from 'node:crypto'
import type { ICatalogDocument, TCatalogKind } from './Catalog.Document'
import { EMode } from './enums/EMode.Enum'
import type { IAgentTarget } from './models/Agent.Model'
import { AGENT_TOOL_PREFIX } from './models/Delegation.Model'
import type { IMcpContainer, IMcpProcess, TMcpAuth } from './models/McpServer.Model'
import { MCP_ALL_TOOLS, MCP_TOOL_PREFIX } from './models/McpServer.Model'
import type { IAgentResources } from './models/Resource.Model'
import type { IPermissionRule, TPermissionCategory } from './Permission.Policy'
import { CATEGORY_LABEL, commandMatches, globToRegex, pathMatches } from './Permission.Policy'
import type { TSandboxLevel } from './Sandbox.Policy'

/**
 * O DETECTOR DE AMPLIAÇÃO: o que a troca de um item do catálogo (`before` → `after`) AMPLIA de acesso. O import, o
 * rollback e a reversão de lote só aplicam se o pedido trouxer em `confirm` exatamente as chaves que o servidor calculou
 * aqui (ver docs/integration/plano-catalogo-historico.md §2.4). ⛔ Import por token nunca aplica ampliação: só admin
 * pela tela.
 *
 * ⚖️ NA DÚVIDA, TRAVA. Toda regra responde "provou que não amplia?"; o que não dá para provar conta como ampliação.
 *
 * ⚖️ ITEM NOVO (`before` ausente) é comparado com o item VAZIO: tudo o que ele concede é ampliação. ITEM APAGADO
 * (`after` ausente) nunca amplia — exceto as permissões do projeto, que são a camada de baixo de todo agente do projeto:
 * apagá-las tira as negações.
 *
 * Função pura: mesma entrada, mesma saída, em qualquer ordem das listas (a saída sai ordenada pela chave).
 */

export type TWideningCategory =
  /** Regra de permissão: `allow` novo ou mais amplo, `deny` removido ou estreitado (agente ou projeto). */
  | 'permission'
  /** `allowedTools` ganhou ferramenta (`cap:`, `sdk:`, `mcp:`, local), ou o agente ganhou a lane que as roda. */
  | 'tool'
  /** `allowedTools` ganhou `agent:<id>`. */
  | 'delegation'
  /** Quem alcança o agente: `adminOnly` saiu, `role` saiu ou mudou. */
  | 'exposure'
  /** Onde o item vale: agente ou MCP que vira global ou muda de projeto; MCP novo global. */
  | 'scope'
  /** Sandbox do provider mais solto, rede ligada. */
  | 'sandbox'
  /** Skills e commands liberados ao agente. */
  | 'resources'
  /** Variável de ambiente do agente nova ou alterada (muda o que um comando liberado faz). */
  | 'environment'
  /** O que o MCP é e alcança: novo, ligado, outro código, rede, gravação, credencial. */
  | 'mcp-reach'
  /** O MCP passa a receber a identidade de quem chama. */
  | 'identity'

export const WIDENING_CATEGORY_LABEL: Readonly<Record<TWideningCategory, string>> = {
  permission: 'permissão',
  tool: 'ferramenta',
  delegation: 'delegação',
  exposure: 'exposição',
  scope: 'escopo',
  sandbox: 'sandbox e rede',
  resources: 'recursos liberados',
  environment: 'ambiente',
  'mcp-reach': 'alcance do MCP',
  identity: 'identidade enviada',
}

export interface IWidening {
  kind: TCatalogKind
  id: string
  /** O escopo do item (o de `after`, ou o de `before` se ele foi apagado). */
  projectId?: string
  category: TWideningCategory
  /**
   * ESTÁVEL: `<kind>/<id>[@<projeto>]#<campo><op><valor>`, com `op` `+` (ganhou), `-` (perdeu) ou `~` (mudou para).
   * Ex.: `agent/theo#allowedTools+cap:terminal`. Texto livre longo vai como `h:<12 hex do sha256>`.
   */
  key: string
  /** Para quem confirma, em pt-BR. */
  description: string
}

// --- A entrada --------------------------------------------------------------------------------------------------

export function wideningsOf(before: ICatalogDocument | undefined, after: ICatalogDocument | undefined): IWidening[] {
  const doc = after ?? before
  if (!doc) return []
  if (before && after && (before.kind !== after.kind || before.id !== after.id))
    throw new TypeError(`catalog widening: ${before.kind}/${before.id} and ${after.kind}/${after.id} are not the same item`)
  const out = new Collector(doc)
  switch (doc.kind) {
    case 'agent':
      // Agente apagado não alcança nada.
      if (after) agentWidenings(out, before?.body as IAgentBody | undefined, after.body as IAgentBody)
      break
    case 'mcp':
      if (after) mcpWidenings(out, before?.body as IMcpBody | undefined, after.body as IMcpBody)
      break
    case 'project-permissions':
      // ⛔ Apagar as permissões do projeto tira as negações dele: compara com a lista vazia.
      rulesWidenings(out, 'rules', (before?.body as IRulesBody | undefined)?.rules ?? [], (after?.body as IRulesBody | undefined)?.rules ?? [])
      break
    default:
      // Skill, command, rule, docs, complemento, projeto: só "atenção" (§2.4), nunca trava.
      break
  }
  return out.list()
}

/** As chaves, sem repetição e ordenadas: o conjunto que o `confirm` tem de trazer. */
export function wideningKeys(widenings: readonly IWidening[]): string[] {
  return [...new Set(widenings.map((item) => item.key))].sort(byText)
}

/** O `confirm` do pedido é EXATAMENTE o conjunto calculado (nem a mais, nem a menos; ordem e repetição não contam). */
export function confirmsWidenings(confirm: readonly string[], widenings: readonly IWidening[]): boolean {
  const want = wideningKeys(widenings)
  const got = [...new Set(confirm)].sort(byText)
  return want.length === got.length && want.every((key, index) => key === got[index])
}

// --- O corpo dos documentos (a forma de `Catalog.Document`) ------------------------------------------------------

interface IAgentBody {
  allowedTools?: string[]
  modes?: string[]
  role?: string
  adminOnly?: boolean
  projectId?: string
  permissions?: IPermissionRule[]
  providers?: IAgentTarget[]
  env?: Record<string, string>
  resources?: IAgentResources
}

interface IMcpBody {
  kind?: string
  url?: string
  auth?: TMcpAuth
  identity?: boolean
  enabled?: boolean
  projectId?: string
  container?: Partial<IMcpContainer>
  process?: Partial<IMcpProcess>
}

interface IRulesBody {
  rules?: IPermissionRule[]
}

// --- Agente -------------------------------------------------------------------------------------------------------

const MCP_ALL = new RegExp(`^${MCP_TOOL_PREFIX}([^/]+)/\\${MCP_ALL_TOOLS}$`)

/** A ferramenta já estava liberada antes: a mesma string, ou `mcp:<srv>/<x>` sob um `mcp:<srv>/*`. */
function toolCovered(tool: string, before: ReadonlySet<string>): boolean {
  if (before.has(tool)) return true
  const slash = tool.indexOf('/')
  return tool.startsWith(MCP_TOOL_PREFIX) && slash > 0 && before.has(`${tool.slice(0, slash)}/${MCP_ALL_TOOLS}`)
}

/**
 * ⚖️ O sandbox em ordem do mais fechado ao mais aberto. Ausente = o padrão (`read-only`). Nível desconhecido conta como
 * o mais aberto: não dá para provar que é mais fechado.
 */
const SANDBOX_RANK: Readonly<Record<TSandboxLevel, number>> = { 'read-only': 0, 'workspace-write': 1, full: 2 }
const sandboxRank = (level: string | undefined) => (level === undefined ? 0 : (SANDBOX_RANK[level as TSandboxLevel] ?? Number.MAX_SAFE_INTEGER))

/** O papel que só FECHA (não abre conversa direta). Passar a ele não amplia; sair dele, ou trocar por outro, sim. */
const CLOSING_ROLE = 'subagent'

function agentWidenings(out: Collector, before: IAgentBody | undefined, after: IAgentBody): void {
  const isNew = !before
  const was: IAgentBody = before ?? {}

  // Ferramentas e delegação.
  const tools = new Set(was.allowedTools ?? [])
  for (const tool of after.allowedTools ?? []) {
    if (toolCovered(tool, tools)) continue
    const allOf = MCP_ALL.exec(tool)?.[1]
    if (tool.startsWith(AGENT_TOOL_PREFIX)) out.add('delegation', `allowedTools+${tool}`, `passa a delegar ao agente "${tool.slice(AGENT_TOOL_PREFIX.length)}"`)
    else if (allOf) out.add('tool', `allowedTools+${tool}`, `ganha todas as ferramentas do MCP "${allOf}"`)
    else out.add('tool', `allowedTools+${tool}`, `ganha a ferramenta "${tool}"`)
  }
  // A lane `agent` é a que roda ferramenta; ganhá-la liga as que já estavam lá. No item novo, as ferramentas já entram.
  if (!isNew && (after.allowedTools ?? []).length)
    for (const mode of after.modes ?? [])
      if (mode !== EMode.CHAT && !(was.modes ?? []).includes(mode)) out.add('tool', `modes+${mode}`, `passa a rodar na lane "${mode}" (com ferramentas)`)

  rulesWidenings(out, 'permissions', was.permissions ?? [], after.permissions ?? [])

  // Exposição.
  if (was.adminOnly && !after.adminOnly) out.add('exposure', 'adminOnly-', 'deixa de ser só para admin: qualquer pessoa conversa com ele')
  if (was.role !== after.role && !(was.role === undefined && after.role === CLOSING_ROLE)) {
    if (after.role === undefined) out.add('exposure', `role-${was.role}`, `deixa de ser "${was.role}": passa a abrir conversa direta`)
    else out.add('exposure', `role~${after.role}`, `papel muda de "${was.role ?? 'normal'}" para "${after.role}"`)
  }

  // Escopo. Agente novo global não conta sozinho: o que ele alcança aparece nas ferramentas e regras dele.
  if (!isNew && was.projectId && was.projectId !== after.projectId) {
    if (!after.projectId) out.add('scope', 'projectId-', `deixa o projeto "${was.projectId}" e vira global (todos os projetos)`)
    else out.add('scope', `projectId~${after.projectId}`, `muda do projeto "${was.projectId}" para "${after.projectId}"`)
  }

  // Sandbox e rede, provider a provider (o que não existia antes é comparado com o padrão).
  const targets = new Map((was.providers ?? []).map((target) => [target.provider, target]))
  for (const target of after.providers ?? []) {
    const old = targets.get(target.provider)
    if (sandboxRank(target.sandbox) > sandboxRank(old?.sandbox))
      out.add(
        'sandbox',
        `providers.${target.provider}.sandbox~${target.sandbox}`,
        `sandbox em "${target.provider}" passa de "${old?.sandbox ?? 'read-only'}" a "${target.sandbox}"`,
      )
    if (target.network && !old?.network) out.add('sandbox', `providers.${target.provider}.network+`, `rede ligada no sandbox de "${target.provider}"`)
  }

  // Recursos: o documento traz o efetivo (`['*']` = todos, `[]` = nenhum). Item novo parte de nenhum.
  for (const field of ['skills', 'commands'] as const) {
    const old = was.resources?.[field] ?? []
    const now = after.resources?.[field] ?? []
    if (old.includes('*')) continue
    if (now.includes('*')) {
      out.add('resources', `resources.${field}+*`, `passa a usar ${field === 'skills' ? 'todas as skills' : 'todos os commands'} do escopo`)
      continue
    }
    for (const id of now) if (!old.includes(id)) out.add('resources', `resources.${field}+${id}`, `passa a usar ${field === 'skills' ? 'a skill' : 'o command'} "${id}"`)
  }

  // Ambiente: muda o que um comando liberado faz (`GIT_CONFIG_*`, `GIT_SSH_COMMAND`…).
  const env = was.env ?? {}
  for (const [name, value] of Object.entries(after.env ?? {})) {
    if (!(name in env)) out.add('environment', `env+${name}=${digest(value)}`, `nova variável de ambiente ${name}="${value}"`)
    else if (env[name] !== value) out.add('environment', `env~${name}=${digest(value)}`, `variável de ambiente ${name} muda para "${value}"`)
  }

  // ⚖️ Triggers NÃO contam (decisão do dono, 30/10): são texto, como o prompt.
}

// --- MCP ----------------------------------------------------------------------------------------------------------

function mcpWidenings(out: Collector, before: IMcpBody | undefined, after: IMcpBody): void {
  const was: IMcpBody = before ?? {}
  const kind = after.kind ?? 'remote'
  const isNew = !before

  if (isNew) out.add('mcp-reach', `new~${kind}:${mcpTarget(after)}`, `MCP novo (${kind}: ${mcpTarget(after)})${after.enabled ? '' : ', desligado'}`)
  else {
    if (kind !== (was.kind ?? 'remote')) out.add('mcp-reach', `kind~${kind}`, `tipo muda de "${was.kind ?? 'remote'}" para "${kind}"`)
    for (const [field, now, old] of [
      ['url', after.url, was.url],
      ['container.image', after.container?.image, was.container?.image],
      ['process.package', after.process?.package, was.process?.package],
      ['process.command', after.process?.command, was.process?.command],
    ] as const)
      if (now && now !== old) out.add('mcp-reach', `${field}~${now}`, `${field} muda para "${now}"`)
    for (const [field, now, old] of [
      ['container.args', after.container?.args, was.container?.args],
      ['process.args', after.process?.args, was.process?.args],
    ] as const)
      if (now?.length && JSON.stringify(now) !== JSON.stringify(old ?? [])) out.add('mcp-reach', `${field}~${digest(now.join(' '))}`, `argumentos mudam para "${now.join(' ')}"`)
    if (after.enabled && !was.enabled) out.add('mcp-reach', 'enabled+', 'ligado')
  }

  // Credencial: `none` é a única provadamente mais fechada.
  const auth = after.auth ?? 'none'
  if (auth !== 'none' && auth !== (was.auth ?? 'none'))
    out.add('mcp-reach', `auth~${auth}`, auth === 'caller' ? 'passa a receber a credencial de quem conversa' : 'passa a receber o segredo fixo do cadastro')

  if (after.container?.network === 'allowlist' && was.container?.network !== 'allowlist')
    out.add('mcp-reach', 'container.network~allowlist', 'contêiner ganha rede (lista de domínios)')
  for (const [field, label] of [
    ['allowedHosts', 'domínio liberado'],
    ['writable', 'caminho gravável'],
  ] as const) {
    const old = new Set(was.container?.[field] ?? [])
    for (const item of after.container?.[field] ?? []) if (!old.has(item)) out.add('mcp-reach', `container.${field}+${item}`, `${label}: "${item}"`)
  }
  if (after.process?.scope === 'shared' && was.process?.scope !== 'shared')
    out.add('mcp-reach', 'process.scope~shared', 'um processo só para todas as conversas (estado compartilhado)')

  if (after.identity && !was.identity) out.add('identity', 'identity+', 'passa a receber a identidade de quem chama (agente, conversa, projeto)')

  // Escopo: global serve a todo agente. O novo parte "de projeto": nascer global é ampliação.
  const wasGlobal = !isNew && !was.projectId
  if (!after.projectId && !wasGlobal) out.add('scope', 'projectId-', isNew ? 'global: serve a todo agente de todo projeto' : `deixa o projeto "${was.projectId}" e vira global`)
  else if (after.projectId && was.projectId && after.projectId !== was.projectId)
    out.add('scope', `projectId~${after.projectId}`, `muda do projeto "${was.projectId}" para "${after.projectId}"`)
}

function mcpTarget(body: IMcpBody): string {
  return body.url || body.container?.image || body.process?.package || body.process?.command || '?'
}

// --- Regras de permissão (agente e projeto) ----------------------------------------------------------------------

/**
 * ⚖️ Negar vence permitir dentro da camada, e a do agente decide antes da do projeto. Por isso:
 * - um `allow` de `after` que nenhum `allow` de `before` (da mesma categoria) COBRE é ampliação;
 * - um `deny` de `before` que nenhum `deny` de `after` (da mesma categoria) COBRE é ampliação (removido ou estreitado).
 * `deny` novo, `allow` removido, nota e ordem nunca ampliam. Mudar a categoria de uma regra = uma regra nova.
 */
function rulesWidenings(out: Collector, field: string, before: readonly IPermissionRule[], after: readonly IPermissionRule[]): void {
  const of = (rules: readonly IPermissionRule[], decision: IPermissionRule['decision']) => rules.filter((rule) => rule.decision === decision)
  const covered = (rule: IPermissionRule, by: readonly IPermissionRule[]) =>
    by.some((other) => other.category === rule.category && patternCovers(rule.category, other.pattern, rule.pattern))
  for (const rule of of(after, 'allow')) {
    if (covered(rule, of(before, 'allow'))) continue
    const had = of(before, 'allow').some((other) => other.category === rule.category)
    out.add(
      'permission',
      `${field}+allow:${rule.category}:${rule.pattern.trim()}`,
      `permite ${CATEGORY_LABEL[rule.category]} "${rule.pattern.trim()}"${had ? ' (mais amplo ou não comparável com o que havia)' : ''}`,
    )
  }
  for (const rule of of(before, 'deny')) {
    if (covered(rule, of(after, 'deny'))) continue
    const has = of(after, 'deny').some((other) => other.category === rule.category)
    out.add(
      'permission',
      `${field}-deny:${rule.category}:${rule.pattern.trim()}`,
      `${has ? 'estreita' : 'remove'} a negação de ${CATEGORY_LABEL[rule.category]} "${rule.pattern.trim()}"`,
    )
  }
}

// --- Comparar globs ------------------------------------------------------------------------------------------------

/**
 * O padrão `wide` COBRE o `narrow` (tudo o que `narrow` casa, `wide` também casa)? ⚖️ CORRETO, NÃO COMPLETO: `true` só
 * quando dá para PROVAR pela semântica de `Permission.Policy.matches`; o resto é `false` — "não comparável" —, e quem
 * chama trata como ampliação. Os casos provados, por categoria:
 * - iguais (depois de aparar) — sempre;
 * - `narrow` LITERAL (sem curinga): `wide` casa o próprio `narrow` como pedido;
 * - PREFIXO: `wide` é um prefixo literal seguido do curinga total da categoria, e `narrow` começa por esse prefixo
 *   (terminal `git push *` cobre `git push origin *`; caminho `src/**` cobre `src/a/*.ts`; texto `akm-*` cobre `akm-x*`;
 *   rede `*.x.com` cobre `*.a.x.com`). O curinga total sozinho (`*`; caminho `**`/`*`) cobre tudo;
 * - caminho: só se os dois forem relativos ou os dois absolutos (a liberação relativa não alcança fora da pasta).
 */
export function patternCovers(category: TPermissionCategory, wide: string, narrow: string): boolean {
  const a = wide.trim()
  const b = narrow.trim()
  if (a === b) return true
  switch (category) {
    case 'terminal':
      return commandCovers(a, b)
    case 'read':
    case 'write':
      return pathCovers(a, b)
    case 'network':
      return hostCovers(a, b)
    default:
      return textCovers(a, b)
  }
}

/** Terminal: por palavras, e só o `*` é curinga (o `?` é literal). */
function commandCovers(wide: string, narrow: string): boolean {
  const want = wide.split(/\s+/)
  const got = narrow.split(/\s+/)
  // Literal: o nome do comando vale pela base, então com `/` no nome o pedido não seria o mesmo — não compara.
  if (!narrow.includes('*') && !got[0].includes('/')) return commandMatches(wide, got)
  const head = want.slice(0, -1)
  return want[want.length - 1] === '*' && !head.some((word) => word.includes('*')) && got.length >= head.length && head.every((word, index) => got[index] === word)
}

const OUTSIDE = (path: string) => path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)
const PATH_WILDCARD = /[*?]/

function pathCovers(wide: string, narrow: string): boolean {
  const a = wide.replace(/^\.\//, '')
  const b = narrow.replace(/^\.\//, '')
  if (OUTSIDE(a) !== OUTSIDE(b)) return false
  // `*` e `**` sem `/` casam o nome em qualquer pasta: tudo.
  if (/^\*+$/.test(a)) return true
  if (!PATH_WILDCARD.test(b)) {
    // Sem `/`, o `narrow` casa o nome em qualquer pasta: só um `wide` sem `/` (que também olha o nome) o cobre.
    if (!b.includes('/')) return !a.includes('/') && globToRegex(a).test(b)
    return pathMatches(a, b)
  }
  if (!a.endsWith('/**') || PATH_WILDCARD.test(a.slice(0, -3))) return false
  const prefix = b.slice(0, b.search(PATH_WILDCARD))
  return prefix.startsWith(a.slice(0, -2))
}

/** Rede: `host`, `*.dominio` (subdomínios) ou `*`, com porta opcional. O `*` em outra posição é literal. */
function hostCovers(wide: string, narrow: string): boolean {
  const [wantHost, wantPort] = splitHost(wide.toLowerCase())
  const [host, port] = splitHost(narrow.toLowerCase())
  if (wantPort !== undefined && wantPort !== port) return false
  if (wantHost === '*') return true
  if (host === '*') return false
  if (host.startsWith('*.')) return wantHost.startsWith('*.') && (host === wantHost || host.endsWith(wantHost.slice(1)))
  if (wantHost.startsWith('*.')) return host.endsWith(wantHost.slice(1)) && host.length > wantHost.length - 1
  return host === wantHost
}

function splitHost(value: string): [string, string | undefined] {
  const at = value.lastIndexOf(':')
  return at > 0 && /^\d+$/.test(value.slice(at + 1)) ? [value.slice(0, at), value.slice(at + 1)] : [value, undefined]
}

/** MCP, skill, delegação, conta, repositório, trigger: o texto inteiro, com `*` = qualquer coisa. */
function textCovers(wide: string, narrow: string): boolean {
  if (!narrow.includes('*')) return new RegExp(`^${wide.split('*').map(escapeRegex).join('.*')}$`).test(narrow)
  return wide.endsWith('*') && !wide.slice(0, -1).includes('*') && narrow.startsWith(wide.slice(0, -1))
}

const escapeRegex = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

// --- Coleta ------------------------------------------------------------------------------------------------------

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Texto livre na chave: curto e estável. */
const digest = (text: string) => `h:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`

const KIND_LABEL: Readonly<Partial<Record<TCatalogKind, string>>> = { agent: 'Agente', mcp: 'MCP', 'project-permissions': 'Permissões do projeto' }

class Collector {
  private readonly items = new Map<string, IWidening>()
  private readonly ref: string
  private readonly label: string

  constructor(private readonly doc: ICatalogDocument) {
    const scope = doc.projectId && doc.projectId !== doc.id ? `@${doc.projectId}` : ''
    this.ref = `${doc.kind}/${doc.id}${scope}`
    this.label = `${KIND_LABEL[doc.kind] ?? doc.kind} ${doc.id}${scope ? ` (projeto ${doc.projectId})` : ''}`
  }

  add(category: TWideningCategory, detail: string, description: string): void {
    const key = `${this.ref}#${detail}`
    if (this.items.has(key)) return
    const { kind, id, projectId } = this.doc
    this.items.set(key, { kind, id, ...(projectId ? { projectId } : {}), category, key, description: `${this.label}: ${description}` })
  }

  list(): IWidening[] {
    return [...this.items.values()].sort((a, b) => byText(a.key, b.key))
  }
}
