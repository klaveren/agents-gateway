import { ICatalogDocument, TCanonicalValue, TCatalogKind } from '@domain/Catalog.Document'
import { mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { ICatalogHistoryRepository, ICatalogRevision, TRevisionOp, TRevisionSource } from '@domain/ports/CatalogHistoryRepository.Port'
import { CatalogReader, TCatalogScope } from './Catalog.Reader'

/**
 * A chave de um item no histórico. `id` é o `item_id`: o id do item e, no MCP, a CHAVE (`mcpServerKey`) — dois projetos
 * podem ter o mesmo id de servidor. `projectId` só serve de escopo para o `delete` de item que nunca teve revisão.
 */
export interface ICatalogItemKey {
  kind: TCatalogKind
  id: string
  projectId?: string
}

/** Quem e por onde. `op` força a operação (o import e o rollback); ausente, sai da comparação com a última revisão. */
export interface ICatalogChange {
  by: string
  source?: TRevisionSource
  op?: Extract<TRevisionOp, 'restore' | 'import'>
  batchId?: string
  note?: string
  /** As ampliações que quem grava aceitou (as chaves do `confirm`). */
  widenings?: readonly string[]
}

/** O que os serviços de escrita pedem ao histórico. */
export interface ICatalogRecorder {
  /** Grava a revisão de cada item que mudou desde a última (mesmo `hash` não grava). */
  record(keys: readonly ICatalogItemKey[], change: ICatalogChange): ICatalogRevision[]
  /** O item e os que mudam junto quando ele sai (a cascata). ⚠️ Lido ANTES de apagar. */
  withDependents(key: ICatalogItemKey): ICatalogItemKey[]
  /** Os itens do escopo (o projeto que vai ser apagado). ⚠️ Lido ANTES de apagar. */
  keysOf(scope: TCatalogScope): ICatalogItemKey[]
}

const DOC_KINDS: readonly TCatalogKind[] = ['spec', 'adr', 'knowledge']
const RESOURCE_KINDS: readonly TCatalogKind[] = ['skill', 'command']
const SYSTEM = 'system'

/** A chave do item no histórico (o MCP vai pela chave com o escopo). */
export function catalogItemKey(document: ICatalogDocument): ICatalogItemKey {
  const id = document.kind === 'mcp' ? mcpServerKey({ id: document.id, projectId: document.projectId }) : document.id
  return { kind: document.kind, id, ...(document.projectId ? { projectId: document.projectId } : {}) }
}

const keyText = (key: { kind: TCatalogKind; id: string }) => `${key.kind}\0${key.id}`

/**
 * O HISTÓRICO DO CATÁLOGO: cada escrita bem-sucedida grava o documento canônico inteiro do item (ver
 * docs/integration/plano-catalogo-historico.md §2.2).
 *
 * ⚖️ NA APLICAÇÃO, NÃO NO REPOSITÓRIO: o documento do agente junta tabelas de repositórios diferentes, e só o
 * `CatalogReader` o monta. O serviço relê o item DEPOIS da escrita e compara com a última revisão — a operação sai daí.
 *
 * ⚖️ SÓ SOMA: o item e a revisão são conexões diferentes; se a revisão falhar, o item já está gravado e a reconciliação
 * do boot (`reconcile`) pega a deriva.
 */
export class CatalogHistoryService implements ICatalogRecorder {
  /** Dentro de `within`: as chaves que as escritas pediram, gravadas juntas no fim. */
  private pending?: ICatalogItemKey[]

  constructor(
    private readonly repository: ICatalogHistoryRepository,
    private readonly reader: Pick<CatalogReader, 'read' | 'list'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(keys: readonly ICatalogItemKey[], change: ICatalogChange): ICatalogRevision[] {
    if (this.pending) {
      this.pending.push(...keys)
      return []
    }
    const at = this.now()
    const seen = new Set<string>()
    const written: ICatalogRevision[] = []
    for (const key of keys) {
      if (seen.has(keyText(key))) continue
      seen.add(keyText(key))
      const current = this.read(key)
      const last = this.repository.latest(key.kind, key.id)
      const base = { kind: key.kind, itemId: key.id, at, by: change.by, source: change.source ?? 'api', ...extras(change) }
      if (current) {
        if (last?.hash === current.hash) continue
        const op = change.op ?? (last?.document === undefined ? 'create' : 'update')
        written.push(this.repository.append({ ...base, ...scopeOf(current.projectId), op, document: current.text, hash: current.hash }))
      } else {
        if (last && last.document === undefined) continue
        // ⚖️ Apagar nunca é `restore`: o rollback que apaga grava `delete` (com `source` e nota dele).
        written.push(this.repository.append({ ...base, ...scopeOf(last ? last.projectId : key.projectId), op: 'delete' }))
      }
    }
    return written
  }

  /**
   * UMA ESCRITA COMPOSTA, UMA REVISÃO POR ITEM: o rollback grava o item por vários serviços (o agente, os recursos dele e
   * o contexto inicial), e cada um pediria a sua revisão. Aqui elas esperam o fim de `work` e saem juntas: o `target`
   * com a `change` inteira (`op`, nota, ampliações aceitas); os outros itens que mudaram junto (a cascata, a renumeração
   * das rules) com quem, por onde e o lote, e a operação da comparação de sempre.
   *
   * ⛔ SÍNCRONO, de propósito: as escritas do SQLite são síncronas, então nada de outra requisição entra no meio e é
   * gravado com a nota de outra pessoa. O que é assíncrono (as regras do momento) se resolve ANTES.
   */
  within<T>(target: ICatalogItemKey, change: ICatalogChange, work: () => T): { result: T; revisions: ICatalogRevision[] } {
    if (this.pending) throw new Error('catalog history: nested composite write')
    const pending: ICatalogItemKey[] = []
    this.pending = pending
    const others: ICatalogChange = { by: change.by, ...(change.source ? { source: change.source } : {}), ...(change.batchId ? { batchId: change.batchId } : {}) }
    let result: T
    try {
      result = work()
    } catch (error) {
      // Parou no meio: o que já foi gravado ganha a revisão de sempre (sem a nota do rollback, que não terminou).
      this.pending = undefined
      this.record(pending, others)
      throw error
    }
    this.pending = undefined
    const revisions = [
      ...this.record([target], change),
      ...this.record(
        pending.filter((key) => keyText(key) !== keyText(target)),
        others,
      ),
    ]
    return { result, revisions }
  }

  /**
   * A cascata, lida do documento canônico de quem cita:
   * - doc: os recursos e os docs que o anexam (`docIds`), e os agentes e os projetos que o têm no contexto inicial;
   * - skill e command: os agentes que o liberam por id;
   * - rule: as outras rules do escopo (a lista é renumerada).
   */
  withDependents(key: ICatalogItemKey): ICatalogItemKey[] {
    const item = this.read(key)
    if (!item) return [key]
    const scope: TCatalogScope = item.projectId ? { kind: 'project', projectId: item.projectId } : key.kind === 'rule' ? { kind: 'global' } : { kind: 'all' }
    const cites = (document: ICatalogDocument): boolean => {
      const body = document.body
      if (DOC_KINDS.includes(key.kind)) return includes(body.docIds, key.id) || includes(body.initialContext, key.id)
      if (RESOURCE_KINDS.includes(key.kind) && document.kind === 'agent') {
        const resources = body.resources as Record<string, TCanonicalValue> | undefined
        return includes(resources?.[key.kind === 'skill' ? 'skills' : 'commands'], key.id)
      }
      if (key.kind === 'rule') return document.kind === 'rule' && (document.projectId ?? '') === (item.projectId ?? '')
      return false
    }
    const dependents = this.reader
      .list(scope)
      .filter((document) => cites(document))
      .map(catalogItemKey)
    return [catalogItemKey(item), ...dependents.filter((dependent) => keyText(dependent) !== keyText(key))]
  }

  keysOf(scope: TCatalogScope): ICatalogItemKey[] {
    return this.reader.list(scope).map(catalogItemKey)
  }

  /**
   * A RECONCILIAÇÃO (boot): item sem revisão ganha a `baseline`; item diferente da última revisão — ou que sumiu, ou que
   * voltou — ganha uma revisão `drift`. Autor `system`. Cobre a semente, as migrações, a edição direta no banco e a falha
   * entre gravar o item e gravar a revisão.
   */
  reconcile(source: TRevisionSource = 'boot'): { baseline: number; drift: number } {
    const at = this.now()
    const latest = new Map(this.repository.latestAll().map((revision) => [keyText({ kind: revision.kind, id: revision.itemId }), revision]))
    const seen = new Set<string>()
    let baseline = 0
    let drift = 0
    for (const document of this.reader.list({ kind: 'all' })) {
      const key = catalogItemKey(document)
      seen.add(keyText(key))
      const last = latest.get(keyText(key))
      if (last?.hash === document.hash) continue
      const op: TRevisionOp = last ? 'drift' : 'baseline'
      this.repository.append({
        kind: key.kind,
        itemId: key.id,
        ...scopeOf(document.projectId),
        op,
        document: document.text,
        hash: document.hash,
        at,
        by: SYSTEM,
        source,
        ...(last ? { note: last.document === undefined ? 'reapareceu fora do histórico' : 'mudou fora do histórico' } : {}),
      })
      if (last) drift++
      else baseline++
    }
    for (const [text, last] of latest) {
      if (seen.has(text) || last.document === undefined) continue
      this.repository.append({ kind: last.kind, itemId: last.itemId, ...scopeOf(last.projectId), op: 'drift', at, by: SYSTEM, source, note: 'sumiu fora do histórico' })
      drift++
    }
    return { baseline, drift }
  }

  private read(key: ICatalogItemKey): ICatalogDocument | undefined {
    if (key.kind !== 'mcp') return this.reader.read(key.kind, key.id)
    const parsed = parseMcpServerKey(key.id)
    return parsed ? this.reader.read('mcp', parsed.id, parsed.projectId) : undefined
  }
}

/**
 * O GANCHO que cada serviço de escrita tem: o histórico chega pela fábrica (`use`), na hora da escrita — as fábricas
 * dependem umas das outras, e pedir o histórico ao nascer daria volta sem fim.
 *
 * ⛔ NUNCA DERRUBA A ESCRITA: a escrita já aconteceu; falhar aqui só deixa a revisão para a reconciliação do boot.
 */
export class CatalogHistoryHook {
  private history: () => ICatalogRecorder | undefined = () => undefined

  use(history: () => ICatalogRecorder | undefined): void {
    this.history = history
  }

  record(keys: readonly ICatalogItemKey[], change: ICatalogChange): void {
    try {
      this.history()?.record(keys, change)
    } catch (error) {
      console.warn('[histórico] não foi possível gravar a revisão (o boot a recupera como deriva):', error)
    }
  }

  withDependents(key: ICatalogItemKey): ICatalogItemKey[] {
    try {
      return this.history()?.withDependents(key) ?? [key]
    } catch (error) {
      console.warn('[histórico] não foi possível ler a cascata:', error)
      return [key]
    }
  }

  keysOf(scope: TCatalogScope): ICatalogItemKey[] {
    try {
      return this.history()?.keysOf(scope) ?? []
    } catch (error) {
      console.warn('[histórico] não foi possível listar o escopo:', error)
      return []
    }
  }
}

function includes(list: TCanonicalValue | undefined, id: string): boolean {
  return Array.isArray(list) && list.includes(id)
}

function scopeOf(projectId: string | undefined): { projectId?: string } {
  return projectId ? { projectId } : {}
}

function extras(change: ICatalogChange): { batchId?: string; note?: string; widenings?: string[] } {
  return {
    ...(change.batchId ? { batchId: change.batchId } : {}),
    ...(change.note ? { note: change.note } : {}),
    ...(change.widenings?.length ? { widenings: [...change.widenings] } : {}),
  }
}
