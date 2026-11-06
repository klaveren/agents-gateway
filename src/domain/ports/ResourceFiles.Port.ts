import { IResourceFile, TFileOwnerKind } from '@domain/models/ResourceFile.Model'

/**
 * O DEPÓSITO e as PASTAS dos arquivos de recurso (ver `ResourceFile.Model`): o conteúdo por sha256, que não perde
 * versão, e a pasta de cada recurso, escrita a partir da lista do catálogo.
 */
export interface IResourceFilesPort {
  /** O conteúdo já está no depósito? */
  has(sha256: string): boolean
  /** Guarda o conteúdo (o mesmo conteúdo, uma vez só). */
  put(content: Buffer): { sha256: string; bytes: number }
  read(sha256: string): Buffer | undefined
  /** A pasta do recurso (sem criá-la): a que o agente lê. */
  dirOf(kind: TFileOwnerKind, id: string, projectId?: string): string
  /** Escreve a pasta a partir da lista, trocando-a inteira; lista vazia apaga a pasta. */
  sync(kind: TFileOwnerKind, id: string, projectId: string | undefined, files: readonly IResourceFile[]): void
  remove(kind: TFileOwnerKind, id: string, projectId?: string): void
  /**
   * ⚖️ A PASTA DO AGENTE é dele (lê e grava pelo terminal e pelas ferramentas de arquivo): o gateway nunca a troca inteira.
   * Grava os arquivos da lista que mudaram no disco e apaga só os `removed`; o resto, o que o agente gravou, fica.
   */
  writeAgent(id: string, projectId: string | undefined, files: readonly IResourceFile[], removed: readonly string[]): void
  /** No boot: repõe só o arquivo da lista que sumiu do disco. Nunca apaga nem sobrescreve. */
  restoreAgent(id: string, projectId: string | undefined, files: readonly IResourceFile[]): void
  /** O agente mudou de projeto: a pasta vai junto, com tudo o que ele gravou. */
  moveAgent(id: string, from: string | undefined, to: string | undefined): void
  /** A pasta do agente como está no disco (o que a tela mostra), com o conteúdo posto no depósito. Cria a pasta vazia. */
  snapshotAgent(id: string, projectId: string | undefined): IResourceFile[]
}
