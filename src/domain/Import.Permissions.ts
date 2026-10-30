import { IPermissionRule, IPermissionSubject, TPermissionCategory, decide } from './Permission.Policy'

/**
 * A TRADUÇÃO DO ALCANCE de um agente do opencode (`permission` e `tools`) para o gateway: regras + `allowedTools`, uma
 * linha por entrada da origem, com o status e o motivo. Puro e DETERMINÍSTICO: nenhum modelo decide regra de segurança
 * (ver `docs/integration/plano-importador.md`, PR 4).
 *
 * ⚖️ A REGRA DO JOGO MUDA:
 * - no opencode a ÚLTIMA regra que casa vence; no gateway, sem regra = negado e, na camada, NEGAR VENCE. Por isso o
 *   `* deny` de base seguido de liberações sai (manter anularia as liberações), a negação que uma liberação posterior
 *   desfazia fica (falha fechada) e é marcada, e a liberação que uma negação posterior matava não entra;
 * - terminal é por PALAVRAS (`git rebase*` não casa `git rebase -i`): o padrão é reescrito;
 * - caminho sem `/` casa o nome em QUALQUER pasta; `edit` e `write` viram uma categoria só (`write`).
 *
 * ⛔ AMPLIAÇÃO: regra que abre muito (terminal com qualquer comando, `read **`, `write **`, servidor MCP inteiro, `*`)
 * sai marcada em `widening` e em `widenings`. O módulo nunca a aceita: quem grava passa a lista do que a pessoa
 * confirmou (`confirmedRules`).
 */

export type TReachStatus = 'direct' | 'changed' | 'none'

export const REACH_STATUS_MARK: Readonly<Record<TReachStatus, string>> = { direct: '✅', changed: '⚠️', none: '❌' }

/** De onde vem a linha: do agente, uma negação do projeto reposta no agente, ou acrescentada por uma opção. */
export type TReachOrigin = 'agent' | 'project' | 'option'

export interface IReachLine {
  origin: TReachOrigin
  /** A chave do opencode (`bash`, `edit`, `mcp`, `task`…). */
  key: string
  /** O padrão como está na origem. */
  pattern: string
  /** `allow`, `deny`, `ask` (ou o valor cru, se inválido). */
  action: string
  /** O que entra no gateway (pode ser nada: omitida, coberta por outra, sem equivalente). */
  rules: IPermissionRule[]
  status: TReachStatus
  reason: string
  /** Ampliação: o porquê. Só vale depois de confirmada por uma pessoa. */
  widening?: string
}

export interface IReachToolLine {
  /** A chave do bloco `tools` do opencode. */
  key: string
  enabled: boolean
  /** O que ela pôs em `allowedTools`. */
  tools: string[]
  status: TReachStatus
  reason: string
}

export interface IReachWidening {
  rule: IPermissionRule
  reason: string
}

export interface IReachTranslation {
  /** Uma por entrada do `permission` do agente, na ordem da origem. */
  lines: IReachLine[]
  /** As acrescentadas pelas opções e as negações do projeto repostas. */
  added: IReachLine[]
  /** Todas as regras propostas, sem repetição (as ampliações incluídas — ver `confirmedRules`). */
  rules: IPermissionRule[]
  widenings: IReachWidening[]
  /** Uma por entrada do `tools` do agente. */
  tools: IReachToolLine[]
  allowedTools: string[]
  /** Contagem das `lines` (só as entradas do agente). */
  totals: Record<TReachStatus, number>
}

export interface IReachMcpServer {
  /** O id do servidor no gateway (escolhido na tela). */
  id: string
  /** As ferramentas do servidor de destino, quando conhecidas. Sem a lista, glob em `tools` não expande. */
  tools?: readonly string[]
}

export interface IReachOptions {
  /** Por servidor MCP da origem (o nome no bloco `mcp` do opencode): o destino no gateway. Servidor sem entrada = ❌. */
  mcpServers?: Readonly<Record<string, IReachMcpServer>>
  /** Os agentes que existem no gateway (ou entram no mesmo lote): nome na origem → id no gateway. */
  agents?: Readonly<Record<string, string>>
  /** O nome do próprio agente na origem (nunca delega a si). */
  self?: string
  /** O `permission` global do opencode (a camada do projeto): para repor as negações dele que o agente engole. */
  project?: Readonly<Record<string, unknown>>
  /**
   * `write` amplo (criar em qualquer lugar) quando o `edit` não é: o gateway não separa criar de editar, e traduzir
   * liberaria editar tudo. `omit` (padrão): ❌, fora. `propose`: entra como ampliação.
   */
  createAnywhere?: 'omit' | 'propose'
  /** Sem regra de leitura (o padrão do opencode é ler): propõe `read **` como ampliação. Padrão: sim. */
  readAll?: boolean
  /**
   * Repor no agente as negações do projeto que uma liberação MAIS AMPLA do agente engoliria (no gateway, se uma regra do
   * agente casa, o projeto nem é consultado). Liberação igual à negação é escolha do agente e não repõe. Padrão: sim.
   */
  restoreProjectDenies?: boolean
  /** Ferramenta de MCP liberada que não está na lista do servidor: `drop` (❌, padrão) ou `keep`. */
  outsideServerTools?: 'drop' | 'keep'
}

export const REACH_DEFAULTS: Required<Pick<IReachOptions, 'createAnywhere' | 'readAll' | 'restoreProjectDenies' | 'outsideServerTools'>> = {
  createAnywhere: 'omit',
  readAll: true,
  restoreProjectDenies: true,
  outsideServerTools: 'drop',
}

/** A chave de uma regra, para confirmar ampliações. */
export const ruleKey = (rule: Pick<IPermissionRule, 'category' | 'pattern' | 'decision'>) => `${rule.category} ${rule.decision} ${rule.pattern}`

/** As regras para gravar: todas, menos as ampliações que a pessoa NÃO confirmou (`confirmed`: as `ruleKey`). */
export function confirmedRules(translation: Pick<IReachTranslation, 'rules' | 'widenings'>, confirmed: readonly string[]): IPermissionRule[] {
  const pending = new Set(translation.widenings.map((item) => ruleKey(item.rule)).filter((key) => !confirmed.includes(key)))
  return translation.rules.filter((rule) => !pending.has(ruleKey(rule)))
}

// ---------------------------------------------------------------------------------------------------------------------

type TAction = 'allow' | 'deny'

interface IEntry {
  index: number
  key: string
  pattern: string
  raw: string
  /** `ask` vira `deny`: o gateway não pergunta. */
  action?: TAction
  category?: TPermissionCategory
}

const KEY_CATEGORY: Readonly<Record<string, TPermissionCategory>> = {
  bash: 'terminal',
  edit: 'write',
  write: 'write',
  read: 'read',
  skill: 'skill',
  mcp: 'mcp',
  task: 'delegate',
}

/** Chaves do opencode sem categoria no gateway, com o motivo. */
const NO_EQUIVALENT: Readonly<Record<string, string>> = {
  webfetch: 'rede no gateway é por destino (categoria network) e a capacidade "Abrir página": libere na tela',
  websearch: 'busca na web é a capacidade "Busca na web": escolha na tela',
  doom_loop: 'o gateway tem a própria trava de repetição',
  list: 'no gateway listar segue a leitura (read)',
  glob: 'no gateway buscar segue a leitura (read)',
  grep: 'no gateway buscar segue a leitura (read)',
  todowrite: 'a lista de tarefas é a capacidade "Lista de tarefas"',
  todoread: 'a lista de tarefas é a capacidade "Lista de tarefas"',
}

/** Glob do opencode: sobre a string inteira, `*` casa qualquer coisa (inclusive espaço e `/`). */
function ocMatch(pattern: string, text: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 's').test(text)
}

/** As duas casam algum valor em comum? (Aproximação: uma casa a outra lida ao pé da letra.) */
const overlaps = (a: string, b: string) => ocMatch(a, b) || ocMatch(b, a)
const isUniversal = (pattern: string) => /^\*+$/.test(pattern.trim()) || ['**/*', '**/**'].includes(pattern.trim())

function entriesOf(permission: Readonly<Record<string, unknown>>): IEntry[] {
  const entries: IEntry[] = []
  for (const [key, value] of Object.entries(permission)) {
    const pairs: Array<[string, unknown]> =
      typeof value === 'string' ? [['*', value]] : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [['*', value]]
    for (const [pattern, raw] of pairs) {
      const action = raw === 'allow' ? 'allow' : raw === 'deny' || raw === 'ask' ? 'deny' : undefined
      entries.push({ index: entries.length, key, pattern, raw: typeof raw === 'string' ? raw : String(JSON.stringify(raw)), action, category: KEY_CATEGORY[key] })
    }
  }
  return entries
}

interface IDraft {
  pattern?: string
  status: TReachStatus
  reason: string
}

// ── Terminal ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const REDIRECT = /^(?:\d*>>?|&>>?|<<?|\d*>&\d*)$/
const COMPOUND = /^(?:\||\|\||&&|;|&)$/

/**
 * Do glob sobre a string (opencode) para o padrão por palavras (gateway):
 * - `*` inicial colado (`*git stash pop*`): servia para linha composta e wrapper, que o gateway separa e desembrulha — sai;
 *   sozinho numa palavra (`*.credentials*`), vira "em qualquer argumento" (`* *.credentials* *`);
 * - `*` colado antes de opção (`git push*--force*`) separa a palavra (`git push * --force*`);
 * - `*` colado no fim (`git rebase*`) também cobre os argumentos seguintes (`git rebase* *`);
 * - redirecionamento (`* > *`) não tem regra: o argv não traz o `>`, e o gateway o checa como escrita/leitura no alvo.
 */
function terminalDraft(raw: string): IDraft {
  let words = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^\*+$/.test(word) ? '*' : word))
  if (!words.length) return { status: 'none', reason: 'padrão vazio' }
  if (words.some((word) => REDIRECT.test(word)))
    return {
      status: 'changed',
      reason: 'redirecionamento: o comando chega sem o `>`, a regra nunca casaria. O gateway checa o alvo do `>` como escrita (e o do `<` como leitura)',
    }
  if (words.some((word) => COMPOUND.test(word))) return { status: 'none', reason: 'linha composta: o gateway checa cada comando da linha à parte; escreva uma regra por comando' }
  if (words.some((word) => word.includes('?'))) return { status: 'none', reason: 'o `?` não é curinga no terminal do gateway' }
  if (words.every((word) => word === '*')) return { pattern: '*', status: 'direct', reason: 'qualquer comando' }

  const notes: string[] = []
  let status: TReachStatus = 'direct'
  if (words[0] !== '*' && words[0].startsWith('*')) {
    const rest = words[0].replace(/^\*+/, '')
    if (words.length === 1) {
      return {
        pattern: `* *${rest}${rest.endsWith('*') ? ' *' : ''}`,
        status: 'changed',
        reason: `no opencode casava \`${rest.replace(/\*+$/, '')}\` em qualquer ponto da linha; aqui, dentro de uma palavra (o comando ou um argumento)`,
      }
    }
    words[0] = rest
    notes.push('o `*` inicial (linha composta, wrapper) sai: o gateway separa a linha e desembrulha')
  }

  // `push*--force*` → `push`, `*`, `--force*`.
  const split: string[] = []
  for (const word of words) {
    const parts = word.split(/\*(?=-)/)
    parts.forEach((part, at) => {
      if (at > 0) {
        split.push('*')
        if (part.startsWith('--')) notes.push(`\`${part.replace(/\*+$/, '')}\` vira palavra própria`)
        else {
          status = 'changed'
          notes.push(`no opencode \`${part.replace(/\*+$/, '')}\` casava em qualquer ponto da linha (até dentro de outra palavra); aqui só a palavra que começa com ele`)
        }
      }
      if (part) split.push(part)
    })
  }
  words = split
  const last = words[words.length - 1]
  if (last !== '*' && last.endsWith('*')) {
    words.push('*')
    notes.push('o `*` colado no fim também cobre os argumentos seguintes')
  }
  const pattern = words.join(' ')
  return { pattern, status, reason: notes.join('; ') }
}

// ── Caminho ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function pathDraft(raw: string, siblings: readonly string[]): IDraft {
  const pattern = raw.trim().replace(/^\.\//, '')
  if (!pattern) return { status: 'none', reason: 'padrão vazio' }
  if (isUniversal(pattern)) return { pattern: '**', status: 'direct', reason: '' }
  if (!pattern.includes('/')) {
    if (siblings.includes(`**/${pattern}`)) return { pattern, status: 'direct', reason: `sem \`/\` casa em qualquer pasta, como o par \`**/${pattern}\`` }
    return { pattern, status: 'changed', reason: 'no opencode só a raiz; no gateway, sem `/`, casa o nome em qualquer pasta (arquivo só da raiz não é exprimível)' }
  }
  return { pattern, status: 'direct', reason: '' }
}

const isOutside = (pattern: string) => pattern.startsWith('/') || pattern.startsWith('~')

/** `cover` cobre `rule` (mesma categoria e decisão)? Só para regra de caminho e repetição exata. */
function covers(cover: IPermissionRule, rule: IPermissionRule): boolean {
  if (cover.category !== rule.category || cover.decision !== rule.decision) return false
  if (cover.pattern === rule.pattern) return true
  if (rule.category !== 'read' && rule.category !== 'write') return false
  const [c, r] = [cover.pattern, rule.pattern]
  if (c === '**') return !isOutside(r)
  if (!c.includes('/') && !c.includes('*')) return r.split('/').pop() === c
  if (c === `**/${r}`) return true
  if (c.endsWith('/**') && !c.slice(0, -3).includes('*')) return r.startsWith(`${c.slice(0, -3)}/`)
  return false
}

// ── MCP ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function mcpDraft(raw: string, action: TAction, options: IReachOptions): IDraft {
  const pattern = raw.trim()
  if (isUniversal(pattern)) return { pattern: '*', status: 'direct', reason: '' }
  const servers = Object.keys(options.mcpServers ?? {}).sort((a, b) => b.length - a.length)
  for (const name of servers) {
    const server = options.mcpServers![name]
    if (pattern === name)
      return { status: 'none', reason: 'o nome do servidor sozinho não casa ferramenta nenhuma (o nome é <servidor>_<ferramenta>): config morta já no opencode' }
    if (pattern.startsWith(`${name}*`)) return { pattern: `${server.id}/*`, status: 'direct', reason: 'o servidor inteiro' }
    if (!pattern.startsWith(`${name}_`)) continue
    const tool = pattern.slice(name.length + 1)
    if (action === 'allow' && server.tools && !tool.includes('*') && !server.tools.includes(tool) && (options.outsideServerTools ?? REACH_DEFAULTS.outsideServerTools) === 'drop')
      return { status: 'none', reason: `\`${tool}\` não está na lista de ferramentas do servidor \`${server.id}\`` }
    return { pattern: `${server.id}/${tool}`, status: 'direct', reason: '' }
  }
  return { status: 'none', reason: 'servidor MCP sem id de destino: escolha o servidor do gateway na tela' }
}

// ── Ampliação ────────────────────────────────────────────────────────────────────────────────────────────────────────

function wideningOf(rule: IPermissionRule): string | undefined {
  if (rule.decision !== 'allow') return undefined
  const pattern = rule.pattern
  switch (rule.category) {
    case 'terminal':
      return pattern.split(/\s+/)[0].includes('*') ? 'terminal amplo: qualquer comando' : undefined
    case 'read':
    case 'write': {
      const label = rule.category === 'read' ? 'leitura' : 'escrita'
      if (isUniversal(pattern)) return `${label} ampla: qualquer arquivo da pasta`
      return isOutside(pattern) ? `${label} fora da pasta de trabalho` : undefined
    }
    case 'mcp':
      return pattern === '*' || pattern.endsWith('/*') ? 'MCP amplo: todas as ferramentas' : undefined
    case 'skill':
      return isUniversal(pattern) ? 'qualquer skill' : undefined
    case 'delegate':
      return isUniversal(pattern) ? 'delega a qualquer agente' : undefined
    case 'network':
      return pattern.trim() === '*' ? 'qualquer destino de rede' : undefined
    default:
      return undefined
  }
}

// ── A tradução de uma lista ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A tradução das entradas de um `permission` do opencode (de agente ou o global), sem opções de alcance. As linhas
 * ficam na ordem da origem; `origin` diz de quem é.
 */
export function translatePermission(permission: Readonly<Record<string, unknown>>, options: IReachOptions = {}, origin: TReachOrigin = 'agent'): IReachLine[] {
  const entries = entriesOf(permission)
  const lines = entries.map((entry) => translateEntry(entry, entries, options, origin))
  return dedupe(lines)
}

function translateEntry(entry: IEntry, entries: readonly IEntry[], options: IReachOptions, origin: TReachOrigin): IReachLine {
  const line = (draft: Partial<IReachLine> & Pick<IReachLine, 'status' | 'reason'>): IReachLine => ({
    origin,
    key: entry.key,
    pattern: entry.pattern,
    action: entry.raw,
    rules: [],
    ...draft,
  })
  if (entry.key === 'external_directory') {
    return entry.action === 'deny'
      ? line({ status: 'direct', reason: 'omitida: no gateway a liberação relativa não alcança fora da pasta; sem regra absoluta, fora já é negado' })
      : line({ status: 'none', reason: 'liberar pasta externa exige regra absoluta de read/write: cadastre na tela' })
  }
  if (!entry.category) return line({ status: 'none', reason: `sem equivalente no gateway${NO_EQUIVALENT[entry.key] ? `: ${NO_EQUIVALENT[entry.key]}` : ''}` })
  if (!entry.action) return line({ status: 'none', reason: `valor inválido (${entry.raw}): use allow, deny ou ask` })
  const category = entry.category
  const action = entry.action
  const asks = entry.raw === 'ask' ? ['o gateway não pergunta: `ask` vira negar'] : []

  // ⚖️ Última vence → negar vence. As liberações que contam contra esta negação: as que vêm DEPOIS na mesma chave, e
  // as de outra chave da mesma categoria (`edit` × `write`), em que a ordem não existe.
  const sameCategory = entries.filter((other) => other.category === category && other.action)
  if (action === 'deny') {
    const later = sameCategory.filter((other) => other.action === 'allow' && (other.key !== entry.key || other.index > entry.index) && overlaps(entry.pattern, other.pattern))
    if (later.length && isUniversal(entry.pattern)) {
      return line({
        status: 'changed',
        reason: [...asks, `omitida: sem regra já é negado; manter anularia as liberações (negar vence)${projectLeak(category, options)}`].join('; '),
      })
    }
    const draft = draftFor(entry, entries, options)
    if (!draft.pattern) return line({ status: draft.status, reason: [...asks, draft.reason].filter(Boolean).join('; ') })
    const reasons = [...asks, draft.reason]
    let status: TReachStatus = asks.length ? 'changed' : draft.status
    if (later.length) {
      status = 'changed'
      reasons.push(`no opencode a liberação ${later.map((other) => `\`${other.pattern}\``).join(', ')} vinha depois e vencia onde as duas casam; aqui negar vence (fica negado)`)
    }
    return line({ rules: [{ category, pattern: draft.pattern, decision: 'deny' }], status, reason: reasons.filter(Boolean).join('; ') })
  }

  // Liberação morta: uma negação DEPOIS cobre tudo o que ela libera, e nenhuma liberação depois dela a refaz.
  const killer = sameCategory.find(
    (other) =>
      other.key === entry.key &&
      other.index > entry.index &&
      other.action === 'deny' &&
      ocMatch(other.pattern, entry.pattern) &&
      !sameCategory.some((again) => again.key === entry.key && again.index > other.index && again.action === 'allow' && ocMatch(again.pattern, entry.pattern)),
  )
  if (killer) return line({ status: 'none', reason: `morta já no opencode: a negação \`${killer.pattern}\` vem depois e cobre tudo o que ela libera` })

  if (category === 'write' && entry.key === 'write' && isUniversal(entry.pattern)) {
    const editWide = entries.some((other) => other.key === 'edit' && other.action === 'allow' && isUniversal(other.pattern))
    if (!editWide && (options.createAnywhere ?? REACH_DEFAULTS.createAnywhere) === 'omit')
      return line({
        status: 'none',
        reason: 'omitida: o gateway não separa criar de editar; traduzir liberaria editar qualquer arquivo e anularia a lista do `edit`. Cria-se onde se edita',
      })
  }
  const draft = draftFor(entry, entries, options)
  if (!draft.pattern) return line({ status: draft.status, reason: draft.reason })
  const rule: IPermissionRule = { category, pattern: draft.pattern, decision: 'allow' }
  let status = draft.status
  const reasons = [draft.reason]
  if (category === 'delegate' && !isUniversal(entry.pattern) && !entry.pattern.includes('*')) {
    const target = options.agents?.[entry.pattern]
    if (!target) {
      status = 'none'
      reasons.push('alvo não importado: a regra fica inerte e `agent:<id>` fica de fora até o agente existir')
      rule.note = 'alvo ainda não importado'
    }
  }
  const widening = wideningOf(rule)
  return line({ rules: [rule], status, reason: reasons.filter(Boolean).join('; '), ...(widening ? { widening } : {}) })
}

function draftFor(entry: IEntry, entries: readonly IEntry[], options: IReachOptions): IDraft {
  switch (entry.category) {
    case 'terminal':
      return terminalDraft(entry.pattern)
    case 'read':
    case 'write': {
      const siblings = entries.filter((other) => other.category === entry.category && other.raw === entry.raw).map((other) => other.pattern.trim())
      return pathDraft(entry.pattern, siblings)
    }
    case 'mcp':
      return mcpDraft(entry.pattern, entry.action!, options)
    case 'delegate': {
      const pattern = entry.pattern.trim()
      return { pattern: options.agents?.[pattern] ?? pattern, status: 'direct', reason: '' }
    }
    default:
      return { pattern: entry.pattern.trim(), status: 'direct', reason: '' }
  }
}

/** O projeto libera algo nesta categoria? Sem a negação de base do agente, o que ele não cobre cai no projeto. */
function projectLeak(category: TPermissionCategory, options: IReachOptions): string {
  if (!options.project) return ''
  const open = translatePermission(options.project, { ...options, project: undefined }, 'project')
    .flatMap((line) => line.rules)
    .filter((rule) => rule.category === category && rule.decision === 'allow')
  return open.length ? `. ⚠️ o projeto libera ${open.map((rule) => `\`${rule.pattern}\``).join(', ')}: o que o agente não cobrir cai nele` : ''
}

/** Regra repetida ou coberta por outra (de outra linha) sai da linha; a cobertura nunca vem de uma ampliação. */
function dedupe(lines: IReachLine[]): IReachLine[] {
  const all = lines.flatMap((line, at) => line.rules.map((rule) => ({ rule, at, wide: Boolean(line.widening) })))
  return lines.map((line, at) => {
    const kept: IPermissionRule[] = []
    const by: string[] = []
    for (const rule of line.rules) {
      const cover = all.find((other) => other.rule !== rule && !other.wide && covers(other.rule, rule) && !(covers(rule, other.rule) && other.at > at))
      if (cover) by.push(`\`${cover.rule.pattern}\``)
      else kept.push(rule)
    }
    if (!by.length) return line
    return { ...line, rules: kept, reason: [line.reason, `coberta por ${by.join(', ')}`].filter(Boolean).join('; ') }
  })
}

// ── O alcance do agente ──────────────────────────────────────────────────────────────────────────────────────────────

export interface IOpencodeReach {
  permission?: Readonly<Record<string, unknown>>
  tools?: Readonly<Record<string, unknown>>
}

/** O alcance de um agente do opencode no gateway: regras, `allowedTools` e a tabela. */
export function translateReach(reach: IOpencodeReach, options: IReachOptions = {}): IReachTranslation {
  const lines = translatePermission(reach.permission ?? {}, options, 'agent')
  const added: IReachLine[] = []
  const agentEntries = entriesOf(reach.permission ?? {})
  const projectEntries = entriesOf(options.project ?? {})

  if ((options.readAll ?? REACH_DEFAULTS.readAll) && ![...agentEntries, ...projectEntries].some((entry) => entry.key === 'read' && isUniversal(entry.pattern))) {
    const rule: IPermissionRule = { category: 'read', pattern: '**', decision: 'allow' }
    added.push({
      origin: 'option',
      key: 'read',
      pattern: '**',
      action: 'allow',
      rules: [rule],
      status: 'direct',
      reason: 'no opencode o padrão é ler; no gateway sem regra não lê nada',
      widening: wideningOf(rule),
    })
  }

  if ((options.restoreProjectDenies ?? REACH_DEFAULTS.restoreProjectDenies) && options.project) {
    const agentRules = [...lines, ...added].flatMap((line) => line.rules)
    for (const line of translatePermission(options.project, { ...options, project: undefined }, 'project')) {
      const denies = line.rules.filter((rule) => rule.decision === 'deny')
      if (!denies.length) continue
      const restored = denies.filter((deny) => {
        if (agentRules.some((rule) => rule.category === deny.category && rule.decision === 'deny' && ocMatch(rule.pattern, deny.pattern))) return false
        return agentRules.some((rule) => rule.category === deny.category && rule.decision === 'allow' && rule.pattern !== deny.pattern && ocMatch(rule.pattern, deny.pattern))
      })
      if (!restored.length) continue
      const category = restored[0].category
      const swallow = agentRules.find(
        (rule) => rule.category === category && rule.decision === 'allow' && rule.pattern !== restored[0].pattern && ocMatch(rule.pattern, restored[0].pattern),
      )
      // O status é o do padrão: o conflito interno do projeto (a liberação que vinha depois LÁ) não vale para o agente.
      const draft = draftFor({ index: -1, key: line.key, pattern: line.pattern, raw: 'deny', action: 'deny', category }, [], options)
      added.push({
        ...line,
        rules: restored.map((rule) => ({ ...rule, note: 'reposta do projeto' })),
        status: draft.status,
        reason: [
          `do projeto: a liberação \`${swallow?.pattern}\` do agente a engoliria (no gateway a camada do agente decide antes; no opencode ela vinha depois e a negação já não valia); reposta no agente`,
          draft.reason,
        ]
          .filter(Boolean)
          .join('; '),
      })
    }
  }

  const all = dedupe([...lines, ...added])
  const finalLines = all.slice(0, lines.length)
  const finalAdded = all.slice(lines.length)
  const seen = new Set<string>()
  const rules: IPermissionRule[] = []
  const widenings: IReachWidening[] = []
  for (const line of all)
    for (const rule of line.rules) {
      if (seen.has(ruleKey(rule))) continue
      seen.add(ruleKey(rule))
      rules.push(rule)
      if (line.widening) widenings.push({ rule, reason: line.widening })
    }

  const { tools, allowedTools } = translateTools(reach.tools ?? {}, rules, options)
  const totals: Record<TReachStatus, number> = { direct: 0, changed: 0, none: 0 }
  for (const line of finalLines) totals[line.status] += 1
  return { lines: finalLines, added: finalAdded, rules, widenings, tools, allowedTools, totals }
}

// ── tools → allowedTools ─────────────────────────────────────────────────────────────────────────────────────────────

/** As ferramentas do opencode que dão cada capacidade (basta uma ligada). */
const CAPABILITY_TOOLS: ReadonlyArray<{ cap: string; tools: readonly string[]; category: TPermissionCategory }> = [
  { cap: 'cap:terminal', tools: ['bash'], category: 'terminal' },
  { cap: 'cap:files.read', tools: ['read'], category: 'read' },
  { cap: 'cap:files.write', tools: ['edit', 'write'], category: 'write' },
]
const BUILT_IN = new Set(['bash', 'read', 'edit', 'write', 'patch', 'list', 'glob', 'grep', 'task', 'skill', 'webfetch', 'websearch', 'todowrite', 'todoread', 'lsp', 'codesearch'])

function translateTools(raw: Readonly<Record<string, unknown>>, rules: readonly IPermissionRule[], options: IReachOptions): { tools: IReachToolLine[]; allowedTools: string[] } {
  const entries = Object.entries(raw).map(([key, value]) => ({ key, value }))
  // ⚖️ No opencode a última chave que casa vence; sem chave, a ferramenta está ligada.
  const enabled = (name: string) => {
    let on = true
    for (const entry of entries) if (typeof entry.value === 'boolean' && ocMatch(entry.key, name)) on = entry.value
    return on
  }
  const allowed = (subject: IPermissionSubject) => decide(subject, { agent: rules }).allowed
  const has = (category: TPermissionCategory) => rules.some((rule) => rule.category === category && rule.decision === 'allow')

  const allowedTools: string[] = []
  for (const item of CAPABILITY_TOOLS) if (item.tools.some(enabled) && has(item.category)) allowedTools.push(item.cap)

  const servers = Object.entries(options.mcpServers ?? {})
  for (const [name, server] of servers) {
    const prefix = `${name}_`
    const candidates = server.tools
      ? [...server.tools]
      : [
          ...new Set([
            ...entries.filter((entry) => entry.value === true && entry.key.startsWith(prefix) && !entry.key.includes('*')).map((entry) => entry.key.slice(prefix.length)),
            ...rules
              .filter((rule) => rule.category === 'mcp' && rule.decision === 'allow' && rule.pattern.startsWith(`${server.id}/`) && !rule.pattern.includes('*'))
              .map((rule) => rule.pattern.slice(server.id.length + 1)),
          ]),
        ]
    for (const tool of candidates) if (enabled(`${prefix}${tool}`) && allowed({ category: 'mcp', value: `${server.id}/${tool}` })) allowedTools.push(`mcp:${server.id}/${tool}`)
  }

  if (enabled('task'))
    for (const [source, id] of Object.entries(options.agents ?? {})) if (source !== options.self && allowed({ category: 'delegate', value: id })) allowedTools.push(`agent:${id}`)

  const tools = entries.map(({ key, value }): IReachToolLine => {
    if (typeof value !== 'boolean') return { key, enabled: false, tools: [], status: 'none', reason: `valor inválido (${JSON.stringify(value)}): use true ou false` }
    const mine = allowedTools.filter((tool) => toolKeyCovers(key, tool, options))
    const server = servers.find(([name]) => key === name || key.startsWith(`${name}_`) || key.startsWith(`${name}*`))
    if (!value) return { key, enabled: false, tools: [], status: 'direct', reason: 'desligada: o que ela cobre só entra se uma chave depois religar' }
    if (BUILT_IN.has(key)) {
      const cap = CAPABILITY_TOOLS.find((item) => item.tools.includes(key))
      if (cap) return { key, enabled: true, tools: mine, status: 'direct', reason: '' }
      if (key === 'task') return { key, enabled: true, tools: mine, status: 'direct', reason: 'delegação: `agent:<id>` para cada alvo que existe' }
      if (key === 'skill') return { key, enabled: true, tools: [], status: 'direct', reason: 'as skills seguem as regras `skill`' }
      return { key, enabled: true, tools: [], status: 'none', reason: 'sem capacidade equivalente: escolha na tela' }
    }
    if (!server) return { key, enabled: true, tools: [], status: 'none', reason: 'sem equivalente: servidor MCP sem id de destino ou ferramenta desconhecida' }
    if (key.includes('*') && !server[1].tools) return { key, enabled: true, tools: [], status: 'none', reason: 'glob: precisa da lista de ferramentas do servidor para expandir' }
    if (!mine.length) return { key, enabled: true, tools: [], status: 'none', reason: 'nenhuma ferramenta entra: fora da lista do servidor ou negada pelas permissões' }
    return { key, enabled: true, tools: mine, status: 'direct', reason: key.includes('*') ? `expandida pela lista do servidor (${mine.length})` : '' }
  })
  return { tools, allowedTools }
}

function toolKeyCovers(key: string, tool: string, options: IReachOptions): boolean {
  if (tool.startsWith('cap:')) return CAPABILITY_TOOLS.some((item) => item.cap === tool && item.tools.some((name) => ocMatch(key, name)))
  if (tool.startsWith('agent:')) return ocMatch(key, 'task')
  const [id, name] = tool.slice('mcp:'.length).split('/')
  return Object.entries(options.mcpServers ?? {}).some(([source, server]) => server.id === id && ocMatch(key, `${source}_${name}`))
}
