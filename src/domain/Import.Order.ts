import { posix } from 'node:path'
import { IOpencodeReach, IReachLine, IReachWidening, ocMatch, translatePermission, translateReach } from './Import.Permissions'
import { decide } from './Permission.Policy'
import { CANDIDATE_ID_MAX, IInventoryItem, IInventoryNote, TCatalogState, TInventoryKind } from './models/ImportInventory.Model'
import {
  IImportPlan,
  IPlanCycle,
  IPlanEstimate,
  IPlanExclusion,
  IPlanIdEntry,
  IPlanLink,
  IPlanMcp,
  IPlanPhaseInfo,
  IPlanProject,
  IPlanReach,
  IPlanReleased,
  IPlanStep,
  TPlanPhase,
  TPlanWhy,
} from './models/ImportPlan.Model'
import { IDetectedReach } from './ports/FormatDetector.Port'

/**
 * O LOTE de um agente, puro (`docs/integration/plano-importador.md`, §3 e §4): o FECHO (o que o agente precisa), a
 * ORDEM por fase com as dependências e os ciclos, o MAPA DE IDS com prefixo e colisão, o ALCANCE ligado ao tradutor
 * (`Import.Permissions`) e a ESTIMATIVA de custo.
 *
 * ⛔ Só leitura: nada daqui grava, chama modelo ou dispara construtor. O dono decide e clica, item a item.
 *
 * ⚖️ As regras:
 * - fecho = o agente, os triggers dele e o que eles citam, TRANSITIVO pelas citações resolvidas (spec, ADR, knowledge,
 *   skill, command, rule). Outro agente não entra (a delegação é vínculo, fase 5); o que não resolve fica de fora, com
 *   o motivo. As `instructions` do opencode entram para o agente do opencode: lá, todo agente as recebia;
 * - ordem = a fase manda (docs → skills/commands → rules → agente com triggers → vínculos → alcance → projeto); dentro
 *   da fase, quem é citado vem antes. Ciclo não trava: a fase ou a ordem alfabética decide, e o ciclo é reportado;
 * - id = o candidato da varredura, com o prefixo nos tipos de id legível (agente, skill, command, docs). Id que já existe
 *   em outro projeto, ou global, ou repetido no lote, BLOQUEIA;
 * - alcance = o agente nasce FECHADO; as regras traduzidas, as ampliações e o `resources.skills` vêm depois, confirmados.
 *   O `skill * allow` do global nunca entra automático.
 */

export const PLAN_PHASE_LABEL: Readonly<Record<TPlanPhase, string>> = {
  1: 'docs: knowledge, specs e ADRs',
  2: 'skills e commands',
  3: 'rules do projeto',
  4: 'agente fechado, com os triggers',
  5: 'vínculos entre agentes',
  6: 'alcance do agente (confirmado)',
  7: 'permissões do projeto (confirmadas)',
}

const PHASE_OF: Partial<Record<TInventoryKind, TPlanPhase>> = { knowledge: 1, spec: 1, adr: 1, skill: 2, command: 2, rule: 3, agent: 4, trigger: 4 }
const KIND_RANK: Partial<Record<TInventoryKind, number>> = { knowledge: 0, spec: 1, adr: 2, skill: 3, command: 4, rule: 5, agent: 6, trigger: 7 }
/** O que o fecho arrasta por citação. */
const CONTENT: ReadonlySet<TInventoryKind> = new Set(['spec', 'adr', 'knowledge', 'skill', 'command', 'rule'])
/** Os tipos de id legível: levam o prefixo, e o id é único no gateway (global igual também colide). */
export const PREFIXED_KINDS: readonly TInventoryKind[] = ['agent', 'skill', 'command', 'spec', 'adr', 'knowledge']
/** O espaço de ids de cada tipo (dois itens do mesmo espaço com o mesmo id: um sobrescreveria o outro). */
const NAMESPACE: Partial<Record<TInventoryKind, string>> = { spec: 'doc', adr: 'doc', knowledge: 'doc', skill: 'resource', command: 'resource', agent: 'agent' }

/** O prefixo de id: minúsculas, dígitos e `-`, até 16 caracteres (`akm-`). */
export const IMPORT_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/

/** A chave da configuração do opencode (o `permission` global mora nela). */
export const CONFIG_KEY = 'config:opencode'

export interface IPlanCatalogQuery {
  kind: TInventoryKind
  id: string
  parent?: string
  title?: string
}

export interface IAgentBatchInput {
  items: readonly IInventoryItem[]
  /** A chave do agente (`agent:<id>`). */
  agent: string
  prefix?: string
  /** O alcance cru por chave de item (o do agente e o global em `config:opencode`), com o nome do bloco na origem. */
  reach: ReadonlyMap<string, IDetectedReach & { name: string }>
  /** Nome do agente na origem → chave do item. */
  agentByName: ReadonlyMap<string, string>
  /** As `instructions` do opencode (caminhos achados e citações quebradas): valem para o agente do opencode. */
  instructions?: IClosureInstructions
  /** O estado no catálogo de um id PROPOSTO (com o prefixo). Sem prefixo, vale o que a varredura já disse. */
  catalog: (query: IPlanCatalogQuery) => TCatalogState
  /** ≈ tokens do protocolo do construtor de cada tipo (o trigger usa o do agente). */
  protocolTokens: (kind: TInventoryKind) => number
}

export type TAgentBatch = Omit<IImportPlan, 'projectId' | 'repository' | 'head' | 'dirty' | 'plannedAt'>

// ── Fecho ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IClosureMember {
  key: string
  why: TPlanWhy
  citedBy: Set<string>
}

export interface IClosureInstructions {
  /** A chave da configuração que as declara. */
  from: string
  paths: readonly string[]
  unresolved: readonly string[]
}

export interface IClosure {
  members: Map<string, IClosureMember>
  excluded: IPlanExclusion[]
}

const EXCLUDE_BY_KIND: Partial<Record<TInventoryKind, IPlanExclusion['reason']>> = {
  unknown: 'unclassified',
  skip: 'out-of-catalog',
  config: 'config',
  agent: 'other-agent',
  trigger: 'other-agent',
}

function exclusionText(reason: IPlanExclusion['reason'], subject: string): string {
  switch (reason) {
    case 'broken':
      return `citação quebrada: ${subject} não existe no repositório`
    case 'no-item':
      return `${subject}: arquivo sem item (nenhum formato o classifica como recurso)`
    case 'other-agent':
      return `${subject}: outro agente não entra no lote (a delegação é vínculo, fase 5)`
    case 'unclassified':
      return `${subject}: desconhecido; reclassifique na tela para entrar`
    case 'out-of-catalog':
      return `${subject}: fica fora do catálogo`
    case 'config':
      return `${subject}: configuração, não é recurso`
    default:
      return subject
  }
}

/**
 * O FECHO de um agente: ele, os triggers dele e o que eles citam, transitivo. `instructions`: as citações da
 * configuração que valem para o agente (o opencode as dava a todo agente).
 */
export function agentClosure(items: readonly IInventoryItem[], agentKey: string, instructions?: IClosureInstructions): IClosure {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const members = new Map<string, IClosureMember>()
  const excluded = new Map<string, IPlanExclusion>()
  const queue: IInventoryItem[] = []
  const exclude = (entry: IPlanExclusion) => excluded.set(`${entry.from}|${entry.reason}|${entry.path ?? ''}|${entry.item ?? ''}|${entry.code ?? ''}`, entry)
  const add = (item: IInventoryItem, why: TPlanWhy, from?: string) => {
    let member = members.get(item.key)
    if (!member) {
      member = { key: item.key, why, citedBy: new Set() }
      members.set(item.key, member)
      queue.push(item)
    }
    if (from && from !== item.key) member.citedBy.add(from)
  }
  const agent = byKey.get(agentKey)
  if (!agent || agent.kind !== 'agent') return { members, excluded: [] }
  add(agent, 'agent')
  for (const item of items) if (item.kind === 'trigger' && item.parent === agentKey) add(item, 'trigger', agentKey)

  const follow = (item: IInventoryItem, why: TPlanWhy, own: boolean) => {
    for (const ref of item.refs) {
      if (!ref.item) {
        exclude({ from: item.key, reason: 'no-item', path: ref.path, text: exclusionText('no-item', ref.path) })
        continue
      }
      const target = byKey.get(ref.item)
      if (!target || members.get(target.key)?.why === 'trigger' || target.key === agentKey) continue
      if (CONTENT.has(target.kind)) add(target, why, own ? item.key : undefined)
      else if (target.kind !== 'mcp') {
        const reason = EXCLUDE_BY_KIND[target.kind] ?? 'out-of-catalog'
        exclude({ from: item.key, reason, path: ref.path, item: target.key, text: exclusionText(reason, target.key) })
      }
    }
    for (const path of item.unresolved) exclude({ from: item.key, reason: 'broken', path, text: exclusionText('broken', path) })
  }

  const config = instructions ? byKey.get(instructions.from) : undefined
  if (config && instructions) {
    const paths = new Set(instructions.paths)
    follow({ ...config, refs: config.refs.filter((ref) => paths.has(ref.path)), unresolved: [...instructions.unresolved] }, 'instructions', false)
  }
  while (queue.length) {
    const item = queue.shift()!
    follow(item, 'cited', true)
    for (const note of item.notes) if (note.level === 'untranslatable') exclude({ from: item.key, reason: 'untranslatable', code: note.code, text: note.text })
  }
  return { members, excluded: [...excluded.values()] }
}

// ── Ordem ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const rank = (item: IInventoryItem) => KIND_RANK[item.kind] ?? 99
const before = (a: IInventoryItem, b: IInventoryItem) => rank(a) - rank(b) || a.key.localeCompare(b.key)

/** As dependências de um membro: o que ele cita no lote (e o trigger, o agente dono). O agente não depende dos triggers. */
function dependencies(item: IInventoryItem, members: ReadonlyMap<string, unknown>, byKey: ReadonlyMap<string, IInventoryItem>): string[] {
  const deps = new Set<string>()
  for (const ref of item.refs) {
    if (!ref.item || ref.item === item.key || !members.has(ref.item)) continue
    const target = byKey.get(ref.item)!
    if (item.kind === 'agent' && target.kind === 'trigger' && target.parent === item.key) continue
    deps.add(ref.item)
  }
  if (item.kind === 'trigger' && item.parent && members.has(item.parent)) deps.add(item.parent)
  return [...deps].sort()
}

/** Os componentes fortemente conexos (Tarjan) com mais de um item: os ciclos. */
function stronglyConnected(keys: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  const visit = (key: string) => {
    index.set(key, counter)
    low.set(key, counter)
    counter += 1
    stack.push(key)
    onStack.add(key)
    for (const next of edges.get(key) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(key, Math.min(low.get(key)!, low.get(next)!))
      } else if (onStack.has(next)) low.set(key, Math.min(low.get(key)!, index.get(next)!))
    }
    if (low.get(key) !== index.get(key)) return
    const component: string[] = []
    let top: string
    do {
      top = stack.pop()!
      onStack.delete(top)
      component.push(top)
    } while (top !== key)
    if (component.length > 1) out.push(component.sort())
  }
  for (const key of keys) if (!index.has(key)) visit(key)
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

export interface IBatchOrder {
  /** As chaves, na ordem. */
  order: string[]
  deps: Map<string, string[]>
  cycles: IPlanCycle[]
}

/** A ORDEM do lote: por fase; dentro da fase, quem é citado antes (Kahn), desempatando por tipo e chave. */
export function orderBatch(items: readonly IInventoryItem[], memberKeys: Iterable<string>): IBatchOrder {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const members = new Map([...memberKeys].filter((key) => byKey.has(key) && PHASE_OF[byKey.get(key)!.kind]).map((key) => [key, byKey.get(key)!]))
  const deps = new Map([...members.values()].map((item) => [item.key, dependencies(item, members, byKey)]))
  const phase = (key: string) => PHASE_OF[members.get(key)!.kind]!

  const order: string[] = []
  const placed = new Set<string>()
  for (const current of [1, 2, 3, 4] as const) {
    const remaining = [...members.values()].filter((item) => phase(item.key) === current).sort(before)
    while (remaining.length) {
      const ready = remaining.findIndex((item) => deps.get(item.key)!.every((dep) => placed.has(dep) || phase(dep) !== current))
      // Ciclo dentro da fase: entra o primeiro pela ordem, e cita os outros pelo id do mapa.
      const [next] = remaining.splice(Math.max(ready, 0), 1)
      order.push(next.key)
      placed.add(next.key)
    }
  }

  // Só o ciclo DENTRO da fase pede desempate: a citação para uma fase posterior é resolvida pela fase (fica em `forward`).
  const samePhase = new Map([...deps.entries()].map(([key, list]) => [key, list.filter((dep) => phase(dep) === phase(key))]))
  const cycles = stronglyConnected([...members.keys()].sort(), samePhase).map((keys): IPlanCycle => {
    const first = order.find((key) => keys.includes(key))!
    return {
      keys,
      brokenBy: 'order',
      text: `ciclo de citações entre ${keys.join(', ')}: ${first} entra antes (ordem por tipo e chave) e cita os outros pelo id do mapa`,
    }
  })
  return { order, deps, cycles }
}

// ── Mapa de ids ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** O id com o prefixo, cortado no limite do tipo. */
export function prefixedId(kind: TInventoryKind, id: string, prefix = ''): { id: string; cut: boolean } {
  if (!prefix || !PREFIXED_KINDS.includes(kind)) return { id, cut: false }
  const full = `${prefix}${id}`
  const max = CANDIDATE_ID_MAX[kind]
  if (!max || full.length <= max) return { id: full, cut: false }
  return { id: full.slice(0, max).replace(/-+$/g, ''), cut: true }
}

/**
 * O MAPA DE IDS: id de origem → id proposto, com o prefixo e o estado no catálogo. `conflict` (outro projeto, ou global
 * com id único) e `duplicate` (dois itens do lote no mesmo id) bloqueiam.
 */
export function proposeIds(items: readonly IInventoryItem[], keys: readonly string[], prefix: string, catalog: IAgentBatchInput['catalog']): IPlanIdEntry[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const entries: IPlanIdEntry[] = []
  for (const key of keys) {
    const item = byKey.get(key)
    if (!item) continue
    const { id, cut } = prefixedId(item.kind, item.candidateId, prefix)
    const prefixed = id !== item.candidateId
    let parent: string | undefined
    let state: TCatalogState | undefined = item.catalog
    if (item.kind === 'trigger' && item.parent) {
      const owner = byKey.get(item.parent)
      parent = prefixedId('agent', owner?.candidateId ?? item.parent.slice('agent:'.length), prefix).id
      if (prefix) state = catalog({ kind: 'trigger', id, parent })
    } else if (prefixed) state = catalog({ kind: item.kind, id })
    const entry: IPlanIdEntry = {
      key,
      kind: item.kind,
      sourceId: item.candidateId,
      id,
      ...(item.title ? { title: item.title } : {}),
      ...(parent ? { parent } : {}),
      prefixed,
      cut,
      ...(state ? { catalog: state } : {}),
      state: 'new',
    }
    if (state === 'other-project') Object.assign(entry, { state: 'conflict', reason: `o id ${id} já existe em outro projeto: mude antes de transformar` })
    else if (state === 'global' && item.kind === 'rule') entry.reason = 'há uma rule global com o mesmo título: as duas valeriam'
    else if (state === 'global') Object.assign(entry, { state: 'conflict', reason: `o id ${id} já existe como global: mude antes de transformar` })
    else if (state === 'same-project') Object.assign(entry, { state: 'update', reason: 'já existe neste projeto: a importação atualiza' })
    if (cut) entry.reason = [entry.reason, 'cortado no limite do tipo com o prefixo'].filter(Boolean).join('; ')
    entries.push(entry)
  }
  const bySpace = new Map<string, IPlanIdEntry[]>()
  for (const entry of entries) {
    const space = entry.kind === 'trigger' ? `trigger:${entry.parent}` : entry.kind === 'rule' ? 'rule' : NAMESPACE[entry.kind]
    if (!space) continue
    const id = entry.kind === 'rule' ? (entry.title ?? entry.id).trim().toLowerCase() : entry.id
    bySpace.set(`${space}|${id}`, [...(bySpace.get(`${space}|${id}`) ?? []), entry])
  }
  for (const same of bySpace.values())
    if (same.length > 1)
      for (const entry of same)
        if (entry.state !== 'conflict')
          Object.assign(entry, {
            state: 'duplicate',
            reason: `o id ${entry.id} é proposto também para ${same
              .filter((other) => other !== entry)
              .map((other) => other.key)
              .join(', ')}`,
          })
  return entries
}

// ── Alcance ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** As entradas de uma chave do `permission` do opencode (texto vale para tudo). */
function entriesOf(value: unknown): Array<[string, unknown]> {
  if (typeof value === 'string') return [['*', value]]
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value)
  return []
}

/** A decisão do opencode para um valor: a ÚLTIMA entrada que casa vence; sem entrada no agente, vale o global. */
function opencodeAllows(key: string, value: string, agent?: IOpencodeReach['permission'], project?: IOpencodeReach['permission']): boolean | undefined {
  for (const layer of [agent, project]) {
    let decision: boolean | undefined
    for (const [pattern, action] of entriesOf(layer?.[key])) if (ocMatch(pattern, value)) decision = action === 'allow'
    if (decision !== undefined) return decision
  }
  return undefined
}

/** O servidor MCP é usado pelo agente: alguma ferramenta dele ligada em `tools`, ou liberada em `permission.mcp`. */
function usesServer(name: string, reach: IOpencodeReach): boolean {
  const own = (key: string) => key.startsWith(`${name}_`) || key.startsWith(`${name}*`)
  if (Object.entries(reach.tools ?? {}).some(([key, on]) => on === true && own(key))) return true
  return entriesOf(reach.permission?.mcp).some(([pattern, action]) => action === 'allow' && own(pattern))
}

const isUniversal = (pattern: string) => /^\*+$/.test(pattern.trim())

// ── O lote ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tokens que o construtor lê de um item: as fontes, sem o arquivo gerado quando as fontes dele estão no item, e sem a configuração dividida. */
function sourceTokens(item: IInventoryItem): number {
  const paths = new Set(item.sources.map((source) => source.path))
  // A fonte declarada é relativa ao gerado ou à raiz (como a citação).
  const declared = (generated: string, origin: string) => [posix.join(posix.dirname(generated), origin), posix.normalize(origin.replace(/^\/+/, ''))]
  return item.sources
    .filter((source) => source.role !== 'opencode')
    .filter((source) => !source.generated?.some((origin) => declared(source.path, origin).some((path) => path !== source.path && paths.has(path))))
    .reduce((sum, source) => sum + source.tokens, 0)
}

/** ≈ tokens de um objeto (o bloco do agente no `opencode.json`). */
const jsonTokens = (value: unknown) => Math.ceil(JSON.stringify(value ?? {}).length / 4)

const attentionNotes = (item: IInventoryItem): IInventoryNote[] => item.notes.filter((note) => note.level !== 'info')

/** O LOTE de um agente: fecho, ordem, mapa de ids, vínculos, alcance, permissões do projeto e estimativa. */
export function planAgentBatch(input: IAgentBatchInput): TAgentBatch {
  const prefix = input.prefix ?? ''
  const byKey = new Map(input.items.map((item) => [item.key, item]))
  const agent = byKey.get(input.agent)
  if (!agent || agent.kind !== 'agent') throw new Error(`não é agente do inventário: ${input.agent}`)
  const agentReach = input.reach.get(agent.key)
  const projectPermission = input.reach.get(CONFIG_KEY)?.permission
  const fromOpencode = !!agentReach

  const { members, excluded } = agentClosure(input.items, agent.key, fromOpencode ? input.instructions : undefined)
  const { order, deps, cycles } = orderBatch(input.items, members.keys())

  // ── Skills que a permissão do agente libera (antes do mapa: entram no mapa, fora do lote).
  const skills = input.items.filter((item) => item.kind === 'skill')

  // ── Vínculos (fase 5): os alvos de delegação do agente.
  const selfName = agentReach?.name
  const links: IPlanLink[] = []
  if (agentReach) {
    const names = new Set<string>([...input.agentByName.keys()])
    for (const [pattern, action] of entriesOf(agentReach.permission?.task)) if (action === 'allow' && !pattern.includes('*')) names.add(pattern)
    for (const name of [...names].sort()) {
      if (name === selfName || input.agentByName.get(name) === agent.key) continue
      if (!opencodeAllows('task', name, agentReach.permission, projectPermission)) continue
      const key = input.agentByName.get(name)
      const target = key ? byKey.get(key) : undefined
      const id = prefixedId('agent', target?.candidateId ?? name, prefix).id
      const state: TCatalogState | undefined = target ? (prefix ? input.catalog({ kind: 'agent', id }) : target.catalog) : input.catalog({ kind: 'agent', id })
      const exists = state === 'same-project' || state === 'global'
      const targetReach = key ? input.reach.get(key) : undefined
      const cycle = !!(targetReach && selfName && opencodeAllows('task', selfName, targetReach.permission, projectPermission))
      const linkState: IPlanLink['state'] = exists ? 'exists' : target ? 'pending' : 'unknown'
      const text = [
        linkState === 'exists'
          ? 'o alvo já existe no gateway: o vínculo entra na fase 5'
          : linkState === 'pending'
            ? 'o alvo não está no lote nem no gateway: o vínculo fica pendente até ele existir'
            : 'o alvo não está no inventário nem no gateway: pendente',
        cycle ? 'ciclo de delegação (ele também delega a este): não trava, os vínculos vêm depois dos dois agentes' : '',
      ]
        .filter(Boolean)
        .join('; ')
      links.push({ name, ...(key ? { key } : {}), id, state: linkState, cycle, text })
    }
  }

  // ── MCPs que o agente usa.
  const mcps: IPlanMcp[] = agentReach
    ? input.items
        .filter((item) => item.kind === 'mcp' && usesServer(item.candidateId, agentReach))
        .map((item) => ({ name: item.candidateId, key: item.key, id: item.candidateId, exists: item.catalog === 'global' || item.catalog === 'same-project' }))
    : []
  const mcpServers = Object.fromEntries(mcps.filter((mcp) => mcp.exists).map((mcp) => [mcp.name, { id: mcp.id }]))
  const agentsOption = Object.fromEntries(links.filter((link) => link.state === 'exists').map((link) => [link.name, link.id]))

  // ── Alcance (fase 6) e permissões do projeto (fase 7).
  const notes: IInventoryNote[] = []
  let reach: IPlanReach | undefined
  let allowedSkills: IInventoryItem[] = []
  let skillsFrom: 'agent-rules' | 'cited' = 'cited'
  if (agentReach) {
    const translation = translateReach(
      { ...(agentReach.permission ? { permission: agentReach.permission } : {}), ...(agentReach.tools ? { tools: agentReach.tools } : {}) },
      { self: agentReach.name, mcpServers, agents: agentsOption, ...(projectPermission ? { project: projectPermission } : {}) },
    )
    const skillRules = translation.rules.filter((rule) => rule.category === 'skill')
    if (skillRules.length) {
      skillsFrom = 'agent-rules'
      allowedSkills = skills.filter((skill) => decide({ category: 'skill', value: skill.candidateId }, { agent: translation.rules }).allowed)
    } else allowedSkills = skills.filter((skill) => members.has(skill.key))
    const reachNotes: IInventoryNote[] = [
      { level: 'info', code: 'reach-closed', text: 'o agente nasce FECHADO (sem allowedTools, permissões nem delegação); o alcance entra na fase 6, cada ampliação confirmada' },
    ]
    if (prefix && skillRules.length)
      reachNotes.push({
        level: 'attention',
        code: 'skill-rules-prefix',
        text: 'as regras `skill` usam os nomes da origem; com o prefixo, quem filtra as skills é `resources.skills`',
      })
    if (prefix && translation.rules.some((rule) => rule.category === 'delegate' && rule.pattern.includes('*')))
      reachNotes.push({ level: 'attention', code: 'delegate-glob-prefix', text: 'delegação por glob usa os nomes da origem; com o prefixo, não casa os ids novos' })
    reach = { format: 'opencode', sourceName: agentReach.name, translation, skills: { proposed: [], from: skillsFrom, notReleased: [], pending: [], note: '' }, notes: reachNotes }
  } else
    notes.push({
      level: 'attention',
      code: 'reach-none',
      text: 'o agente não tem alcance do opencode para traduzir: nasce fechado e o alcance é escolhido na tela',
    })

  let project: IPlanProject | undefined
  if (projectPermission && fromOpencode) {
    const lines: IReachLine[] = translatePermission(projectPermission, { mcpServers, agents: agentsOption }, 'project')
    const widenings: IReachWidening[] = lines.flatMap((line) =>
      line.widening ? line.rules.filter((rule) => rule.decision === 'allow').map((rule) => ({ rule, reason: line.widening! })) : [],
    )
    const projectNotes: IInventoryNote[] = [{ level: 'info', code: 'project-last', text: 'a camada mais larga: entra por último, e cada ampliação é confirmada à parte' }]
    if (lines.some((line) => line.rules.some((rule) => rule.category === 'skill' && rule.decision === 'allow' && isUniversal(rule.pattern))))
      projectNotes.push({
        level: 'attention',
        code: 'project-skill-all',
        text: '`skill * allow` do global liberaria TODAS as skills a todo agente do projeto: é ampliação, nunca automática. O agente do lote fica restrito por `resources.skills`',
      })
    project = { lines, widenings, notes: projectNotes }
  }

  // ── O mapa de ids: o lote, as skills liberadas e os alvos de vínculo ficam com o mesmo prefixo.
  const released = allowedSkills.filter((skill) => !members.has(skill.key))
  const idMap = proposeIds(input.items, [...order, ...released.map((skill) => skill.key)], prefix, input.catalog)
  const idOf = new Map(idMap.map((entry) => [entry.key, entry]))

  if (reach) {
    const cited = order.filter((key) => byKey.get(key)!.kind === 'skill')
    const allowedKeys = new Set(allowedSkills.map((skill) => skill.key))
    const proposed = allowedSkills.map((skill) => idOf.get(skill.key)!.id)
    const pending = allowedSkills.filter((skill) => !members.has(skill.key) && (idOf.get(skill.key)!.catalog ?? 'new') === 'new').map((skill) => idOf.get(skill.key)!.id)
    const notReleased = skillsFrom === 'agent-rules' ? cited.filter((key) => !allowedKeys.has(key)).map((key) => idOf.get(key)!.id) : []
    const wide = reach.translation.rules.some((rule) => rule.category === 'skill' && rule.decision === 'allow' && isUniversal(rule.pattern))
    const globalAll = entriesOf(projectPermission?.skill).some(([pattern, action]) => action === 'allow' && isUniversal(pattern))
    const note =
      skillsFrom === 'agent-rules'
        ? `as ${proposed.length} skill(s) que as regras do agente liberam${wide ? ' (⚠️ o agente libera `*`: é ampliação)' : ''}; \`*\` (todas do escopo) não é proposto`
        : `o agente não tem regra de skill: na origem valia o global${globalAll ? ' (`skill * allow` = todas)' : ''}. Proposta: só as ${proposed.length} que ele cita; \`*\` seria ampliação`
    reach.skills = { proposed, from: skillsFrom, notReleased, pending, note }
    if (notReleased.length)
      reach.notes.push({
        level: 'attention',
        code: 'skill-not-released',
        text: `citada(s) mas a permissão do agente não libera: ${notReleased.join(', ')} (fica fora de resources.skills)`,
      })
  }

  // ── Os passos e a estimativa.
  const position = new Map(order.map((one, at) => [one, at]))
  const steps: IPlanStep[] = order.map((key) => {
    const item = byKey.get(key)!
    const member = members.get(key)!
    const mine = deps.get(key) ?? []
    const id = idOf.get(key)!
    const tokens = sourceTokens(item) + (item.kind === 'agent' && agentReach ? jsonTokens({ permission: agentReach.permission, tools: agentReach.tools }) : 0)
    return {
      phase: PHASE_OF[item.kind]!,
      key,
      kind: item.kind,
      id: id.id,
      ...(item.title ? { title: item.title } : {}),
      why: member.why,
      citedBy: [...member.citedBy].sort(),
      dependsOn: mine.filter((dep) => position.get(dep)! < position.get(key)!),
      forward: mine.filter((dep) => position.get(dep)! > position.get(key)!),
      tokens: { sources: tokens, protocol: input.protocolTokens(item.kind) },
      state: id.state,
      notes: attentionNotes(item),
    }
  })

  const byKind: IPlanEstimate['byKind'] = {}
  let sourceSum = 0
  let protocolSum = 0
  for (const step of steps) {
    const entry = (byKind[step.kind] ??= { conversations: 0, inputTokens: 0 })
    entry.conversations += 1
    entry.inputTokens += step.tokens.sources + step.tokens.protocol
    sourceSum += step.tokens.sources
    protocolSum += step.tokens.protocol
  }
  const releasedOut: IPlanReleased[] = released.map((skill) => ({
    key: skill.key,
    id: idOf.get(skill.key)!.id,
    tokens: sourceTokens(skill),
    ...(idOf.get(skill.key)!.catalog ? { catalog: idOf.get(skill.key)!.catalog } : {}),
  }))
  const estimate: IPlanEstimate = {
    conversations: steps.length,
    inputTokens: sourceSum + protocolSum,
    sourceTokens: sourceSum,
    protocolTokens: protocolSum,
    byKind,
    released: {
      conversations: releasedOut.length,
      inputTokens: releasedOut.reduce((sum, skill) => sum + skill.tokens + input.protocolTokens('skill'), 0),
    },
    note: '≈ entrada da primeira volta de cada conversa (fontes + protocolo do construtor, sem os complementos do projeto); as respostas e os ajustes somam por cima. Nada é disparado daqui',
  }

  const phases: IPlanPhaseInfo[] = ([1, 2, 3, 4, 5, 6, 7] as const).map((phase) => ({
    phase,
    label: PLAN_PHASE_LABEL[phase],
    steps: steps.filter((step) => step.phase === phase).length,
  }))
  const blocked = steps.filter((step) => step.state === 'conflict' || step.state === 'duplicate').map((step) => `${step.key}: ${idOf.get(step.key)!.reason}`)
  if (prefix) notes.push({ level: 'info', code: 'prefix', text: `prefixo ${prefix} nos ids de agente, skill, command e docs` })

  return {
    agent: agent.key,
    prefix,
    phases,
    steps,
    links,
    ...(reach ? { reach } : {}),
    ...(project ? { project } : {}),
    idMap,
    excluded: excluded.sort((a, b) => a.from.localeCompare(b.from) || a.reason.localeCompare(b.reason) || (a.path ?? a.code ?? '').localeCompare(b.path ?? b.code ?? '')),
    released: releasedOut,
    mcps,
    cycles,
    estimate,
    blocked,
    notes,
  }
}
