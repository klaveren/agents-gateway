import { IMPORT_METADATA_KEY, importBuilderAgentId } from '@domain/Builder.Agents'
import {
  applyImportOps,
  builderKindForItem,
  draftKindForItem,
  IImportDraft,
  IImportIssue,
  IImportSourceText,
  IMPORT_LINK_KINDS,
  missingRemovalOks,
  parseImportOps,
  proposalIssues,
  TImportOp,
  verifyImportDraft,
} from '@domain/Import.Draft'
import { canReclassify, canTransition, releasedFromBuilder } from '@domain/Import.Job'
import { IImportJobItem, IImportReview, TImportItemState } from '@domain/models/ImportJob.Model'
import { IInventorySource, TInventoryKind } from '@domain/models/ImportInventory.Model'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { IImportJobRecord, IImportRepository } from '@domain/ports/ImportRepository.Port'
import { isFileSource, textSources } from '@domain/Import.Files'

/**
 * Por que o pedido não serve:
 * - `not_found`: o trabalho, o item ou a conversa não existem aqui (o item não é desta conversa);
 * - `transition`: o estado do item não permite (aprovar sem rascunho, abrir conversa de item aprovado…);
 * - `kind`: o item não tem construtor, ou o lote mistura construtores;
 * - `source_changed`: a fonte no disco não é a do trabalho (o `sha256` mudou): analise de novo;
 * - `invalid`: as operações não servem (os problemas vão em `issues`);
 * - `removals`: falta o OK de alguma remoção;
 * - `unavailable`: o servidor não abre conversa (sem construtor configurado).
 */
export class ImportBuildError extends Error {
  constructor(
    readonly code: 'not_found' | 'transition' | 'kind' | 'source_changed' | 'invalid' | 'removals' | 'unavailable',
    message: string,
    readonly field?: string,
    readonly issues: IImportIssue[] = [],
  ) {
    super(message)
    this.name = 'ImportBuildError'
  }
}

/** Um arquivo do repositório lido pelo servidor: contido, com o `sha256` do conteúdo cru e o texto MASCARADO. */
export interface IImportSourceFile {
  sha256: string
  text: string
  binary: boolean
}

/** O que a abertura da conversa precisa: o construtor (em modo importação), o projeto e a marca da importação. */
export interface IImportConversationInput {
  kind: TProtocolKind
  agentId: string
  projectId: string
  metadata: Record<string, unknown>
  /** Quem abriu (o dono da conversa). */
  owner?: Record<string, string>
}

export interface IImportBuildDeps {
  repository: IImportRepository
  /** ⛔ Lê um arquivo do repositório DESTE projeto, contido e mascarado. Ausente o arquivo (ou fora): `undefined`. */
  readSource: (projectId: string, repository: string, path: string) => IImportSourceFile | undefined
  /** Abre a conversa com o construtor e devolve o id dela. Ausente: não há como abrir (`unavailable`). */
  openConversation?: (input: IImportConversationInput) => Promise<string>
  /** O documento de texto (spec, ADR, knowledge) existe no catálogo, visível ao projeto? Ausente: não confere o que não é do trabalho. */
  docExists?: (id: string, projectId: string) => boolean
  now?: () => Date
}

/** Os estados de onde a conversa do construtor pode (re)começar um item. `drafting`: liga o item a esta conversa. */
const OPENABLE: readonly TImportItemState[] = ['pending', 'drafting', 'review', 'rejected', 'error', 'stale']
/** De um lote salvo, só o que ainda não tem conversa nem rascunho em curso. */
const FRESH: readonly TImportItemState[] = ['pending', 'drafting', 'rejected', 'error', 'stale']
const PAGE_DEFAULT = 30_000
const PAGE_MAX = 60_000
const KEYS_MAX = 200
const COMMENT_MAX = 4_000
const REASON_MAX = 1_000
/** Quantos motivos de remoção já decididos a lista mostra (os mais frequentes). */
const DECIDED_MAX = 12

/** Para quem a conversa abre: a seleção (`keys`) ou um lote salvo (`batchId`); `kind` escolhe o construtor no lote misto. */
export interface IImportOpenOptions {
  keys?: readonly string[]
  batchId?: string
  kind?: TProtocolKind
  owner?: Record<string, string>
}

/** O que a abertura devolve. */
export interface IImportConversation {
  conversationId: string
  kind: TProtocolKind
  agentId: string
  keys: string[]
}

/** Uma conversa de construtor de um lote, com os itens dela que o construtor ainda deve. */
export interface IImportBatchConversation extends IImportConversation {
  pending: string[]
}

/**
 * O CONSTRUTOR EM MODO IMPORTAÇÃO (`docs/integration/plano-importador.md`, PR 7): uma conversa por lote, as ferramentas
 * dela e a revisão mínima.
 *
 * - `open`: abre UMA conversa com o construtor do tipo para um conjunto de itens do trabalho e os liga a ela (`drafting`);
 * - `listText`/`readSource`/`propose`: o que as ferramentas `list_import_items`, `read_import_source` e
 *   `propose_import_draft` fazem — só para os itens DESTA conversa;
 * - `approve`/`adjust`: a revisão. Aprovar exige OK em toda remoção e confere de novo o rascunho com a fonte no disco.
 *
 * ⛔ Nada daqui grava no catálogo (é do L5/PR 9): aprovar só muda o estado para `approved`.
 */
export class ImportBuildService {
  constructor(private readonly deps: IImportBuildDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  /** Abre a conversa do construtor para os itens (um construtor por lote) e os liga a ela. */
  async open(projectId: string, jobId: string, by: string, options: IImportOpenOptions): Promise<IImportConversation> {
    const record = this.record(projectId, jobId)
    const unique = [...new Set(options.keys ? this.withTriggers(record.id, options.keys, options.batchId) : this.fromBatch(record.id, options))]
    if (!unique.length) throw new ImportBuildError('invalid', 'at least one item', 'keys')
    if (unique.length > KEYS_MAX) throw new ImportBuildError('invalid', `at most ${KEYS_MAX} items per conversation`, 'keys')
    const batch = options.batchId ? this.deps.repository.batch(record.id, options.batchId) : undefined
    if (options.batchId && !batch) throw new ImportBuildError('not_found', `batch not found in this import job: ${options.batchId}`, 'batchId')
    if (batch && options.keys) {
      const inBatch = new Set(batch.keys)
      const outside = unique.filter((key) => !inBatch.has(key))
      if (outside.length) throw new ImportBuildError('invalid', `not in the batch ${batch.name}: ${outside.join(', ')}`, 'keys')
    }
    const entries = unique.map((key) => {
      const entry = this.deps.repository.item(record.id, key)
      if (!entry) throw new ImportBuildError('not_found', `item not found in this import job: ${key}`, 'keys')
      return entry
    })
    const kinds = new Set<TProtocolKind>()
    for (const entry of entries) {
      const effective = entry.kind ?? entry.item.kind
      const kind = builderKindForItem(effective)
      if (!kind) throw new ImportBuildError('kind', `no builder imports a ${effective}: ${entry.key}`, 'keys')
      if (options.kind && kind !== options.kind) throw new ImportBuildError('kind', `${entry.key} goes to the ${kind} builder, not ${options.kind}`, 'keys')
      kinds.add(kind)
      if (entry.goneAt) throw new ImportBuildError('transition', `the item left the source (saiu da fonte): ${entry.key} — nothing to build from`, 'keys')
      if (!OPENABLE.includes(entry.state) || (entry.state !== 'drafting' && !canTransition(entry.state, 'drafting')))
        throw new ImportBuildError('transition', `an item in state ${entry.state} cannot go to the builder: ${entry.key}`, 'keys')
    }
    if (kinds.size > 1) throw new ImportBuildError('kind', `one builder per conversation: these items go to ${[...kinds].join(', ')}`, 'keys')
    if (!this.deps.openConversation) throw new ImportBuildError('unavailable', 'no builder is configured on this gateway (Settings → builder model)')
    const kind = [...kinds][0]
    const agentId = importBuilderAgentId(kind)
    const conversationId = await this.deps.openConversation({
      kind,
      agentId,
      projectId,
      metadata: { [IMPORT_METADATA_KEY]: { job: record.id, keys: unique, ...(options.batchId ? { batch: options.batchId } : {}) } },
      ...(options.owner ? { owner: options.owner } : {}),
    })
    const at = this.now()
    for (const entry of entries) this.deps.repository.updateItem(record.id, entry.key, { state: 'drafting', staleFrom: null, conversationId, basis: entry.fingerprint, by, at })
    return { conversationId, kind, agentId, keys: unique }
  }

  /**
   * PREPARAR TUDO: o lote salvo vai ao construtor de uma vez, UMA conversa por construtor (o agente com os triggers,
   * as specs, as skills…), com os itens dele que ainda vão (os de `fromBatch`). ⛔ Só abre as conversas: nada é
   * proposto, aprovado nem gravado; a pessoa revisa cada rascunho.
   */
  async prepare(projectId: string, jobId: string, batchId: string, by: string, owner?: Record<string, string>): Promise<IImportConversation[]> {
    const record = this.record(projectId, jobId)
    const byKind = new Map<TProtocolKind, string[]>()
    for (const key of this.fromBatch(record.id, { batchId })) {
      const entry = this.deps.repository.item(record.id, key)!
      const kind = builderKindForItem(entry.kind ?? entry.item.kind)!
      byKind.set(kind, [...(byKind.get(kind) ?? []), key])
    }
    // O trigger não se monta sem o agente: o agente do lote que está noutra conversa SEM rascunho vem junto (sai dela).
    const triggers = byKind.get('agent') ?? []
    const batch = this.deps.repository.batch(record.id, batchId)!
    for (const key of [...triggers]) {
      const parent = this.deps.repository.item(record.id, key)?.item.parent
      if (!parent || triggers.includes(parent) || !batch.keys.includes(parent)) continue
      const agent = this.deps.repository.item(record.id, parent)
      if (agent?.state === 'drafting' && !agent.goneAt && !lastDraft(agent)) triggers.unshift(parent)
    }
    const opened: IImportConversation[] = []
    for (const [kind, keys] of byKind)
      for (let at = 0; at < keys.length; at += KEYS_MAX)
        opened.push(await this.open(projectId, jobId, by, { keys: keys.slice(at, at + KEYS_MAX), batchId, kind, ...(owner ? { owner } : {}) }))
    return opened
  }

  /**
   * As conversas de construtor dos itens de um LOTE SALVO, com o que cada uma ainda deve (`pending`: os itens dela em
   * `drafting`, sem rascunho ou com ajuste pedido). É o que o "Preparar tudo" manda rodar.
   */
  batchConversations(projectId: string, jobId: string, batchId: string): IImportBatchConversation[] {
    const record = this.record(projectId, jobId)
    const batch = this.deps.repository.batch(record.id, batchId)
    if (!batch) throw new ImportBuildError('not_found', `batch not found in this import job: ${batchId}`, 'batchId')
    const groups = new Map<string, IImportBatchConversation>()
    for (const key of new Set([...batch.order, ...batch.keys])) {
      const entry = this.deps.repository.item(record.id, key)
      if (!entry?.conversationId || entry.goneAt) continue
      const kind = builderKindForItem(entry.kind ?? entry.item.kind)
      if (!kind) continue
      const group = groups.get(entry.conversationId) ?? { conversationId: entry.conversationId, kind, agentId: importBuilderAgentId(kind), keys: [], pending: [] }
      group.keys.push(entry.key)
      if (entry.state === 'drafting') group.pending.push(entry.key)
      groups.set(entry.conversationId, group)
    }
    return [...groups.values()]
  }

  /**
   * O agente aberto sozinho leva os TRIGGERS dele (o mesmo construtor; separado, o construtor não tem o que montar):
   * os que ainda vão, sem conversa nem rascunho em curso. Num lote, só os que estão nele.
   */
  private withTriggers(jobId: string, keys: readonly string[], batchId?: string): string[] {
    const inBatch = batchId ? new Set(this.deps.repository.batch(jobId, batchId)?.keys ?? []) : undefined
    const all = this.deps.repository.items(jobId)
    const out = new Set(keys)
    for (const key of keys) {
      if (!all.some((entry) => entry.key === key && (entry.kind ?? entry.item.kind) === 'agent')) continue
      for (const entry of all)
        if (
          entry.item.parent === key &&
          !entry.goneAt &&
          (entry.kind ?? entry.item.kind) === 'trigger' &&
          FRESH.includes(entry.state) &&
          !(entry.state === 'drafting' && entry.conversationId) &&
          (!inBatch || inBatch.has(entry.key))
        )
          out.add(entry.key)
    }
    return [...out]
  }

  /**
   * Os itens de um LOTE SALVO que ainda vão ao construtor: os da ordem do lote (os que têm conversa de construtor) em
   * estado de (re)começar, sem conversa em curso, e do construtor pedido (`kind`) quando há. ⛔ O que saiu da fonte, não.
   */
  private fromBatch(jobId: string, options: IImportOpenOptions): string[] {
    if (!options.batchId) throw new ImportBuildError('invalid', 'keys or batchId is required', 'keys')
    const batch = this.deps.repository.batch(jobId, options.batchId)
    if (!batch) throw new ImportBuildError('not_found', `batch not found in this import job: ${options.batchId}`, 'batchId')
    const keys = (batch.order.length ? batch.order : batch.keys).filter((key) => {
      const entry = this.deps.repository.item(jobId, key)
      if (!entry || entry.goneAt || !FRESH.includes(entry.state) || (entry.state === 'drafting' && entry.conversationId)) return false
      const kind = builderKindForItem(entry.kind ?? entry.item.kind)
      return !!kind && (!options.kind || kind === options.kind)
    })
    if (!keys.length) throw new ImportBuildError('invalid', `nothing in the batch ${batch.name} goes to the builder now${options.kind ? ` (${options.kind})` : ''}`, 'batchId')
    return keys
  }

  /**
   * Os itens desta conversa, na importação. ⛔ Conversa sem itens não tem o que fazer; o item que SAIU DA FONTE sai
   * da conversa (não há fonte a ler nem a conferir).
   */
  conversation(conversationId: string): { job: IImportJobRecord; items: IImportJobItem[] } {
    const found = conversationId ? this.deps.repository.byConversation(conversationId) : undefined
    const items = found?.items.filter((entry) => !entry.goneAt) ?? []
    if (!found || !items.length) throw new ImportBuildError('not_found', 'this conversation has no import items: open it from the Importer')
    return { job: found.job, items }
  }

  /** `list_import_items`: os itens da conversa, as fontes, o que citam com o mapa de ids e o pedido de ajuste. */
  listText(conversationId: string): string {
    const { job, items } = this.conversation(conversationId)
    const ids = this.idMap(job.id)
    const lines = [`Import job ${job.id} — repository ${job.repository}${job.head ? ` @ ${job.head.slice(0, 12)}` : ''}. ${items.length} item(s) in this conversation.`]
    for (const entry of items) {
      const kind = entry.kind ?? entry.item.kind
      lines.push(
        '',
        `## ${entry.key}`,
        `- kind: ${kind}${entry.kind ? ` (reclassified; detected ${entry.item.kind})` : ''} · proposed id: ${entry.targetId ?? entry.item.candidateId} · state: ${entry.state}`,
      )
      if (entry.item.title) lines.push(`- title in the source: ${entry.item.title}`)
      lines.push(`- sources (${entry.item.sources.length}):`)
      for (const source of entry.item.sources)
        lines.push(
          `  - ${source.path}${source.role ? ` [${source.role}]` : ''} · ${source.bytes} bytes · ≈${source.tokens} tokens${sourceFlags(source)}${isFileSource(kind, source) ? ' · FILE: goes byte for byte to the resource folder (no operation: do not compose nor remove it)' : ''}`,
        )
      if (entry.item.refs.length) {
        lines.push('- cites (path → item → gateway id):')
        for (const ref of entry.item.refs) lines.push(`  - ${ref.path}${ref.item ? ` → ${ref.item} → ${ids.get(ref.item) ?? '(not imported)'}` : ' → (no item)'}`)
      }
      if (entry.item.unresolved.length) lines.push(`- broken citations (no file): ${entry.item.unresolved.join(', ')}`)
      for (const note of entry.item.notes) lines.push(`- note [${note.level}] ${note.code}: ${note.text}`)
      const review = entry.review as IImportReview | undefined
      if (entry.state === 'drafting' && review?.adjust) lines.push(`- ⚠️ the person asked for an adjustment: ${review.adjust.comment}`)
      if (kind === 'agent') {
        const here = new Set(items.map((one) => one.key))
        const away = this.deps.repository.items(job.id).filter((one) => one.item.parent === entry.key && !here.has(one.key))
        if (away.length)
          lines.push(
            `- ⚠️ ${away.length} trigger(s) of this agent are in the import job but NOT in this conversation (${away
              .slice(0, 5)
              .map((one) => `${one.key} [${one.state}]`)
              .join(
                ', ',
              )}${away.length > 5 ? ', …' : ''}). They exist: never ask to create items; ask the person to open the builder with them (Importer → "Com as dependências").`,
          )
      }
      const draft = lastDraft(entry)
      if (draft) lines.push(`- last draft: ${draft.ops.length} operation(s), ${draft.removals.length} removal(s), ${draft.outputs.length} item(s), proposed ${draft.proposedAt}`)
    }
    const decided = this.decidedRemovals(job.id)
    if (decided.length) {
      lines.push(
        '',
        '## Removals the person already approved in this import job (by reason)',
        'Removals like these need no question: put them in the draft; the person still gives the OK of each one in the review.',
      )
      for (const one of decided) lines.push(`- ${one.reason} — approved ${one.count}× (e.g. ${one.example})`)
    }
    return lines.join('\n')
  }

  /**
   * As remoções que a pessoa já aprovou no trabalho (dos itens aprovados ou gravados), agrupadas pelo motivo: o que o
   * construtor não precisa perguntar de novo.
   */
  private decidedRemovals(jobId: string): Array<{ reason: string; count: number; example: string }> {
    const byReason = new Map<string, { reason: string; count: number; example: string }>()
    for (const entry of this.deps.repository.items(jobId)) {
      if (entry.state !== 'approved' && entry.state !== 'applied') continue
      for (const removal of lastDraft(entry)?.removals ?? []) {
        const reason = removal.reason.trim()
        const found = byReason.get(reason)
        if (found) found.count++
        else byReason.set(reason, { reason, count: 1, example: removal.whole ? `whole source ${removal.source}` : excerpt(removal.text) })
      }
    }
    return [...byReason.values()].sort((a, b) => b.count - a.count).slice(0, DECIDED_MAX)
  }

  /**
   * `reclassify_import_item`: a PESSOA pediu, nesta conversa, outro tipo para um item que ainda não tem rascunho. O item
   * sai da conversa e volta à fila (`pending`), para o construtor do tipo novo (o Preparar abre a conversa dele).
   */
  reclassify(conversationId: string, key: string, kind: unknown, reason: unknown): IImportJobItem {
    const { job, items } = this.conversation(conversationId)
    const entry = items.find((item) => item.key === key)
    if (!entry) throw new ImportBuildError('not_found', `not an item of this conversation: ${key}`, 'item')
    if (typeof kind !== 'string' || !builderKindForItem(kind as TInventoryKind)) throw new ImportBuildError('kind', `no builder imports a ${String(kind)}`, 'kind')
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text) throw new ImportBuildError('invalid', 'say why (what the person asked)', 'reason')
    if (text.length > REASON_MAX) throw new ImportBuildError('invalid', `at most ${REASON_MAX} characters`, 'reason')
    if (!canReclassify(entry.state, !!lastDraft(entry))) throw new ImportBuildError('transition', `an item in state ${entry.state} with a draft cannot be reclassified`, 'item')
    const target = kind as TInventoryKind
    if (target === (entry.kind ?? entry.item.kind)) throw new ImportBuildError('invalid', `the item is already a ${target}`, 'kind')
    return this.deps.repository.updateItem(job.id, key, {
      ...releasedFromBuilder(entry.fingerprint),
      kind: target === entry.item.kind ? null : target,
      by: `builder:${conversationId}`,
      at: this.now(),
    })!
  }

  /**
   * Os itens do lote no construtor cuja conversa SUMIU (apagada): soltos dela, continuam `drafting` sem conversa e o
   * Preparar abre outra para eles. Devolve as chaves soltas.
   */
  async releaseLost(projectId: string, jobId: string, batchId: string, exists: (conversationId: string) => Promise<boolean>): Promise<string[]> {
    const record = this.record(projectId, jobId)
    const batch = this.deps.repository.batch(record.id, batchId)
    if (!batch) return []
    const known = new Map<string, boolean>()
    const released: string[] = []
    for (const key of new Set([...batch.order, ...batch.keys])) {
      const entry = this.deps.repository.item(record.id, key)
      if (entry?.state !== 'drafting' || !entry.conversationId) continue
      if (!known.has(entry.conversationId)) known.set(entry.conversationId, await exists(entry.conversationId))
      if (known.get(entry.conversationId)) continue
      this.deps.repository.updateItem(record.id, key, { conversationId: null, at: this.now() })
      released.push(key)
    }
    return released
  }

  /** `read_import_source`: uma página de uma fonte do item (ou do que ele cita), conferindo o `sha256` do trabalho. */
  readSource(conversationId: string, key: string, options: { path?: string; offset?: number; limit?: number } = {}): string {
    const { job, items } = this.conversation(conversationId)
    const entry = items.find((item) => item.key === key)
    if (!entry) throw new ImportBuildError('not_found', `not an item of this conversation: ${key}`, 'item')
    const allowed = this.readable(job.id, entry)
    let source: IInventorySource | undefined
    if (options.path === undefined) {
      if (entry.item.sources.length !== 1)
        throw new ImportBuildError(
          'invalid',
          `the item has ${entry.item.sources.length} sources: say which path (${entry.item.sources.map((item) => item.path).join(', ')})`,
          'path',
        )
      source = entry.item.sources[0]
    } else {
      const wanted = options.path.replace(/^\.\//, '')
      source = allowed.find((item) => item.path === wanted || item.aliases.includes(wanted))
      if (!source) throw new ImportBuildError('not_found', `not a source of this item nor of what it cites: ${options.path}`, 'path')
    }
    const file = this.readChecked(job, source)
    const total = file.text.length
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(options.limit ?? PAGE_DEFAULT)))
    const page = file.text.slice(offset, offset + limit)
    const end = offset + page.length
    const more = end < total ? ` More: call again with offset ${end}.` : ''
    return `Source ${source.path} (sha256 checked; secrets masked) — characters ${offset}–${end} of ${total}.${more}\n\n${page}`
  }

  /**
   * `propose_import_draft`: aplica as operações sobre as fontes lidas AGORA do disco (conferindo o `sha256`), confere e
   * grava o rascunho no item; o item vai para `review`. Volta os problemas, operação a operação, quando algo não serve.
   */
  propose(conversationId: string, key: string, meta: unknown, rawOps: unknown): { draft: IImportDraft; item: IImportJobItem } {
    const { job, items } = this.conversation(conversationId)
    const entry = items.find((item) => item.key === key)
    if (!entry) throw new ImportBuildError('not_found', `not an item of this conversation: ${key}`, 'item')
    if (entry.state !== 'drafting' && entry.state !== 'review') throw new ImportBuildError('transition', `the item is ${entry.state}: no draft is taken now`, 'item')
    const effective = entry.kind ?? entry.item.kind
    const kind = draftKindForItem(effective)
    if (!kind) throw new ImportBuildError('kind', `no draft for a ${effective}`, 'item')
    const parsed = parseImportOps(rawOps ?? [])
    const metaOps: TImportOp[] = []
    const issues: IImportIssue[] = [...parsed.issues]
    if (meta !== undefined && meta !== null) {
      if (typeof meta !== 'object' || Array.isArray(meta)) issues.push({ field: 'meta', message: 'an object of text fields' })
      else
        for (const [field, value] of Object.entries(meta as Record<string, unknown>)) {
          if (typeof value === 'string') metaOps.push({ op: 'setMeta', field, value })
          else issues.push({ field: `meta.${field}`, message: 'must be a text' })
        }
    }
    if (issues.length) throw new ImportBuildError('invalid', 'the draft has problems', 'ops', issues)
    // ⚖️ Os metadados do argumento vão DEPOIS das operações: os índices das operações (e dos OKs de remoção) não mudam.
    const ops = [...parsed.ops, ...metaOps]
    // As fontes de TEXTO: o anexo que vai como arquivo (o script da skill) não entra no rascunho (ver `Import.Files`).
    const sources = this.sourceTexts(job, entry, textSources(effective, entry.item.sources))
    const result = applyImportOps(kind, sources, ops)
    if (!result.ok) throw new ImportBuildError('invalid', 'the draft has problems', 'ops', result.issues)
    // O que só a gravação recusaria (limite do catálogo, escopo): recusado AGORA, para o construtor acertar de primeira.
    const strict = proposalIssues(kind, result.applied.outputs)
    if (strict.length) throw new ImportBuildError('invalid', 'the draft has problems', 'ops', strict)
    const draft: IImportDraft = {
      key,
      kind,
      sources: textSources(effective, entry.item.sources).map((source) => ({ path: source.path, sha256: source.sha256 })),
      ops,
      ...result.applied,
      conversationId,
      proposedAt: this.now().toISOString(),
    }
    const check = verifyImportDraft(draft, sources)
    if (check.length) throw new ImportBuildError('invalid', 'the draft does not match source + operations', 'ops', check)
    const wrong = this.wrongLinks(job, draft.links)
    if (wrong.length) throw new ImportBuildError('invalid', 'the draft has problems', 'ops', wrong)
    const updated = this.deps.repository.updateItem(job.id, key, {
      state: 'review',
      drafts: [draft],
      review: null,
      basis: entry.fingerprint,
      by: `builder:${conversationId}`,
      at: this.now(),
    })
    return { draft, item: updated! }
  }

  /**
   * APROVAR: só com rascunho em `review` e OK em TODA remoção. Confere de novo o rascunho com a fonte no disco (o mesmo
   * `sha256` e o mesmo texto final). ⛔ Não grava no catálogo: o item só vai para `approved`.
   */
  approve(projectId: string, jobId: string, key: string, oks: readonly number[], by: string): IImportJobItem {
    const record = this.record(projectId, jobId)
    const entry = this.entry(record.id, key)
    if (entry.state !== 'review') throw new ImportBuildError('transition', `an item in state ${entry.state} cannot be approved`, 'key')
    const draft = lastDraft(entry)
    if (!draft) throw new ImportBuildError('transition', 'the item has no draft to approve', 'key')
    const missing = missingRemovalOks(draft, oks)
    if (missing.length) throw new ImportBuildError('removals', `every removal needs an OK; missing: ${missing.map((op) => `ops[${op}]`).join(', ')}`, 'removals')
    const issues = verifyImportDraft(draft, this.sourceTexts(record, entry, draftSources(entry, draft)))
    if (issues.length) throw new ImportBuildError('invalid', 'the draft does not match source + operations', 'key', issues)
    const at = this.now()
    const removals = draft.removals.map((removal) => removal.op)
    return this.deps.repository.updateItem(record.id, key, {
      state: 'approved',
      approvedBy: by,
      approvedAt: at,
      review: { removals, by, at: at.toISOString() },
      basis: entry.fingerprint,
      by,
      at,
    })!
  }

  /** PEDIR AJUSTE: o item volta a `drafting`, com o comentário para a conversa (o construtor o lê nos itens dela). */
  adjust(projectId: string, jobId: string, key: string, comment: string, by: string): IImportJobItem {
    const record = this.record(projectId, jobId)
    const entry = this.entry(record.id, key)
    const text = comment.trim()
    if (!text) throw new ImportBuildError('invalid', 'say what to adjust', 'comment')
    if (text.length > COMMENT_MAX) throw new ImportBuildError('invalid', `at most ${COMMENT_MAX} characters`, 'comment')
    if (entry.state !== 'review') throw new ImportBuildError('transition', `an item in state ${entry.state} has no draft to adjust`, 'key')
    if (!entry.conversationId) throw new ImportBuildError('transition', 'the item has no builder conversation', 'key')
    const at = this.now()
    const previous = (entry.review as IImportReview | undefined) ?? {}
    return this.deps.repository.updateItem(record.id, key, {
      state: 'drafting',
      review: { ...previous, adjust: { comment: text, by, at: at.toISOString() }, by, at: at.toISOString() },
      basis: entry.fingerprint,
      by,
      at,
    })!
  }

  /**
   * DE VOLTA AO CONSTRUTOR o item aprovado (ou a revisar) que a gravação recusou: volta a `drafting` com o pedido de
   * ajuste já escrito (o que o catálogo recusou), para a mesma conversa. A aprovação some: o rascunho novo passa pela
   * revisão de novo.
   */
  reopen(projectId: string, jobId: string, key: string, comment: string, by: string): IImportJobItem {
    const record = this.record(projectId, jobId)
    const entry = this.entry(record.id, key)
    const text = comment.trim().slice(0, COMMENT_MAX)
    if (!text) throw new ImportBuildError('invalid', 'say what to adjust', 'comment')
    if (entry.state !== 'approved' && entry.state !== 'review') throw new ImportBuildError('transition', `an item in state ${entry.state} has no draft to send back`, 'key')
    if (!entry.conversationId) throw new ImportBuildError('transition', 'the item has no builder conversation', 'key')
    const at = this.now()
    const previous = (entry.review as IImportReview | undefined) ?? {}
    return this.deps.repository.updateItem(record.id, key, {
      state: 'drafting',
      review: { ...previous, adjust: { comment: text, by, at: at.toISOString() }, by, at: at.toISOString() },
      basis: entry.fingerprint,
      by,
      at,
    })!
  }

  private record(projectId: string, jobId: string): IImportJobRecord {
    const record = this.deps.repository.get(projectId, jobId)
    if (!record) throw new ImportBuildError('not_found', `import job not found: ${jobId}`)
    return record
  }

  private entry(jobId: string, key: string): IImportJobItem {
    const entry = this.deps.repository.item(jobId, key)
    if (!entry) throw new ImportBuildError('not_found', `item not found in this import job: ${key}`, 'key')
    return entry
  }

  /**
   * ⛔ O vínculo que aponta um item do trabalho que não é documento (um command, uma skill, um agente), ou um id que
   * não é do trabalho nem documento do catálogo: o painel só anexa spec, ADR ou knowledge, e o catálogo recusaria. A
   * citação fica como texto.
   */
  private wrongLinks(job: IImportJobRecord, links: IImportDraft['links']): IImportIssue[] {
    const kindsById = new Map<string, Array<{ key: string; kind: TInventoryKind }>>()
    for (const entry of this.deps.repository.items(job.id)) {
      if (entry.state === 'skipped') continue
      const id = entry.targetId ?? entry.item.candidateId
      kindsById.set(id, [...(kindsById.get(id) ?? []), { key: entry.key, kind: entry.kind ?? entry.item.kind }])
    }
    return links.flatMap((link) => {
      const found = kindsById.get(link.target)
      if (found?.some((one) => IMPORT_LINK_KINDS.includes(one.kind))) return []
      // ⛔ Nem item do trabalho nem documento do catálogo: a gravação recusaria ("no such document").
      if (!found) {
        if (!this.deps.docExists || this.deps.docExists(link.target, job.projectId)) return []
        return [
          {
            field: `ops[${link.op}].target`,
            message: `${link.target} is no document of this import job nor of the catalog. Drop this linkCitation and leave the citation as text`,
          },
        ]
      }
      const { key, kind } = found[0]
      return [
        {
          field: `ops[${link.op}].target`,
          message: `${link.target} is a ${kind} (${key}): a link attaches only a spec, ADR or knowledge. Drop this linkCitation and leave the citation as text`,
        },
      ]
    })
  }

  /** O mapa de ids do trabalho: a chave do item → o id no gateway (o escolhido, senão o proposto). */
  private idMap(jobId: string): Map<string, string> {
    return new Map(this.deps.repository.items(jobId).map((entry) => [entry.key, entry.targetId ?? entry.item.candidateId]))
  }

  /** As fontes que a conversa pode ler para um item: as dele e as dos itens que ele cita. */
  private readable(jobId: string, entry: IImportJobItem): IInventorySource[] {
    const cited = new Set(entry.item.refs.map((ref) => ref.item).filter((key): key is string => !!key && key !== entry.key))
    const others = cited.size ? this.deps.repository.items(jobId).filter((item) => cited.has(item.key)) : []
    return [...entry.item.sources, ...others.flatMap((item) => item.item.sources)]
  }

  /** ⛔ Lê pelo servidor e confere o `sha256` do trabalho: fonte mudada é recusada. */
  private readChecked(job: IImportJobRecord, source: IInventorySource): IImportSourceFile {
    const file = this.deps.readSource(job.projectId, job.repository, source.path)
    if (!file) throw new ImportBuildError('source_changed', `source not found anymore: ${source.path} — analyse the repository again`, 'path')
    if (file.sha256 !== source.sha256) throw new ImportBuildError('source_changed', `source changed since the analysis: ${source.path} — analyse the repository again`, 'path')
    if (file.binary) throw new ImportBuildError('invalid', `binary file: ${source.path}`, 'path')
    return file
  }

  private sourceTexts(job: IImportJobRecord, entry: IImportJobItem, sources: readonly IInventorySource[] = entry.item.sources): IImportSourceText[] {
    return sources.map((source) => ({ path: source.path, aliases: source.aliases, text: this.readChecked(job, source).text }))
  }
}

function sourceFlags(source: IInventorySource): string {
  const flags = [source.generated ? `generated${source.generated.length ? ` from ${source.generated.join(', ')}` : ''}` : '', source.secret ? 'secret masked' : ''].filter(Boolean)
  return flags.length ? ` · ${flags.join(' · ')}` : ''
}

/** O começo de um trecho, numa linha. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return `"${line.length > 80 ? `${line.slice(0, 80)}…` : line}"`
}

/** O rascunho em vigor do item (o último). */
export function lastDraft(entry: Pick<IImportJobItem, 'drafts'>): IImportDraft | undefined {
  const draft = entry.drafts.at(-1)
  return draft && typeof draft === 'object' && Array.isArray((draft as IImportDraft).ops) ? (draft as IImportDraft) : undefined
}

/** As fontes com que o rascunho foi feito (o de antes cobria também os anexos que hoje vão como arquivo). */
export function draftSources(entry: Pick<IImportJobItem, 'item'>, draft: Pick<IImportDraft, 'sources'>): IInventorySource[] {
  const paths = new Set(draft.sources.map((source) => source.path))
  return entry.item.sources.filter((source) => paths.has(source.path))
}
