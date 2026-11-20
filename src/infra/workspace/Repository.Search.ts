import { readFileSync, writeFileSync } from 'node:fs'
import { isSecretPath } from '@domain/Permission.Policy'
import { safeGit } from './Git.Safe'
import { IFileAccess, MAX_EDITOR_BYTES, RepositoryFileError, safeRepositoryPath } from './Repository.Files'
import { IWorkFolder } from './Work.Folder'

/**
 * 🔍 BUSCAR (e substituir) NOS ARQUIVOS do repositório da conversa, como o "Search" do VS Code: pelo `git grep` endurecido
 * (versionados e novos, pelo `.gitignore`), com maiúsculas, palavra inteira e regex; incluir/excluir por glob.
 * ⛔ Segredo e `.git` nunca entram (nem no resultado, nem na troca).
 */
export interface ISearchQuery {
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** Globs separados por vírgula (`src, *.ts`). */
  include?: string
  exclude?: string
}

export interface ISearchMatch {
  line: number
  column: number
  text: string
}

export interface ISearchResult {
  files: Array<{ path: string; matches: ISearchMatch[] }>
  total: number
  truncated: boolean
}

const MAX_MATCHES = 2000
const MAX_PER_FILE = 200
const MAX_LINE = 400

/** Os globs da pessoa em pathspec do git: `src` vale a pasta; sem `/`, vale em qualquer pasta. */
export function pathspecs(globs: string | undefined, exclude: boolean): string[] {
  const magic = exclude ? ':(exclude,glob)' : ':(glob)'
  return (globs ?? '')
    .split(',')
    .map((glob) => glob.trim().replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((glob) => glob && !glob.split('/').includes('..'))
    .flatMap((glob) => {
      const anywhere = glob.startsWith('**/') || glob.startsWith('/') ? [] : [`${magic}**/${glob}`, `${magic}**/${glob}/**`]
      return [`${magic}${glob.replace(/^\//, '')}`, `${magic}${glob.replace(/^\//, '')}/**`, ...anywhere]
    })
}

/** A expressão em JavaScript (para a troca e para marcar o trecho): a mesma regra da busca. */
export function searchRegExp(query: ISearchQuery): RegExp {
  const source = query.regex ? query.query : query.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, `g${query.caseSensitive ? '' : 'i'}`)
}

async function grep(folder: IWorkFolder, query: ISearchQuery, engine: '-P' | '-E' | '-F'): Promise<string> {
  const args = ['grep', '-z', '-n', '--column', '-I', '--untracked', '--no-color', `--max-count=${MAX_PER_FILE}`]
  if (!query.caseSensitive) args.push('-i')
  if (query.wholeWord) args.push('-w')
  args.push(engine, '-e', query.query, '--', ...(pathspecs(query.include, false).length ? pathspecs(query.include, false) : ['.']), ...pathspecs(query.exclude, true))
  try {
    return await safeGit(folder, args, { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 })
  } catch (error: unknown) {
    // `git grep` sai com 1 quando não acha nada.
    if ((error as { code?: number }).code === 1) return ''
    throw error
  }
}

export async function searchRepository(folder: IWorkFolder, query: ISearchQuery, access: IFileAccess = {}): Promise<ISearchResult> {
  if (!query.query) return { files: [], total: 0, truncated: false }
  if (query.regex) {
    try {
      searchRegExp(query)
    } catch {
      throw new RepositoryFileError('invalid', 'regex inválida')
    }
  }
  let out: string
  try {
    out = await grep(folder, query, query.regex ? '-P' : '-F')
  } catch (error: unknown) {
    // Git sem PCRE: a regex estendida do POSIX (quase sempre igual para o que se busca à mão).
    if (!query.regex) throw error
    out = await grep(folder, query, '-E')
  }
  const files = new Map<string, ISearchMatch[]>()
  let total = 0
  let truncated = false
  for (const line of out.split('\n')) {
    if (!line) continue
    // Com `-z`: caminho, linha, coluna e o texto, separados por NUL (o texto pode ter `:` à vontade).
    const [path, number, columnText, ...textParts] = line.split('\0')
    // O texto achado é o VALOR: dentro de segredo, só para o admin do projeto.
    if (!path || columnText === undefined || (isSecretPath(path) && !access.secrets)) continue
    const column = Number(columnText)
    const text = textParts.join('\0')
    if (total >= MAX_MATCHES) {
      truncated = true
      break
    }
    total += 1
    const list = files.get(path) ?? []
    list.push({ line: Number(number), column: Number.isFinite(column) ? column : 1, text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text })
    files.set(path, list)
  }
  return { files: [...files].map(([path, matches]) => ({ path, matches })), total, truncated }
}

/**
 * Troca em TODOS os arquivos que a busca acha (ou só nos `paths` escolhidos). ⛔ Mesma conferência do salvar (dentro da
 * pasta, sem segredo, até 1 MB, só texto); devolve quantas trocas em quantos arquivos.
 */
export async function replaceInRepository(
  folder: IWorkFolder,
  query: ISearchQuery,
  replacement: string,
  paths?: readonly string[],
  access: IFileAccess = {},
): Promise<{ files: number; replacements: number }> {
  const found = await searchRepository(folder, query, access)
  if (found.truncated) throw new RepositoryFileError('invalid', 'too many matches: narrow the search before replacing')
  const wanted = paths ? new Set(paths) : undefined
  const pattern = searchRegExp(query)
  let files = 0
  let replacements = 0
  for (const { path } of found.files) {
    if (wanted && !wanted.has(path)) continue
    const full = safeRepositoryPath(folder, path, access)
    const data = readFileSync(full)
    if (data.length > MAX_EDITOR_BYTES || data.subarray(0, 8000).includes(0)) continue
    const text = data.toString('utf8')
    let count = 0
    const next = text.replace(pattern, (...args) => {
      count += 1
      // Com regex, `$1` e companhia valem como no VS Code.
      return query.regex ? (args[0] as string).replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement) : replacement
    })
    if (!count || next === text) continue
    writeFileSync(full, next)
    files += 1
    replacements += count
  }
  return { files, replacements }
}
