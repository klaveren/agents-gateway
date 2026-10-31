import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { generatedSources } from '@domain/Import.Refs'
import { IInventoryLink } from '@domain/models/ImportInventory.Model'
import { IRepoEntry, IRepoFile, IRepoTree } from '@domain/ports/FormatDetector.Port'
import { estimateTokens } from '@domain/Token.Estimate'

/** Pastas de dependência, de build e de cache: nunca são recurso agêntico, e pesam. O relatório conta quantas pulou. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.pnpm-store',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.terraform',
])

const BINARY_SNIFF = 8 * 1024
const MAX_DEPTH = 40

export interface IRepoTreeOptions {
  /** A máscara de segredos do gateway (`SecretMasker.text`). */
  mask: (text: string) => string
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const toPosix = (path: string) => path.split(sep).join('/')
const hasIgnoredSegment = (path: string) => path.split('/').some((segment) => IGNORED_DIRS.has(segment))

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/**
 * ⛔ O LEITOR DO REPOSITÓRIO, com contenção: parte da pasta já resolvida (`resolveWorkFolder`, com `realpath`) e nunca
 * sai dela.
 *
 * - Link: seguido só se o destino (depois do `realpath`) fica dentro da raiz. Para fora, quebrado ou em ciclo, é
 *   recusado e listado — sem o destino, que é caminho do servidor.
 * - Arquivo alcançado por dois caminhos aparece UMA vez, pelo caminho real, com os outros em `aliases`.
 * - Pastas de `IGNORED_DIRS` são puladas e contadas; binário (byte nulo nos primeiros 8 KB) é marcado na leitura.
 * - O conteúdo é lido sob demanda, e sai MASCARADO: o texto cru não deixa este arquivo.
 *
 * Só lê: `git status` roda com `--no-optional-locks`, para não mexer nem no índice.
 */
export function readRepoTree(root: string, options: IRepoTreeOptions): IRepoTree {
  const realRoot = realpathSync(root)
  const files = new Map<string, { path: string; aliases: Set<string>; bytes: number }>()
  const ignored: Record<string, number> = {}
  const refused: IInventoryLink[] = []
  const cache = new Map<string, IRepoFile | undefined>()

  const skip = (name: string) => (ignored[name] = (ignored[name] ?? 0) + 1)

  const addFile = (logical: string, real: string) => {
    const path = toPosix(relative(realRoot, real))
    if (hasIgnoredSegment(path)) return
    let entry = files.get(path)
    if (!entry) {
      entry = { path, aliases: new Set(), bytes: statSync(real).size }
      files.set(path, entry)
    }
    if (logical !== path) entry.aliases.add(logical)
  }

  const walk = (dir: string, logical: string, ancestors: ReadonlySet<string>, depth: number) => {
    if (depth > MAX_DEPTH) return
    let children: Dirent[]
    try {
      children = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const abs = join(dir, child.name)
      const path = logical ? `${logical}/${child.name}` : child.name
      if (child.isSymbolicLink()) {
        let target: string
        try {
          target = realpathSync(abs)
        } catch {
          refused.push({ path, reason: 'broken' })
          continue
        }
        if (!inside(realRoot, target)) {
          refused.push({ path, reason: 'outside' })
          continue
        }
        const stats = statSync(target)
        if (stats.isDirectory()) {
          if (IGNORED_DIRS.has(child.name) || hasIgnoredSegment(toPosix(relative(realRoot, target)))) {
            skip(child.name)
            continue
          }
          if (ancestors.has(target)) {
            refused.push({ path, reason: 'cycle' })
            continue
          }
          walk(abs, path, new Set([...ancestors, target]), depth + 1)
        } else if (stats.isFile()) addFile(path, target)
        continue
      }
      if (child.isDirectory()) {
        if (IGNORED_DIRS.has(child.name)) {
          skip(child.name)
          continue
        }
        const real = realpathSync(abs)
        if (ancestors.has(real)) continue
        walk(abs, path, new Set([...ancestors, real]), depth + 1)
        continue
      }
      if (child.isFile()) addFile(path, realpathSync(abs))
    }
  }
  walk(realRoot, '', new Set([realRoot]), 0)

  const byAlias = new Map<string, string>()
  for (const entry of files.values()) for (const alias of entry.aliases) byAlias.set(alias, entry.path)
  const entries: IRepoEntry[] = [...files.values()].map((entry) => ({ path: entry.path, aliases: [...entry.aliases].sort(), bytes: entry.bytes }))

  const resolvePath = (path: string) => {
    const clean = path.replace(/^\.\//, '')
    if (files.has(clean)) return clean
    return byAlias.get(clean)
  }

  const read = (path: string): IRepoFile | undefined => {
    const real = resolvePath(path)
    if (!real) return undefined
    if (cache.has(real)) return cache.get(real)
    let file: IRepoFile | undefined
    try {
      // ⛔ De novo na leitura: o arquivo pode ter virado link para fora depois da varredura.
      const absolute = realpathSync(join(realRoot, real))
      if (!inside(realRoot, absolute)) throw new Error('fora do repositório')
      const buffer = readFileSync(absolute)
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      const base = { path: real, aliases: [...files.get(real)!.aliases].sort(), bytes: buffer.length, sha256 }
      if (buffer.subarray(0, BINARY_SNIFF).includes(0)) file = { ...base, tokens: 0, binary: true, text: '', secret: false }
      else {
        const raw = buffer.toString('utf8')
        const text = options.mask(raw)
        const generated = generatedSources(text)
        file = { ...base, tokens: estimateTokens(raw), binary: false, text, secret: text !== raw, ...(generated ? { generated } : {}) }
      }
    } catch {
      file = undefined
    }
    cache.set(real, file)
    return file
  }

  const isGit = existsSync(join(realRoot, '.git'))
  const head = isGit ? git(realRoot, ['rev-parse', 'HEAD'])?.trim() || undefined : undefined
  const status = isGit ? git(realRoot, ['--no-optional-locks', 'status', '--porcelain']) : undefined

  return {
    ...(head ? { head } : {}),
    ...(status !== undefined ? { dirty: status.trim().length > 0 } : {}),
    entries: () => entries,
    resolve: resolvePath,
    read,
    ignoredDirs: () => ({ ...ignored }),
    refusedLinks: () => [...refused],
  }
}

/** Um arquivo lido sozinho (`readRepoFile`): o `sha256` do conteúdo cru e o texto mascarado. */
export interface IRepoFileRead {
  sha256: string
  text: string
  binary: boolean
}

/**
 * ⛔ UM arquivo do repositório, com a MESMA contenção da árvore, sem varrer o resto: o caminho (relativo à raiz) é
 * resolvido com `realpath` e recusado se sai da raiz ou passa por pasta ignorada. O texto sai MASCARADO; o `sha256` é o
 * do conteúdo cru (o mesmo do inventário), para conferir se a fonte mudou.
 */
export function readRepoFile(root: string, path: string, options: IRepoTreeOptions): IRepoFileRead | undefined {
  const clean = path.replace(/^\.\//, '')
  if (!clean || isAbsolute(clean) || clean.split('/').includes('..') || hasIgnoredSegment(clean)) return undefined
  try {
    const realRoot = realpathSync(root)
    const absolute = realpathSync(join(realRoot, clean))
    if (!inside(realRoot, absolute) || hasIgnoredSegment(toPosix(relative(realRoot, absolute))) || !statSync(absolute).isFile()) return undefined
    const buffer = readFileSync(absolute)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    if (buffer.subarray(0, BINARY_SNIFF).includes(0)) return { sha256, text: '', binary: true }
    return { sha256, text: options.mask(buffer.toString('utf8')), binary: false }
  } catch {
    return undefined
  }
}
