import { existsSync, realpathSync } from 'node:fs'
import { glob, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'
import { ILocalTool, IToolResult } from './Tool.Types'

export interface IFileToolDeps {
  /** A pasta-raiz onde as tools podem mexer, por chamada (a pasta do projeto da conversa). */
  rootFor: (context?: IExecutionContext) => string
  /**
   * As permissões (ver `Permission.Policy`): o motivo da negação para ler ou escrever o caminho (relativo à raiz), ou
   * nada se pode. `log`: registra a decisão (no arquivo pedido, sim; em cada item de uma listagem, não). Ausente = sem
   * permissões (só a raiz e a lista protegida valem).
   */
  access?: (context: IExecutionContext | undefined, kind: 'read' | 'write', path: string, log: boolean) => string | undefined
}

const READ_WHOLE_MAX_BYTES = 256 * 1024
const READ_SLICE_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_LINE_LIMIT = 2000
const WRITE_MAX_BYTES = 1024 * 1024
const SEARCH_FILE_MAX_BYTES = 1024 * 1024
const LIST_MAX = 500
const SEARCH_MAX = 200
const LINE_MAX_CHARS = 200
const BINARY_SNIFF_BYTES = 8 * 1024
const SKIPPED_DIRS = new Set(['node_modules', '.git'])

/** O caminho real do alvo; se ele não existe, o do ancestral mais próximo que existe + o resto. */
/** O caminho canônico (links resolvidos; o que ainda não existe, pelo ancestral que existe). */
export function realOf(target: string): string {
  const rest: string[] = []
  let current = target
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    rest.unshift(basename(current))
    current = parent
  }
  let real = current
  try {
    real = realpathSync(current)
  } catch {
    // sem permissão ou corrida: fica o caminho como está, e a conferência de pasta decide
  }
  return join(real, ...rest)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** ⛔ O caminho (relativo à raiz ou absoluto) só vale se, resolvidos os symlinks, continua dentro da raiz. */
export function resolveInside(root: string, path: string): string | undefined {
  if (typeof path !== 'string' || path.includes('\0')) return undefined
  const realRoot = realOf(resolve(root))
  const target = realOf(resolve(realRoot, path))
  return isInside(realRoot, target) ? target : undefined
}

/** ⛔ Os arquivos sempre protegidos: segredos e o dado interno do gateway (fora da raiz das tools). */
export function deniedPath(absPath: string, root: string): string | undefined {
  const name = basename(absPath)
  if (name === '.env' || name.startsWith('.env.')) return 'environment file'
  if (name.endsWith('.key') || name.endsWith('.pem')) return 'key file'
  if (name.startsWith('id_rsa')) return 'SSH key'
  if (name.startsWith('secrets.')) return 'secrets file'
  // As credenciais de um comando (Projeto → Contas): o comando as usa; a ferramenta de arquivo não as lê.
  if (/(^|[\\/])\.home[\\/]\.accounts([\\/]|$)/.test(absPath)) return 'account credentials'
  const real = realOf(resolve(absPath))
  if (isInside(realOf(dataDir()), real) && !isInside(realOf(resolve(root)), real)) return 'gateway data'
  return undefined
}

const fail = (result: string): IToolResult => ({ status: 'error', result })
const toMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** O caminho já conferido (dentro da raiz e não protegido) ou o erro pronto. */
function guard(root: string, path: unknown, permit?: (rel: string) => string | undefined): { abs: string } | { error: IToolResult } {
  if (typeof path !== 'string' || !path.trim()) return { error: fail('path is required.') }
  const abs = resolveInside(root, path)
  if (!abs) return { error: fail('path is outside the allowed folder') }
  const reason = deniedPath(abs, root)
  if (reason) return { error: fail(`${reason}: this file is protected`) }
  const denied = permit?.(relOf(root, abs))
  if (denied) return { error: fail(`Not permitted: ${denied}`) }
  return { abs }
}

const relOf = (root: string, abs: string) => relative(realOf(resolve(root)), abs) || '.'

/** Binário = byte NUL nos primeiros 8 KB. */
async function isBinary(abs: string): Promise<boolean> {
  const handle = await open(abs, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/** Percorre o glob sem entrar em node_modules/.git e devolve só caminhos relativos ao cwd. */
async function walk(cwd: string, pattern: string): Promise<string[]> {
  const found: string[] = []
  const exclude = (entry: unknown) => {
    const name = typeof entry === 'string' ? basename(entry) : ((entry as { name?: string }).name ?? '')
    return SKIPPED_DIRS.has(name)
  }
  for await (const entry of glob(pattern, { cwd, exclude: exclude as never })) {
    if (entry.split(sep).some((part) => SKIPPED_DIRS.has(part))) continue
    found.push(entry)
  }
  return found.sort()
}

function numbered(lines: string[], first: number): string {
  return lines.map((line, index) => `${String(first + index).padStart(5)}\t${line}`).join('\n')
}

function readFileTool(deps: IFileToolDeps): ILocalTool {
  return {
    origin: 'local',
    name: 'read_file',
    description:
      'Reads a text file from the project folder and returns its lines numbered. Large files (over 256 KB) need offset/limit. Binary files are refused. Paths are relative to the project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder' },
        offset: { type: 'number', description: 'First line to read (1-based). Default: 1' },
        limit: { type: 'number', description: `How many lines to read. Default: ${DEFAULT_LINE_LIMIT}` },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = deps.rootFor(context)
      const checked = guard(root, args.path, (rel) => deps.access?.(context, 'read', rel, true))
      if ('error' in checked) return checked.error
      try {
        const info = await stat(checked.abs)
        if (!info.isFile()) return fail('not a file')
        const sliced = args.offset !== undefined || args.limit !== undefined
        if (info.size > (sliced ? READ_SLICE_MAX_BYTES : READ_WHOLE_MAX_BYTES))
          return fail(sliced ? 'file is larger than 5 MB' : `file is larger than 256 KB (${info.size} bytes): pass offset and limit to read part of it`)
        if (await isBinary(checked.abs)) return fail('binary file: cannot be read as text')
        const lines = (await readFile(checked.abs, 'utf8')).split('\n')
        const offset = Math.max(1, Math.floor(Number(args.offset)) || 1)
        const limit = Math.max(1, Math.floor(Number(args.limit)) || DEFAULT_LINE_LIMIT)
        if (offset > lines.length) return fail(`offset ${offset} is past the end of the file (${lines.length} lines)`)
        const slice = lines.slice(offset - 1, offset - 1 + limit)
        const more = offset - 1 + limit < lines.length ? `\n… ${lines.length - (offset - 1 + limit)} more lines` : ''
        return { status: 'success', result: numbered(slice, offset) + more }
      } catch (error: unknown) {
        return fail(`Could not read ${relOf(root, checked.abs)}: ${toMessage(error)}`)
      }
    },
  }
}

function listFilesTool(deps: IFileToolDeps): ILocalTool {
  return {
    origin: 'local',
    name: 'list_files',
    description: `Lists files in the project folder that match a glob pattern (e.g. "**/*.ts"), sorted, relative paths, at most ${LIST_MAX}. Skips node_modules and .git.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/*.md"' },
        path: { type: 'string', description: 'Folder to search in, relative to the project folder. Default: the project folder' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = deps.rootFor(context)
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      if (!pattern) return fail('pattern is required.')
      const checked = guard(root, args.path ?? '.')
      if ('error' in checked) return checked.error
      try {
        const names: string[] = []
        for (const name of await walk(checked.abs, pattern)) {
          const abs = resolveInside(root, join(checked.abs, name))
          if (abs && !deniedPath(abs, root) && !deps.access?.(context, 'read', relOf(root, abs), false)) names.push(relOf(root, abs))
        }
        if (!names.length) return { status: 'success', result: 'No files match.' }
        const shown = names.slice(0, LIST_MAX).join('\n')
        return { status: 'success', result: names.length > LIST_MAX ? `${shown}\n… ${names.length - LIST_MAX} more` : shown }
      } catch (error: unknown) {
        return fail(`Could not list files: ${toMessage(error)}`)
      }
    },
  }
}

function searchFilesTool(deps: IFileToolDeps): ILocalTool {
  return {
    origin: 'local',
    name: 'search_files',
    description: `Searches file contents in the project folder with a JavaScript regular expression. Returns "path:line: text" (at most ${SEARCH_MAX} matches). Skips binary, large, protected files, node_modules and .git.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'Folder to search in, relative to the project folder. Default: the project folder' },
        glob: { type: 'string', description: 'Only files matching this glob. Default: "**/*"' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = deps.rootFor(context)
      const source = typeof args.pattern === 'string' ? args.pattern : ''
      if (!source) return fail('pattern is required.')
      let regex: RegExp
      try {
        regex = new RegExp(source)
      } catch (error: unknown) {
        return fail(`invalid regular expression: ${toMessage(error)}`)
      }
      const checked = guard(root, args.path ?? '.')
      if ('error' in checked) return checked.error
      const fileGlob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : '**/*'
      try {
        const matches: string[] = []
        let truncated = false
        for (const name of await walk(checked.abs, fileGlob)) {
          const abs = resolveInside(root, join(checked.abs, name))
          if (!abs || deniedPath(abs, root) || deps.access?.(context, 'read', relOf(root, abs), false)) continue
          const info = await stat(abs)
          if (!info.isFile() || info.size > SEARCH_FILE_MAX_BYTES || (await isBinary(abs))) continue
          const lines = (await readFile(abs, 'utf8')).split('\n')
          for (let index = 0; index < lines.length; index++) {
            if (!regex.test(lines[index])) continue
            if (matches.length >= SEARCH_MAX) {
              truncated = true
              break
            }
            matches.push(`${relOf(root, abs)}:${index + 1}: ${lines[index].trim().slice(0, LINE_MAX_CHARS)}`)
          }
          if (truncated) break
        }
        if (!matches.length) return { status: 'success', result: 'No matches.' }
        return { status: 'success', result: truncated ? `${matches.join('\n')}\n… more matches not shown (limit ${SEARCH_MAX})` : matches.join('\n') }
      } catch (error: unknown) {
        return fail(`Search failed: ${toMessage(error)}`)
      }
    },
  }
}

function writeFileTool(deps: IFileToolDeps): ILocalTool {
  return {
    origin: 'local',
    name: 'write_file',
    description:
      'Writes a file in the project folder (creates it and its folders, or replaces it entirely). Content up to 1 MB. For small changes to an existing file prefer edit_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder' },
        content: { type: 'string', description: 'The full file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = deps.rootFor(context)
      const checked = guard(root, args.path, (rel) => deps.access?.(context, 'write', rel, true))
      if ('error' in checked) return checked.error
      if (typeof args.content !== 'string') return fail('content is required.')
      const bytes = Buffer.byteLength(args.content)
      if (bytes > WRITE_MAX_BYTES) return fail(`content is larger than 1 MB (${bytes} bytes)`)
      try {
        await mkdir(dirname(checked.abs), { recursive: true })
        // Revalida depois do mkdir: o pai agora existe e pode ser um symlink que escapa.
        const again = guard(root, args.path, (rel) => deps.access?.(context, 'write', rel, false))
        if ('error' in again) return again.error
        await writeFile(again.abs, args.content, 'utf8')
        return { status: 'success', result: `Wrote ${bytes} bytes to ${relOf(root, again.abs)}` }
      } catch (error: unknown) {
        return fail(`Could not write ${relOf(root, checked.abs)}: ${toMessage(error)}`)
      }
    },
  }
}

function editFileTool(deps: IFileToolDeps): ILocalTool {
  return {
    origin: 'local',
    name: 'edit_file',
    description:
      'Replaces an exact string in a file of the project folder. Fails if old_string is not found, or if it appears more than once and replace_all is not true (then add context to make it unique).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the project folder' },
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'The text to put in its place' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default: false' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = deps.rootFor(context)
      const checked = guard(root, args.path, (rel) => deps.access?.(context, 'write', rel, true))
      if ('error' in checked) return checked.error
      const { old_string: from, new_string: to } = args
      if (typeof from !== 'string' || typeof to !== 'string' || !from) return fail('old_string and new_string are required (old_string cannot be empty).')
      if (from === to) return fail('old_string and new_string are identical: nothing to change')
      try {
        const info = await stat(checked.abs)
        if (!info.isFile()) return fail('not a file')
        if (info.size > READ_SLICE_MAX_BYTES) return fail('file is larger than 5 MB')
        if (await isBinary(checked.abs)) return fail('binary file: cannot be edited as text')
        const text = await readFile(checked.abs, 'utf8')
        const count = text.split(from).length - 1
        if (count === 0) return fail('old_string not found in the file')
        if (count > 1 && args.replace_all !== true) return fail(`old_string appears ${count} times: add more context to make it unique, or pass replace_all: true`)
        // split/join: sem os `$` especiais do replace.
        await writeFile(checked.abs, text.split(from).join(to), 'utf8')
        return { status: 'success', result: `Edited ${relOf(root, checked.abs)} (${count} replacement${count === 1 ? '' : 's'})` }
      } catch (error: unknown) {
        return fail(`Could not edit ${relOf(root, checked.abs)}: ${toMessage(error)}`)
      }
    },
  }
}

/**
 * As tools de arquivo do gateway, presas a uma pasta-raiz — para os providers que não têm as nativas.
 * ⛔ Todo caminho passa por `resolveInside` (symlinks incluídos) e por `deniedPath` antes de qualquer E/S.
 */
export function makeFileTools(deps: IFileToolDeps): ILocalTool[] {
  return [readFileTool(deps), listFilesTool(deps), searchFilesTool(deps), writeFileTool(deps), editFileTool(deps)]
}
