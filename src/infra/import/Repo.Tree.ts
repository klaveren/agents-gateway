import { createHash } from 'node:crypto'
import { Dirent, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { generatedSources } from '@domain/Import.Refs'
import { IInventoryLink } from '@domain/models/ImportInventory.Model'
import { IRepoEntry, IRepoFile, IRepoText, IRepoTree, TRepoRefusal } from '@domain/ports/FormatDetector.Port'
import { estimateTokens } from '@domain/Token.Estimate'
import { readRegular } from '@infra/workspace/File.Regular'
import { IGitPlace, safeGitSync } from '@infra/workspace/Git.Safe'

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
  /**
   * ⛔ O git da pasta (`head` e `dirty`), calculado pelo servidor (`resolveWorkFolder`). Sem ele não se roda git: a pasta
   * pode trazer um `.git` forjado pelo agente, e o git não o descobre sozinho (ver `Git.Safe`).
   */
  git?: IGitPlace
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const toPosix = (path: string) => path.split(sep).join('/')
const hasIgnoredSegment = (path: string) => path.split('/').some((segment) => IGNORED_DIRS.has(segment))

interface IRepoWalk {
  files: Map<string, { path: string; aliases: Set<string>; bytes: number }>
  ignored: Record<string, number>
  refused: IInventoryLink[]
}

/**
 * ⛔ A CAMINHADA contida: de `start` (já resolvida, dentro de `realRoot`) para baixo, com os caminhos relativos à raiz.
 * `exclude` tira a pasta (pelo caminho lógico) e o arquivo (pelo real e pelo lógico), sem contar.
 */
function walkRepo(realRoot: string, start: string, logical: string, exclude?: (path: string) => boolean): IRepoWalk {
  const files = new Map<string, { path: string; aliases: Set<string>; bytes: number }>()
  const ignored: Record<string, number> = {}
  const refused: IInventoryLink[] = []

  const skip = (name: string) => (ignored[name] = (ignored[name] ?? 0) + 1)

  const addFile = (logical: string, real: string) => {
    const path = toPosix(relative(realRoot, real))
    if (hasIgnoredSegment(path) || exclude?.(path)) return
    if (exclude?.(logical)) return
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
      if (exclude?.(path) && !child.isFile()) continue
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
  walk(start, logical, new Set([realRoot, start]), 0)
  return { files, ignored, refused }
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
  const { files, ignored, refused } = walkRepo(realRoot, realRoot, '')
  const cache = new Map<string, IRepoFile | undefined>()

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
      const buffer = readRegular(absolute, REPO_FILE_MAX_BYTES)
      if (!buffer) throw new Error('não é arquivo comum, ou passa do teto')
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

  const place = options.git?.gitCommonDir ? { ...options.git, dir: realRoot } : undefined
  const head = place ? safeGitSync(place, ['rev-parse', 'HEAD'])?.trim() || undefined : undefined
  const status = place ? safeGitSync(place, ['--no-optional-locks', 'status', '--porcelain']) : undefined

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
  try {
    const buffer = readRepoBytes(root, path)
    if (!buffer) return undefined
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    if (buffer.subarray(0, BINARY_SNIFF).includes(0)) return { sha256, text: '', binary: true }
    return { sha256, text: options.mask(buffer.toString('utf8')), binary: false }
  } catch {
    return undefined
  }
}

/**
 * ⛔ Os BYTES CRUS de um arquivo do repositório, com a mesma contenção do `readRepoFile` (os arquivos de recurso vão
 * byte a byte para o depósito; quem chama confere o `sha256` e o segredo).
 */
export function readRepoBytes(root: string, path: string): Buffer | undefined {
  const clean = path.replace(/^\.\//, '')
  if (!clean || isAbsolute(clean) || clean.split('/').includes('..') || hasIgnoredSegment(clean)) return undefined
  try {
    const realRoot = realpathSync(root)
    const absolute = realpathSync(join(realRoot, clean))
    if (!inside(realRoot, absolute) || hasIgnoredSegment(toPosix(relative(realRoot, absolute)))) return undefined
    return readRegular(absolute, REPO_FILE_MAX_BYTES)
  } catch {
    return undefined
  }
}

/**
 * ⛔ O arquivo que a análise e a importação leem inteiro para a memória. O repositório é de quem escreve nele (o agente
 * também): acima disto não é definição de agente nem arquivo de recurso (que tem teto de 1 MB), e fica como ilegível.
 * A leitura é sempre pelo `readRegular`: sem seguir link no último nome, com o tamanho conferido no descritor aberto.
 */
export const REPO_FILE_MAX_BYTES = 8 * 1024 * 1024

/** O arquivo de texto que a navegação do construtor lê (acima disto, recusa: mascarar e paginar não compensam). */
export const REPO_TEXT_MAX_BYTES = 2 * 1024 * 1024

/** O caminho pedido, limpo; `undefined` se sai da raiz pelo texto (`..`, absoluto). Vazio = a raiz. */
function cleanPath(path: string): string | undefined {
  const clean = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  if (isAbsolute(clean) || clean.startsWith('/') || /^[A-Za-z]:\//.test(clean) || clean.split('/').includes('..')) return undefined
  return clean === '.' ? '' : clean
}

/** O caminho resolvido (com `realpath`) e contido, ou o motivo da recusa. */
function containedPath(root: string, path: string, exclude: (path: string) => boolean): { realRoot: string; absolute: string; rel: string } | TRepoRefusal {
  const clean = cleanPath(path)
  if (clean === undefined) return 'outside'
  if (clean && (hasIgnoredSegment(clean) || exclude(clean))) return 'excluded'
  const realRoot = realpathSync(root)
  let absolute: string
  try {
    absolute = realpathSync(join(realRoot, clean))
  } catch {
    return 'not_found'
  }
  if (!inside(realRoot, absolute)) return 'outside'
  const rel = toPosix(relative(realRoot, absolute))
  if (rel && (hasIgnoredSegment(rel) || exclude(rel))) return 'excluded'
  return { realRoot, absolute, rel }
}

/**
 * ⛔ Os ARQUIVOS do repositório abaixo de `under` (a raiz por padrão), para o construtor conferir: a mesma contenção da
 * árvore (link para fora recusado, `IGNORED_DIRS` pulado) e sem o que `exclude` tira — pelo caminho real e por cada
 * alias. Não lê conteúdo nem roda git.
 */
export function listRepoFiles(root: string, under: string | undefined, exclude: (path: string) => boolean): IRepoEntry[] | TRepoRefusal {
  const found = containedPath(root, under ?? '', exclude)
  if (typeof found === 'string') return found
  if (!statSync(found.absolute).isDirectory()) return 'not_found'
  const { files } = walkRepo(found.realRoot, found.absolute, cleanPath(under ?? '') ?? '', exclude)
  return [...files.values()].map((entry) => ({ path: entry.path, aliases: [...entry.aliases].sort(), bytes: entry.bytes })).sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * ⛔ UM arquivo de TEXTO do repositório, para o construtor conferir: o caminho (relativo à raiz) é recusado se sai da
 * raiz pelo texto ou pelo `realpath` (link para fora), se passa por pasta ignorada ou se `exclude` o tira (o pedido E o
 * real: link para o `.env` também). Binário e arquivo grande demais são recusados. O texto sai MASCARADO.
 */
export function readRepoText(root: string, path: string, options: IRepoTreeOptions & { exclude: (path: string) => boolean }): IRepoText | TRepoRefusal {
  if (!cleanPath(path)) return cleanPath(path) === undefined ? 'outside' : 'not_found'
  const found = containedPath(root, path, options.exclude)
  if (typeof found === 'string') return found
  const stats = statSync(found.absolute)
  if (!stats.isFile()) return 'not_found'
  if (stats.size > REPO_TEXT_MAX_BYTES) return 'too_large'
  const buffer = readRegular(found.absolute, REPO_TEXT_MAX_BYTES)
  if (!buffer) return 'not_found'
  if (buffer.subarray(0, BINARY_SNIFF).includes(0)) return 'binary'
  return { path: found.rel, bytes: buffer.length, text: options.mask(buffer.toString('utf8')) }
}
