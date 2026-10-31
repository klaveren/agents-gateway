import { IImportBatch, IImportJobItem, IImportJobSummary, INewImportJob, TImportItemPatch } from '@domain/models/ImportJob.Model'
import { IImportScan } from '@domain/models/ImportInventory.Model'

/** O cabeçalho guardado de um trabalho, com o inventário sem os itens. */
export interface IImportJobRecord extends Omit<IImportJobSummary, 'items' | 'byState' | 'latest'> {
  inventory: Omit<IImportScan, 'items'>
}

/**
 * Os trabalhos de importação (`import_scans`) e os itens deles (`import_items`). ⛔ Nada daqui toca o catálogo.
 * Um trabalho só existe dentro do seu projeto: toda leitura pede o projeto.
 */
export interface IImportRepository {
  /** Grava o trabalho e todos os itens, de uma vez (ou nada). */
  create(job: INewImportJob): void
  /** Os trabalhos do projeto, do mais novo ao mais velho. */
  list(projectId: string): IImportJobSummary[]
  get(projectId: string, jobId: string): IImportJobRecord | undefined
  /** O trabalho mais novo do repositório (o que a reanálise reaproveita, e o único que muda). */
  latest(projectId: string, repository: string): IImportJobRecord | undefined
  /** Os itens do trabalho, na ordem da chave. */
  items(jobId: string): IImportJobItem[]
  item(jobId: string, key: string): IImportJobItem | undefined
  /** Muda o estado, a reclassificação e o autor do item; devolve como ficou. */
  updateItem(jobId: string, key: string, patch: TImportItemPatch): IImportJobItem | undefined
  /** Guarda um lote do trabalho (a seleção, com nome, ordem, autor e hora). */
  createBatch(batch: IImportBatch): void
  /** Os lotes do trabalho, do mais novo ao mais velho. */
  batches(jobId: string): IImportBatch[]
  batch(jobId: string, batchId: string): IImportBatch | undefined
  /** Apagar o projeto apaga os trabalhos dele (e os lotes). */
  deleteProject(projectId: string): void
}
