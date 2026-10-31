import type { TCatalogKind } from '@domain/Catalog.Document'

/**
 * O que a revisão registra:
 * - `baseline`: a primeira revisão de um item que já existia antes do histórico (o boot a cria);
 * - `create`/`update`/`delete`: as escritas pela aplicação;
 * - `drift`: o boot achou o item diferente da última revisão (semente, migração, edição direta no banco ou a janela
 *   entre gravar o item e gravar a revisão);
 * - `restore`: o rollback (restaurar uma revisão, reverter um lote) que deixa o item existindo; o que o apaga grava
 *   `delete` com `source = restore`;
 * - `import`: o import (PR seguinte).
 */
export type TRevisionOp = 'baseline' | 'create' | 'update' | 'delete' | 'restore' | 'import' | 'drift'

/**
 * Por onde a escrita veio: a API (a tela e os tokens), uma ferramenta de agente (`agent_trigger`), a migração de dados,
 * o boot (baseline e deriva), e o import e o rollback (PRs seguintes).
 */
export type TRevisionSource = 'api' | 'agent' | 'migration' | 'boot' | 'import' | 'restore'

/** Uma revisão de um item do catálogo: o documento canônico INTEIRO depois da operação (snapshot, não diff). */
export interface ICatalogRevision {
  id: number
  kind: TCatalogKind
  /** O id do item; no MCP, a CHAVE (`mcpServerKey`): o mesmo id pode existir em dois projetos. */
  itemId: string
  /** O escopo NA revisão (a rule pode mudar de escopo). Ausente = global. */
  projectId?: string
  /** 1..n por item. */
  revision: number
  op: TRevisionOp
  /** O texto canônico (`ICatalogDocument.text`); ausente quando o item deixou de existir. */
  document?: string
  /** sha256 do documento; ausente com ele. */
  hash?: string
  at: Date
  by: string
  source: TRevisionSource
  batchId?: string
  note?: string
  /** As chaves das ampliações de permissão que quem gravou ACEITOU nesta troca (o `confirm`; ver `Catalog.Widening`). */
  widenings?: string[]
}

export type TNewRevision = Omit<ICatalogRevision, 'id' | 'revision'>

/** A revisão sem o documento: a linha das listas (o documento vem na leitura de uma revisão). */
export type TRevisionSummary = Omit<ICatalogRevision, 'document'>

/**
 * O recorte de uma lista:
 * - `kind` + `itemId`: as revisões de um item;
 * - `projectId`: o escopo NA revisão (`''` = global); ausente = todos;
 * - `kinds`: só estes tipos (a visão do membro de projeto).
 */
export interface IRevisionFilter {
  kind?: TCatalogKind
  itemId?: string
  projectId?: string
  kinds?: readonly TCatalogKind[]
}

/** Uma página, da mais nova para a mais velha, e o total do recorte. */
export interface IRevisionPage {
  revisions: TRevisionSummary[]
  total: number
}

/** O histórico do catálogo: uma tabela só, para todos os tipos. ⚖️ SÓ ACRESCENTA: revisão nunca é apagada nem editada. */
export interface ICatalogHistoryRepository {
  /** A última revisão do item. */
  latest(kind: TCatalogKind, itemId: string): ICatalogRevision | undefined
  /** A última revisão de cada item (a reconciliação do boot). */
  latestAll(): ICatalogRevision[]
  /** As revisões do item, da primeira à última. */
  revisions(kind: TCatalogKind, itemId: string): ICatalogRevision[]
  /** A revisão `revision` do item. */
  revision(kind: TCatalogKind, itemId: string, revision: number): ICatalogRevision | undefined
  /** Uma página do recorte, da mais nova para a mais velha, sem o documento. */
  page(filter: IRevisionFilter, paging: { offset: number; limit: number }): IRevisionPage
  /** Grava a próxima revisão do item (`revision` = última + 1). */
  append(revision: TNewRevision): ICatalogRevision
}

/** O que o lote foi: um import (PR 9) ou a reversão de um lote. */
export type TBatchKind = 'import' | 'revert'

/**
 * - `partial`: começou e não terminou (parou num erro, pulou conflito, ou o processo caiu no meio — é o estado gravado
 *   ao abrir o lote);
 * - `applied`: tudo aplicado;
 * - `reverted`: um lote de reversão posterior o desfez por inteiro.
 */
export type TBatchStatus = 'applied' | 'partial' | 'reverted'

/** Uma ampliação aceita no lote, item a item (a chave estável e o texto que a pessoa viu). */
export interface IBatchWidening {
  kind: TCatalogKind
  itemId: string
  key: string
  description: string
}

/** Um lote: várias escritas de catálogo que andam juntas (as revisões dele levam o `batchId`). */
export interface ICatalogBatch {
  id: string
  at: Date
  by: string
  kind: TBatchKind
  /** `all`, `global` ou `project:<id>`. */
  scope: string
  /** O plano aplicado (o que entrou, o que pulou e por quê, o erro): JSON livre de quem grava. */
  summary: Record<string, unknown>
  /** As ampliações aceitas, item a item. */
  widenings: IBatchWidening[]
  status: TBatchStatus
}

/** Um lote na lista: com quantos itens ele tocou (as revisões com o `batchId`, um por item). */
export type TBatchListItem = ICatalogBatch & { items: number }

/**
 * O recorte da lista de lotes:
 * - `projectId`: o lote do escopo `project:<id>` OU que gravou alguma revisão no projeto (`''` = o global);
 * - `kind`: só os imports, ou só as reversões.
 */
export interface IBatchFilter {
  projectId?: string
  kind?: TBatchKind
}

/** ⚖️ Lote também só acrescenta: muda o `status` e o `summary` ao fechar; nunca se apaga. */
export interface ICatalogBatchRepository {
  createBatch(batch: ICatalogBatch): ICatalogBatch
  batch(id: string): ICatalogBatch | undefined
  /** Fecha o lote: o estado final e o resumo. */
  finishBatch(id: string, change: { status: TBatchStatus; summary: Record<string, unknown> }): void
  /** Marca o lote como desfeito (a reversão dele terminou inteira). */
  markReverted(id: string): void
  /** As revisões gravadas com este `batchId`, na ordem em que foram gravadas. */
  batchRevisions(batchId: string): ICatalogRevision[]
  /** Uma página dos lotes do recorte, do mais novo para o mais velho, e o total. */
  batches(filter: IBatchFilter, paging: { offset: number; limit: number }): { batches: TBatchListItem[]; total: number }
}
