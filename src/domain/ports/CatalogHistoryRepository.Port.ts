import type { TCatalogKind } from '@domain/Catalog.Document'

/**
 * O que a revisão registra:
 * - `baseline`: a primeira revisão de um item que já existia antes do histórico (o boot a cria);
 * - `create`/`update`/`delete`: as escritas pela aplicação;
 * - `drift`: o boot achou o item diferente da última revisão (semente, migração, edição direta no banco ou a janela
 *   entre gravar o item e gravar a revisão);
 * - `restore`/`import`: o rollback e o import (PRs seguintes).
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
}

export type TNewRevision = Omit<ICatalogRevision, 'id' | 'revision'>

/** O histórico do catálogo: uma tabela só, para todos os tipos. ⚖️ SÓ ACRESCENTA: revisão nunca é apagada nem editada. */
export interface ICatalogHistoryRepository {
  /** A última revisão do item. */
  latest(kind: TCatalogKind, itemId: string): ICatalogRevision | undefined
  /** A última revisão de cada item (a reconciliação do boot). */
  latestAll(): ICatalogRevision[]
  /** As revisões do item, da primeira à última. */
  revisions(kind: TCatalogKind, itemId: string): ICatalogRevision[]
  /** Grava a próxima revisão do item (`revision` = última + 1). */
  append(revision: TNewRevision): ICatalogRevision
}
