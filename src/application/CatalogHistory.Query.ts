import { ICatalogDocument, TCatalogKind } from '@domain/Catalog.Document'
import { parseMcpServerKey } from '@domain/models/McpServer.Model'
import { ICatalogHistoryRepository, ICatalogRevision, IRevisionPage, TRevisionOp } from '@domain/ports/CatalogHistoryRepository.Port'
import { diffText, IDiffHunk } from '@domain/Text.Diff'
import { CatalogReader } from './Catalog.Reader'

/** Um item no histórico: `itemId` é o `item_id` gravado — no MCP, a CHAVE (`mcpServerKey`, `<projeto>.<id>`). */
export interface IHistoryItem {
  kind: TCatalogKind
  itemId: string
}

/** O escopo de uma lista: tudo, só o global (`project_id = ''`) ou um projeto. */
export type THistoryScope = { kind: 'all' } | { kind: 'global' } | { kind: 'project'; projectId: string }

export interface IHistoryPaging {
  /** 1..n. */
  page: number
  pageSize: number
}

export interface IHistoryPage extends IRevisionPage {
  page: number
  pageSize: number
}

/** O estado atual do item ao lado da lista: se existe e o `hash` — diferente do da última revisão = deriva ainda não gravada. */
export interface ICurrentState {
  exists: boolean
  hash?: string
}

/** Um lado do diff: uma revisão (`0` = antes de existir) ou o estado atual. */
export type TRevisionRef = number | 'current'

export interface IDiffSide {
  revision: TRevisionRef
  /** O item existia naquele ponto (revisão de `delete`, a `0` e o atual apagado não existem). */
  exists: boolean
  hash?: string
  op?: TRevisionOp
  at?: Date
  by?: string
}

export interface IRevisionDiff {
  kind: TCatalogKind
  itemId: string
  from: IDiffSide
  to: IDiffSide
  equal: boolean
  added: number
  removed: number
  hunks: IDiffHunk[]
  unified: string
}

/**
 * A LEITURA DO HISTÓRICO DO CATÁLOGO: as revisões de um item, as de um escopo, uma revisão inteira e o diff entre duas
 * delas (ou entre uma e o estado atual). Ver docs/integration/plano-catalogo-historico.md §3, PR 3.
 *
 * ⛔ SÓ LEITURA, e SEM REGRA DE ACESSO: quem pode ver o quê é decisão da entrega (o controller), que restringe pelo
 * `kinds` e pelo escopo. O diff é sobre o `text` canônico, que não leva segredo por construção (`Catalog.Document`).
 */
export class CatalogHistoryQuery {
  constructor(
    private readonly repository: Pick<ICatalogHistoryRepository, 'latest' | 'revision' | 'page'>,
    private readonly reader: Pick<CatalogReader, 'read'>,
  ) {}

  /** As revisões do item, da mais nova para a mais velha, sem o documento. */
  itemRevisions(item: IHistoryItem, paging: IHistoryPaging, restrict: { projectId?: string } = {}): IHistoryPage {
    return this.page({ kind: item.kind, itemId: item.itemId, ...restrict }, paging)
  }

  /** As revisões do escopo (de todos os itens), da mais nova para a mais velha. `kinds` limita os tipos. */
  scopeRevisions(scope: THistoryScope, paging: IHistoryPaging, kinds?: readonly TCatalogKind[]): IHistoryPage {
    const projectId = scope.kind === 'global' ? '' : scope.kind === 'project' ? scope.projectId : undefined
    return this.page({ ...(projectId !== undefined ? { projectId } : {}), ...(kinds ? { kinds } : {}) }, paging)
  }

  /** A revisão `revision` do item, com o documento. */
  revision(item: IHistoryItem, revision: number): ICatalogRevision | undefined {
    return this.repository.revision(item.kind, item.itemId, revision)
  }

  /** O item é conhecido: tem revisão ou existe agora. */
  known(item: IHistoryItem): boolean {
    return !!this.repository.latest(item.kind, item.itemId) || !!this.current(item)
  }

  currentState(item: IHistoryItem): ICurrentState {
    const current = this.current(item)
    return current ? { exists: true, hash: current.hash } : { exists: false }
  }

  /**
   * O diff de `from` para `to`. Padrões: `to` = o atual; `from` = a última revisão (com `to` atual) ou a anterior a `to`
   * (o que a revisão `to` mudou). `undefined` = uma das revisões não existe.
   */
  diff(item: IHistoryItem, options: { from?: TRevisionRef; to?: TRevisionRef; context?: number } = {}): IRevisionDiff | undefined {
    const to = options.to ?? 'current'
    const from = options.from ?? (to === 'current' ? (this.repository.latest(item.kind, item.itemId)?.revision ?? 0) : Math.max(0, to - 1))
    const before = this.side(item, from)
    const after = this.side(item, to)
    if (!before || !after) return undefined
    const label = (ref: TRevisionRef) => `${item.kind}/${item.itemId}@${ref}`
    const diff = diffText(before.text, after.text, { context: options.context, fromLabel: label(from), toLabel: label(to) })
    return { kind: item.kind, itemId: item.itemId, from: before.side, to: after.side, ...diff }
  }

  private page(filter: Parameters<ICatalogHistoryRepository['page']>[0], paging: IHistoryPaging): IHistoryPage {
    const result = this.repository.page(filter, { offset: (paging.page - 1) * paging.pageSize, limit: paging.pageSize })
    return { ...result, page: paging.page, pageSize: paging.pageSize }
  }

  /** O texto e a descrição de um lado; `undefined` = a revisão não existe. */
  private side(item: IHistoryItem, ref: TRevisionRef): { text: string; side: IDiffSide } | undefined {
    if (ref === 'current') {
      const current = this.current(item)
      return { text: current?.text ?? '', side: { revision: 'current', exists: !!current, ...(current ? { hash: current.hash } : {}) } }
    }
    if (ref === 0) return { text: '', side: { revision: 0, exists: false } }
    const revision = this.repository.revision(item.kind, item.itemId, ref)
    if (!revision) return undefined
    return {
      text: revision.document ?? '',
      side: {
        revision: ref,
        exists: revision.document !== undefined,
        ...(revision.hash ? { hash: revision.hash } : {}),
        op: revision.op,
        at: revision.at,
        by: revision.by,
      },
    }
  }

  /** O documento atual (o MCP vai pela chave; a chave inválida não existe). */
  private current(item: IHistoryItem): ICatalogDocument | undefined {
    if (item.kind !== 'mcp') return this.reader.read(item.kind, item.itemId)
    const parsed = parseMcpServerKey(item.itemId)
    return parsed ? this.reader.read('mcp', parsed.id, parsed.projectId) : undefined
  }
}
