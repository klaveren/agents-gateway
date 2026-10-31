import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ICatalogManifest, MANIFEST_PATH, TCatalogFiles } from '@domain/Catalog.Files'

/**
 * O PACOTE EM PASTA (a CLI, e depois o backup do PR 11): escreve os arquivos do pacote em `dir` e apaga o que o export
 * ANTERIOR tinha escrito ali e que não veio agora (pelo `catalog.json` antigo) — o diff no git mostra a remoção.
 *
 * ⛔ Só toca no que é do pacote: nunca apaga arquivo que o manifesto anterior não listava (`.git`, um README), e
 * caminho que sairia de `dir` é recusado antes de escrever qualquer coisa.
 */
export function writeCatalogDirectory(dir: string, files: TCatalogFiles): { written: number; removed: string[] } {
  const root = resolve(dir)
  const target = (path: string) => {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (!path || isAbsolute(path) || !rel || rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error(`catalog: caminho fora da pasta: ${path}`)
    return full
  }
  const paths = Object.keys(files)
  paths.forEach(target)

  const previous = previousFiles(root)
  mkdirSync(root, { recursive: true })
  const removed: string[] = []
  for (const path of previous) {
    if (path in files) continue
    let full: string
    try {
      full = target(path)
    } catch {
      continue
    }
    if (!existsSync(full)) continue
    rmSync(full)
    removed.push(path)
    pruneEmpty(root, dirname(full))
  }
  for (const path of paths) {
    const full = target(path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, files[path], 'utf8')
  }
  return { written: paths.length, removed: removed.sort() }
}

/** Os arquivos do export anterior, pelo manifesto dele; sem manifesto (ou ilegível), nenhum. */
function previousFiles(root: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')) as Partial<ICatalogManifest>
    return manifest.files && typeof manifest.files === 'object' ? Object.keys(manifest.files) : []
  } catch {
    return []
  }
}

/** Sobe apagando a pasta que ficou vazia, até `root` (exclusive). */
function pruneEmpty(root: string, dir: string): void {
  for (let current = dir; current !== root && current.startsWith(root + sep); current = dirname(current)) {
    if (readdirSync(current).length) return
    rmdirSync(current)
  }
}

/** O que a leitura da pasta pula: o repositório git que guarda o catálogo. */
const SKIPPED_DIRS = new Set(['.git'])

/**
 * A PASTA EM PACOTE (a CLI `plan`/`apply`): cada arquivo dela, pelo caminho relativo com `/`, em UTF-8. ⛔ Link
 * simbólico não é seguido (o pacote é só o que está na pasta), e `.git` fica de fora.
 */
export function readCatalogDirectory(dir: string): TCatalogFiles {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`catalog: não é uma pasta: ${dir}`)
  const files: Record<string, string> = {}
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile()) files[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8')
    }
  }
  walk(root)
  return files
}
