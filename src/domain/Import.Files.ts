import { posix } from 'node:path'
import { IInventoryItem } from './models/ImportInventory.Model'
import { filePathIssue } from './models/ResourceFile.Model'

/**
 * Os ARQUIVOS que a importação leva para a pasta do recurso (ver `ResourceFile.Model`): o que o repositório tem ao lado
 * da instrução e o agente roda — scripts, modelos, dados. ⚖️ A instrução continua sendo o rascunho (o texto do
 * catálogo); estes vão como arquivo, byte a byte.
 * - SKILL: os anexos da pasta dela (`skills/<id>/…`) que não são markdown — o markdown é texto que o construtor lê e
 *   pode compor na instrução;
 * - AGENTE: a pasta `scripts/` dele (o varredor a deixa como "fora do catálogo"), inteira.
 * O caminho na pasta do recurso é o relativo à pasta de origem (`scripts/bank-efi/balance.mjs`).
 */
export interface IImportFile {
  /** No repositório. */
  source: string
  /** Na pasta do recurso. */
  path: string
  sha256: string
  bytes: number
}

export function importFilesOf(item: IInventoryItem, kind: string, items: readonly IInventoryItem[]): { files: IImportFile[]; skipped: Array<{ path: string; reason: string }> } {
  const skipped: Array<{ path: string; reason: string }> = []
  const pick = (dir: string, sources: IInventoryItem['sources']): IImportFile[] =>
    sources.flatMap((source) => {
      const path = posix.relative(dir, source.path)
      const issue = filePathIssue(path)
      if (issue) {
        skipped.push({ path: source.path, reason: `caminho que a pasta do recurso não aceita (${issue})` })
        return []
      }
      return [{ source: source.path, path, sha256: source.sha256, bytes: source.bytes }]
    })
  if (kind === 'skill') {
    const main = item.sources.find((source) => source.role === 'skill')
    if (!main) return { files: [], skipped }
    const dir = posix.dirname(main.path)
    return {
      files: pick(
        dir,
        item.sources.filter((source) => isFileSource(kind, source) && source.path.startsWith(`${dir}/`)),
      ),
      skipped,
    }
  }
  if (kind === 'agent') {
    const main = item.sources.find((source) => source.role === 'prompt') ?? item.sources[0]
    if (!main) return { files: [], skipped }
    const dir = posix.dirname(main.path)
    const scripts = items.filter((other) => other.kind === 'skip').flatMap((other) => other.sources.filter((source) => source.path.startsWith(`${dir}/scripts/`)))
    return { files: pick(dir, scripts), skipped }
  }
  return { files: [], skipped }
}

/** A fonte vai como ARQUIVO (o anexo da skill que não é markdown), e não como texto do rascunho? */
export function isFileSource(kind: string, source: Pick<IInventoryItem['sources'][number], 'role' | 'path'>): boolean {
  return kind === 'skill' && source.role === 'attachment' && !/\.md$/i.test(source.path)
}

/** As fontes de TEXTO do item (as que o rascunho cobre): sem as que vão como arquivo. */
export function textSources<T extends Pick<IInventoryItem['sources'][number], 'role' | 'path'>>(kind: string, sources: readonly T[]): T[] {
  return sources.filter((source) => !isFileSource(kind, source))
}
