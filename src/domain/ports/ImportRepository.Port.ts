import { IImportAnalysis, IImportBatch, IImportJobItem, IImportJobSummary, IImportReanalysis, INewImportJob, TImportItemPatch } from '@domain/models/ImportJob.Model'
import { IImportScan } from '@domain/models/ImportInventory.Model'

/** O cabeçalho guardado de um trabalho, com o inventário sem os itens. */
export interface IImportJobRecord extends Omit<IImportJobSummary, 'items' | 'byState' | 'latest' | 'gone' | 'analyses'> {
  inventory: Omit<IImportScan, 'items'>
}

/** O que a consolidação de boot fez (ver `SqliteImportRepository.consolidate`). */
export interface IImportConsolidation {
  /** As importações que ficaram (uma por repositório) e as análises antigas arquivadas em cada uma. */
  kept: Array<{ jobId: string; archived: string[]; batches: number; items: number }>
}

/**
 * As importações (`import_scans`, UMA ativa por projeto + repositório), os itens delas (`import_items`), os lotes
 * (`import_batches`) e o registro de cada análise (`import_analyses`). ⛔ Nada daqui toca o catálogo.
 * Uma importação só existe dentro do seu projeto: toda leitura pede o projeto. A análise antiga ARQUIVADA (da
 * consolidação) não aparece em leitura nenhuma.
 */
export interface IImportRepository {
  /** Grava a importação nova e todos os itens, de uma vez (ou nada). */
  create(job: INewImportJob): void
  /** Grava a REANÁLISE na mesma importação, de uma vez (ou nada). */
  reanalyze(update: IImportReanalysis): void
  /** As importações do projeto (uma por repositório), da analisada por último à mais antiga. */
  list(projectId: string): IImportJobSummary[]
  get(projectId: string, jobId: string): IImportJobRecord | undefined
  /** A importação do repositório (a que a reanálise atualiza). */
  latest(projectId: string, repository: string): IImportJobRecord | undefined
  /** As últimas análises da importação, da mais nova à mais velha. */
  analyses(jobId: string, limit?: number): IImportAnalysis[]
  /** Os itens do trabalho, na ordem da chave (os que saíram da fonte inclusos, com `goneAt`). */
  items(jobId: string): IImportJobItem[]
  item(jobId: string, key: string): IImportJobItem | undefined
  /** Muda o estado, a reclassificação e o autor do item; devolve como ficou. */
  updateItem(jobId: string, key: string, patch: TImportItemPatch): IImportJobItem | undefined
  /** Os itens ligados a uma conversa do construtor, na importação em que ela aparece. */
  byConversation(conversationId: string): { job: IImportJobRecord; items: IImportJobItem[] } | undefined
  /** Guarda um lote do trabalho (a seleção, com nome, ordem, autor e hora). */
  createBatch(batch: IImportBatch): void
  /** Os lotes do trabalho, do mais novo ao mais velho. */
  batches(jobId: string): IImportBatch[]
  batch(jobId: string, batchId: string): IImportBatch | undefined
  /** Troca os itens e a ordem de um lote salvo (acrescentar itens). */
  updateBatchItems(jobId: string, batchId: string, keys: readonly string[], order: readonly string[]): void
  /** Apagar o projeto apaga os trabalhos dele (e os lotes). */
  deleteProject(projectId: string): void
}
