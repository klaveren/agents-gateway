import { TProtocolKind } from './models/Protocol.Model'
import { TInventoryKind } from './models/ImportInventory.Model'
import { diffText, ITextDiff } from './Text.Diff'

/**
 * O RASCUNHO DE IMPORTAÇÃO por OPERAÇÕES (`docs/integration/plano-importador.md`, PR 7 e as decisões de 30/10).
 *
 * ⛔ A REGRA DO DONO: o construtor NÃO muda os textos, só os ajusta ao padrão do ambiente. Por isso o rascunho não traz
 * corpo escrito pelo modelo: traz a(s) fonte(s) e uma lista de operações de TIPOS FIXOS. Nenhuma delas escreve texto
 * livre no corpo — o que entra no corpo é só o id de um vínculo (`linkCitation`) e o `#` de um título (`heading`).
 *
 * - `setMeta`: um metadado (id, título, resumo, descrição, escopo… — os do protocolo do tipo). Metadado não é corpo.
 * - `linkCitation`: um caminho citado (`.agents/specs/x.md`, `@arquivo`, link markdown) vira o id do alvo, e o vínculo
 *   vai para o painel (anexo inteiro, por referência ou contexto inicial do agente).
 * - `heading`: muda o nível de um título (a linha inteira).
 * - `split`: corta a seção de um título (até o próximo do mesmo nível ou acima) e a faz virar OUTRO item, com os
 *   metadados dela.
 * - `remove`: tira um trecho exato (carimbo de histórico, cabeçalho de gerado, metadado do sistema antigo) ou a fonte
 *   inteira (`whole`), sempre com o motivo. Cada remoção pede OK na revisão.
 * - `compose`: junta as fontes declaradas num campo (agente: `soul`/`systemPrompt`; os outros: `body`), na ordem, sem
 *   reescrever.
 *
 * Os trechos são achados pelo CONTEÚDO EXATO e pela ocorrência (1, 2…), nunca por número de linha: trecho que não existe
 * falha, e trecho que aparece mais de uma vez sem a ocorrência também.
 *
 * ⚖️ O servidor aplica as operações e produz o texto final; a CONFERÊNCIA (`verifyImportDraft`) refaz tudo a partir da
 * fonte e recusa qualquer diferença. Normalização única e determinística: as linhas em branco do começo e do fim de cada
 * campo saem, e as partes de um `compose` são separadas por uma linha em branco.
 */

/** O tipo do rascunho: o do protocolo do construtor, ou o trigger (o construtor de agentes o escreve à parte). */
export type TImportDraftKind = TProtocolKind | 'trigger'

/** O construtor que importa cada tipo do inventário (o trigger vai ao de agentes). Sem construtor: não se importa por conversa. */
export function builderKindForItem(kind: TInventoryKind): TProtocolKind | undefined {
  if (kind === 'trigger') return 'agent'
  const protocols: readonly string[] = ['skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'agent']
  return protocols.includes(kind) ? (kind as TProtocolKind) : undefined
}

/** O tipo do rascunho de um item do inventário, ou nada (mcp, config, desconhecido…). */
export function draftKindForItem(kind: TInventoryKind): TImportDraftKind | undefined {
  if (kind === 'trigger') return 'trigger'
  return builderKindForItem(kind)
}

export type TImportLink = 'attach' | 'reference' | 'initialContext'
export type TComposeField = 'body' | 'soul' | 'systemPrompt'

export interface IImportOpSetMeta {
  op: 'setMeta'
  field: string
  value: string
}
export interface IImportOpLinkCitation {
  op: 'linkCitation'
  source?: string
  text: string
  occurrence?: number
  target: string
  link: TImportLink
}
export interface IImportOpHeading {
  op: 'heading'
  source?: string
  text: string
  occurrence?: number
  level: number
}
export interface IImportOpSplit {
  op: 'split'
  source?: string
  text: string
  occurrence?: number
  meta: Record<string, string>
}
export interface IImportOpRemove {
  op: 'remove'
  source?: string
  /** O trecho exato. Ausente com `whole: true`: a fonte inteira. */
  text?: string
  occurrence?: number
  whole?: boolean
  reason: string
}
export interface IImportOpCompose {
  op: 'compose'
  into: TComposeField
  sources: string[]
}

export type TImportOp = IImportOpSetMeta | IImportOpLinkCitation | IImportOpHeading | IImportOpSplit | IImportOpRemove | IImportOpCompose

export const IMPORT_OP_TYPES: ReadonlyArray<TImportOp['op']> = ['setMeta', 'linkCitation', 'heading', 'split', 'remove', 'compose']

/** Uma fonte do item: o caminho real, os outros caminhos que levam a ela e o texto (o MASCARADO, o mesmo que o construtor leu). */
export interface IImportSourceText {
  path: string
  aliases?: readonly string[]
  text: string
}

/** Um item que o rascunho produz: o principal (`main`) e os de cada `split`. */
export interface IImportDraftOutput {
  from: 'main' | 'split'
  meta: Record<string, string>
  /** body (doc, skill, command, rule, trigger) ou soul/systemPrompt (agente). */
  fields: Partial<Record<TComposeField, string>>
}

export interface IImportDraftLink {
  op: number
  source: string
  text: string
  target: string
  link: TImportLink
}

export interface IImportDraftRemoval {
  /** O índice da operação na lista: é por ele que a revisão dá o OK. */
  op: number
  source: string
  /** O trecho removido (a fonte inteira, no `whole`). */
  text: string
  whole: boolean
  reason: string
}

/** O que a aplicação das operações produz (puro: sem hash nem autor). */
export interface IImportApplied {
  meta: Record<string, string>
  outputs: IImportDraftOutput[]
  links: IImportDraftLink[]
  removals: IImportDraftRemoval[]
  /** Fonte original × fonte depois das operações (antes do `compose`), uma por fonte. */
  diffs: Array<{ source: string; diff: ITextDiff }>
}

export interface IImportIssue {
  field: string
  message: string
}

export type TApplyResult = { ok: true; applied: IImportApplied } | { ok: false; issues: IImportIssue[] }

const SLUG: Record<TImportDraftKind, RegExp> = {
  spec: /^[a-z0-9][a-z0-9-]{1,63}$/,
  adr: /^[a-z0-9][a-z0-9-]{1,63}$/,
  knowledge: /^[a-z0-9][a-z0-9-]{1,63}$/,
  skill: /^[a-z0-9][a-z0-9-]{1,47}$/,
  command: /^[a-z0-9][a-z0-9-]{1,47}$/,
  agent: /^[a-z0-9][a-z0-9-]{1,47}$/,
  trigger: /^[a-z0-9][a-z0-9-]{1,63}$/,
  rule: /^$/,
}
/** O id de um vínculo: um doc, recurso ou agente do gateway (ou do mapa de ids da importação). */
const TARGET_ID = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Os metadados que cada tipo aceita, e os obrigatórios. `scope`: `project` (o padrão) ou `global`. */
export const IMPORT_META: Readonly<Record<TImportDraftKind, { fields: readonly string[]; required: readonly string[] }>> = {
  rule: { fields: ['title', 'scope'], required: ['title'] },
  spec: { fields: ['id', 'title', 'summary', 'scope'], required: ['id', 'title', 'summary'] },
  adr: { fields: ['id', 'title', 'summary', 'scope'], required: ['id', 'title', 'summary'] },
  knowledge: { fields: ['id', 'title', 'summary', 'scope'], required: ['id', 'title', 'summary'] },
  skill: { fields: ['id', 'description', 'scope'], required: ['id', 'description'] },
  command: { fields: ['id', 'description', 'scope'], required: ['id', 'description'] },
  agent: { fields: ['id', 'name', 'description', 'scope'], required: ['id', 'name'] },
  trigger: { fields: ['id', 'when'], required: ['id', 'when'] },
}

/** Os vínculos que cada tipo tem no painel: anexo de doc (skill, command, docs) e contexto inicial (agente). */
const LINKS: Readonly<Record<TImportDraftKind, readonly TImportLink[]>> = {
  rule: [],
  trigger: [],
  spec: ['attach', 'reference'],
  adr: ['attach', 'reference'],
  knowledge: ['attach', 'reference'],
  skill: ['attach', 'reference'],
  command: ['attach', 'reference'],
  agent: ['initialContext'],
}

const META_MAX: Record<string, number> = { id: 64, title: 200, name: 80, summary: 500, description: 500, when: 500, scope: 10 }
const REASON_MAX = 300
const CITATION_MAX = 400
const HEADING = /^(#{1,6})[ \t]+\S/

/** Os índices (sem sobreposição) de `needle` em `text`. */
function occurrencesOf(text: string, needle: string): number[] {
  const found: number[] = []
  let from = 0
  while (needle) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    found.push(at)
    from = at + needle.length
  }
  return found
}

/** A citação parece um caminho de arquivo: tem `/`, termina em `.md`, começa com `@` ou é um link markdown. */
function looksLikeCitation(text: string): boolean {
  return /[\w.-]\/[\w.-]/.test(text) || /\.mdx?\b/i.test(text) || /^@\S+$/.test(text) || /^\[[^\]]*\]\([^)]+\)$/.test(text)
}

/** Os metadados válidos para o tipo (os de um `split` também passam por aqui). */
export function importMetaIssues(kind: TImportDraftKind, meta: Readonly<Record<string, unknown>>, field = 'meta'): IImportIssue[] {
  const spec = IMPORT_META[kind]
  const issues: IImportIssue[] = []
  for (const [name, value] of Object.entries(meta)) {
    if (!spec.fields.includes(name)) {
      issues.push({ field: `${field}.${name}`, message: `not a ${kind} field (allowed: ${spec.fields.join(', ')})` })
      continue
    }
    if (typeof value !== 'string' || !value.trim()) {
      issues.push({ field: `${field}.${name}`, message: 'must be a non-empty text' })
      continue
    }
    if (value.length > (META_MAX[name] ?? 500)) issues.push({ field: `${field}.${name}`, message: `at most ${META_MAX[name] ?? 500} characters` })
    if (/[\r\n]/.test(value)) issues.push({ field: `${field}.${name}`, message: 'one line only' })
    if (name === 'id' && !SLUG[kind].test(value)) issues.push({ field: `${field}.id`, message: 'lowercase letters, digits and hyphens (a slug), within the length of the kind' })
    if (name === 'scope' && value !== 'project' && value !== 'global') issues.push({ field: `${field}.scope`, message: 'project or global' })
  }
  for (const name of spec.required) if (meta[name] === undefined) issues.push({ field: `${field}.${name}`, message: 'required' })
  return issues
}

/** Tira as linhas em branco do começo e do fim (a única normalização do texto final). */
function trimBlank(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '')
}

/** O fim da linha que começa em `at` (sem a quebra). */
function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at)
  return end < 0 ? text.length : end
}

/**
 * APLICA as operações sobre as fontes. Puro e determinístico: a mesma fonte com as mesmas operações dá sempre o mesmo
 * resultado — é o que a conferência refaz. Devolve os problemas, operação a operação, quando alguma não serve.
 */
export function applyImportOps(kind: TImportDraftKind, sources: readonly IImportSourceText[], ops: readonly TImportOp[]): TApplyResult {
  const issues: IImportIssue[] = []
  if (!sources.length) return { ok: false, issues: [{ field: 'sources', message: 'the item has no source file' }] }
  const texts = new Map<string, string>(sources.map((source) => [source.path, source.text]))
  const byAlias = new Map<string, string>()
  for (const source of sources) for (const alias of [source.path, ...(source.aliases ?? [])]) byAlias.set(alias.replace(/^\.\//, ''), source.path)
  const whole = new Set<string>()
  const meta: Record<string, string> = {}
  const parts: IImportDraftOutput[] = []
  const links: IImportDraftLink[] = []
  const removals: IImportDraftRemoval[] = []
  const composes: Array<{ index: number; op: IImportOpCompose }> = []

  const sourceOf = (op: { source?: string }, field: string): string | undefined => {
    if (op.source === undefined) {
      if (sources.length === 1) return sources[0].path
      issues.push({ field: `${field}.source`, message: `the item has ${sources.length} sources: say which (${sources.map((source) => source.path).join(', ')})` })
      return undefined
    }
    const path = byAlias.get(op.source.replace(/^\.\//, ''))
    if (!path) issues.push({ field: `${field}.source`, message: `not a source of this item: ${op.source}` })
    else if (whole.has(path)) issues.push({ field: `${field}.source`, message: `this source was removed whole by an earlier operation: ${path}` })
    return path && !whole.has(path) ? path : undefined
  }

  /** O índice do trecho na fonte: falha se não existe, se a ocorrência não existe ou se é ambíguo. */
  const locate = (text: string, needle: unknown, occurrence: number | undefined, field: string): number | undefined => {
    if (typeof needle !== 'string' || !needle) {
      issues.push({ field: `${field}.text`, message: 'required: the exact excerpt' })
      return undefined
    }
    const found = occurrencesOf(text, needle)
    if (!found.length) {
      issues.push({ field: `${field}.text`, message: 'excerpt not found in the source (it must be copied exactly, as read_import_source shows it)' })
      return undefined
    }
    if (occurrence === undefined) {
      if (found.length > 1) {
        issues.push({ field: `${field}.occurrence`, message: `the excerpt appears ${found.length} times: say which occurrence (1..${found.length})` })
        return undefined
      }
      return found[0]
    }
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > found.length) {
      issues.push({ field: `${field}.occurrence`, message: `there are ${found.length} occurrence(s) of the excerpt` })
      return undefined
    }
    return found[occurrence - 1]
  }

  /** O trecho é a linha inteira de um título markdown. */
  const headingAt = (text: string, at: number, needle: string, field: string): number | undefined => {
    const match = HEADING.exec(needle)
    const wholeLine = (at === 0 || text[at - 1] === '\n') && lineEnd(text, at) === at + needle.length
    if (!match || !wholeLine || needle.includes('\n')) {
      issues.push({ field: `${field}.text`, message: 'must be a whole markdown heading line ("## Title")' })
      return undefined
    }
    return match[1].length
  }

  ops.forEach((op, index) => {
    const field = `ops[${index}]`
    if (!op || typeof op !== 'object' || !IMPORT_OP_TYPES.includes(op.op)) {
      issues.push({ field: `${field}.op`, message: `one of ${IMPORT_OP_TYPES.join(', ')}` })
      return
    }
    switch (op.op) {
      case 'setMeta': {
        if (typeof op.field !== 'string' || typeof op.value !== 'string') {
          issues.push({ field, message: 'setMeta takes field and value (text)' })
          return
        }
        if (meta[op.field] !== undefined) issues.push({ field: `${field}.field`, message: `${op.field} was already set` })
        meta[op.field] = op.value
        return
      }
      case 'compose': {
        composes.push({ index, op })
        return
      }
      case 'linkCitation': {
        if (!LINKS[kind].length) {
          issues.push({ field, message: `a ${kind} has no panel link: ask the person what to do with the citation` })
          return
        }
        if (!LINKS[kind].includes(op.link)) issues.push({ field: `${field}.link`, message: `for a ${kind}: ${LINKS[kind].join(' or ')}` })
        if (typeof op.target !== 'string' || !TARGET_ID.test(op.target)) issues.push({ field: `${field}.target`, message: 'the gateway id of the target (a slug from the id map)' })
        if (typeof op.text !== 'string' || op.text.length > CITATION_MAX || op.text.includes('\n') || !looksLikeCitation(op.text.trim()))
          issues.push({ field: `${field}.text`, message: 'the exact cited path (a path, @file or markdown link), one line' })
        const path = sourceOf(op, field)
        if (!path || typeof op.text !== 'string') return
        const text = texts.get(path)!
        const at = locate(text, op.text, op.occurrence, field)
        if (at === undefined || typeof op.target !== 'string') return
        texts.set(path, text.slice(0, at) + op.target + text.slice(at + op.text.length))
        links.push({ op: index, source: path, text: op.text, target: op.target, link: op.link })
        return
      }
      case 'heading': {
        const path = sourceOf(op, field)
        if (!path) return
        if (!Number.isInteger(op.level) || op.level < 1 || op.level > 6) {
          issues.push({ field: `${field}.level`, message: '1 to 6' })
          return
        }
        const text = texts.get(path)!
        const at = locate(text, op.text, op.occurrence, field)
        if (at === undefined) return
        const level = headingAt(text, at, op.text, field)
        if (level === undefined) return
        if (level === op.level) {
          issues.push({ field: `${field}.level`, message: `the heading is already level ${level}` })
          return
        }
        const line = '#'.repeat(op.level) + op.text.slice(level)
        texts.set(path, text.slice(0, at) + line + text.slice(at + op.text.length))
        return
      }
      case 'split': {
        if (kind === 'agent' || kind === 'trigger') {
          issues.push({ field, message: `a ${kind} is not split: the agent and each trigger are separate items` })
          return
        }
        const path = sourceOf(op, field)
        if (!path) return
        const metaIssues = importMetaIssues(kind, op.meta && typeof op.meta === 'object' ? op.meta : {}, `${field}.meta`)
        issues.push(...metaIssues)
        const text = texts.get(path)!
        const at = locate(text, op.text, op.occurrence, field)
        if (at === undefined) return
        const level = headingAt(text, at, op.text, field)
        if (level === undefined) return
        // A seção vai até o próximo título do mesmo nível ou acima (ou o fim).
        let end = text.length
        let cursor = lineEnd(text, at)
        while (cursor < text.length) {
          const start = cursor + 1
          const match = HEADING.exec(text.slice(start, lineEnd(text, start)))
          if (match && match[1].length <= level) {
            end = start
            break
          }
          cursor = lineEnd(text, start)
        }
        const section = text.slice(at, end)
        texts.set(path, text.slice(0, at) + text.slice(end))
        if (!metaIssues.length) parts.push({ from: 'split', meta: { ...op.meta }, fields: { body: trimBlank(section) } })
        return
      }
      case 'remove': {
        if (typeof op.reason !== 'string' || !op.reason.trim() || op.reason.length > REASON_MAX)
          issues.push({ field: `${field}.reason`, message: `required: why it goes (at most ${REASON_MAX} characters)` })
        const path = sourceOf(op, field)
        if (!path) return
        const text = texts.get(path)!
        if (op.whole) {
          if (op.text !== undefined) issues.push({ field: `${field}.text`, message: 'whole removes the entire source: no text' })
          whole.add(path)
          texts.set(path, '')
          removals.push({ op: index, source: path, text, whole: true, reason: op.reason })
          return
        }
        if (typeof op.text !== 'string') {
          issues.push({ field: `${field}.text`, message: 'required: the exact excerpt (or whole: true for the entire source)' })
          return
        }
        const at = locate(text, op.text, op.occurrence, field)
        if (at === undefined) return
        texts.set(path, text.slice(0, at) + text.slice(at + op.text.length))
        removals.push({ op: index, source: path, text: op.text, whole: false, reason: op.reason })
        return
      }
    }
  })

  issues.push(...importMetaIssues(kind, meta))

  // O compose: cada fonte que sobrou entra em UM campo, na ordem declarada.
  const fields: Partial<Record<TComposeField, string>> = {}
  const allowed: readonly TComposeField[] = kind === 'agent' ? ['soul', 'systemPrompt'] : ['body']
  const used = new Set<string>()
  for (const { index, op } of composes) {
    const field = `ops[${index}]`
    if (!allowed.includes(op.into)) {
      issues.push({ field: `${field}.into`, message: `for a ${kind}: ${allowed.join(' or ')}` })
      continue
    }
    if (fields[op.into] !== undefined) {
      issues.push({ field: `${field}.into`, message: `${op.into} was already composed` })
      continue
    }
    if (!Array.isArray(op.sources) || !op.sources.length) {
      issues.push({ field: `${field}.sources`, message: 'the sources to join, in order' })
      continue
    }
    const paths: string[] = []
    for (const declared of op.sources) {
      const path = typeof declared === 'string' ? byAlias.get(declared.replace(/^\.\//, '')) : undefined
      if (!path) issues.push({ field: `${field}.sources`, message: `not a source of this item: ${String(declared)}` })
      else if (whole.has(path)) issues.push({ field: `${field}.sources`, message: `removed whole, cannot be composed: ${path}` })
      else if (used.has(path)) issues.push({ field: `${field}.sources`, message: `already composed: ${path}` })
      else {
        used.add(path)
        paths.push(path)
      }
    }
    fields[op.into] = paths
      .map((path) => trimBlank(texts.get(path)!))
      .filter(Boolean)
      .join('\n\n')
  }
  const left = sources.map((source) => source.path).filter((path) => !used.has(path) && !whole.has(path))
  if (!composes.length && left.length === 1) fields[kind === 'agent' ? 'systemPrompt' : 'body'] = trimBlank(texts.get(left[0])!)
  else if (left.length) issues.push({ field: 'ops', message: `every source goes into a compose or is removed whole (with the reason); left out: ${left.join(', ')}` })

  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    applied: {
      meta,
      outputs: [{ from: 'main', meta: { ...meta }, fields }, ...parts],
      links,
      removals,
      diffs: sources.map((source) => ({ source: source.path, diff: diffText(source.text, texts.get(source.path)!, { fromLabel: source.path, toLabel: source.path }) })),
    },
  }
}

/** O rascunho salvo no item (`import_items.drafts`). */
export interface IImportDraft extends IImportApplied {
  key: string
  kind: TImportDraftKind
  /** As fontes lidas, com o `sha256` do inventário: a conferência e a aprovação comparam com o disco. */
  sources: Array<{ path: string; sha256: string }>
  ops: TImportOp[]
  conversationId: string
  proposedAt: string
}

/**
 * A CONFERÊNCIA: o texto final do rascunho tem de ser EXATAMENTE o que as operações produzem a partir da fonte. Refaz a
 * aplicação e compara metadados, saídas, vínculos e remoções; qualquer diferença (um caractere mudado no corpo, uma
 * remoção que não está nas operações) vira problema — e o rascunho é recusado.
 */
export function verifyImportDraft(draft: Pick<IImportDraft, 'kind' | 'ops' | 'meta' | 'outputs' | 'links' | 'removals'>, sources: readonly IImportSourceText[]): IImportIssue[] {
  const result = applyImportOps(draft.kind, sources, draft.ops)
  if (!result.ok) return result.issues
  const { applied } = result
  const issues: IImportIssue[] = []
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (!same(applied.meta, draft.meta)) issues.push({ field: 'meta', message: 'the metadata is not what the operations set' })
  if (applied.outputs.length !== draft.outputs.length) issues.push({ field: 'outputs', message: 'the number of items is not what the operations produce' })
  applied.outputs.forEach((output, index) => {
    const stored = draft.outputs[index]
    if (!stored) return
    for (const name of new Set([...Object.keys(output.fields), ...Object.keys(stored.fields)]) as Set<TComposeField>)
      if (output.fields[name] !== stored.fields[name]) issues.push({ field: `outputs[${index}].${name}`, message: 'the text differs from source + operations' })
    if (!same(output.meta, stored.meta) || output.from !== stored.from) issues.push({ field: `outputs[${index}].meta`, message: 'the metadata differs from the operations' })
  })
  if (!same(applied.links, draft.links)) issues.push({ field: 'links', message: 'the links differ from the operations' })
  if (!same(applied.removals, draft.removals)) issues.push({ field: 'removals', message: 'the removals differ from the operations' })
  return issues
}

/** As operações de remoção (pelo índice): toda uma precisa de OK para aprovar. */
export function removalOps(draft: Pick<IImportDraft, 'removals'>): number[] {
  return draft.removals.map((removal) => removal.op)
}

/** As remoções sem OK. Vazio = pode aprovar. */
export function missingRemovalOks(draft: Pick<IImportDraft, 'removals'>, oks: readonly number[]): number[] {
  return removalOps(draft).filter((op) => !oks.includes(op))
}

/** As operações cruas que chegam da ferramenta, como lista tipada (a forma; o conteúdo, `applyImportOps` confere). */
export function parseImportOps(value: unknown): { ops: TImportOp[]; issues: IImportIssue[] } {
  if (!Array.isArray(value)) return { ops: [], issues: [{ field: 'ops', message: 'a list of operations' }] }
  const issues: IImportIssue[] = []
  const ops = value.filter((entry, index) => {
    const valid = !!entry && typeof entry === 'object' && !Array.isArray(entry) && IMPORT_OP_TYPES.includes((entry as { op?: TImportOp['op'] }).op as TImportOp['op'])
    if (!valid) issues.push({ field: `ops[${index}].op`, message: `one of ${IMPORT_OP_TYPES.join(', ')}` })
    return valid
  }) as TImportOp[]
  return { ops, issues }
}
