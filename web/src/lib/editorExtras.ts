/**
 * 🧩 O que o editor de arquivos ganhou das extensões do VS Code, feito no próprio Monaco:
 * - Error Lens: a mensagem do problema no fim da linha (dos marcadores do ESLint);
 * - Better Comments: `// !`, `// ?`, `// TODO`, `// *` e `////` coloridos;
 * - Rainbow CSV: uma cor por coluna em `.csv` e `.tsv`;
 * - Vue: o realce de HTML (com `<script>` e `<style>` embutidos) para `.vue`.
 */
import type * as Monaco from 'monaco-editor'

type TMonaco = typeof Monaco
type TEditor = Monaco.editor.IStandaloneCodeEditor

let languagesReady = false

/** As linguagens que o Monaco não traz: Vue (realce de HTML) e CSV/TSV (uma cor por coluna). */
export async function registerExtraLanguages(monaco: TMonaco): Promise<void> {
  if (languagesReady) return
  languagesReady = true
  const html = (await import('monaco-editor/languages/definitions/html/html')) as unknown as {
    conf: Monaco.languages.LanguageConfiguration
    language: Monaco.languages.IMonarchLanguage
  }
  monaco.languages.register({ id: 'vue', extensions: ['.vue'], aliases: ['Vue'] })
  monaco.languages.setMonarchTokensProvider('vue', html.language)
  monaco.languages.setLanguageConfiguration('vue', html.conf)
  for (const [id, extension, separator] of [
    ['csv', '.csv', ','],
    ['tsv', '.tsv', '\t'],
  ] as const) {
    monaco.languages.register({ id, extensions: [extension], aliases: [id.toUpperCase()] })
    monaco.languages.setMonarchTokensProvider(id, rainbow(separator))
  }
}

/** Rainbow CSV: um estado por coluna; o separador passa para a próxima, a quebra de linha volta à primeira. */
function rainbow(separator: string): Monaco.languages.IMonarchLanguage {
  const COLUMNS = 8
  const sep = separator === '\t' ? '\\t' : separator
  const tokenizer: Record<string, Monaco.languages.IMonarchLanguageRule[]> = {}
  for (let column = 0; column < COLUMNS; column += 1) {
    const next = column + 1 === COLUMNS ? 'root' : `c${column + 1}`
    tokenizer[column === 0 ? 'root' : `c${column}`] = [
      [/"(?:[^"]|"")*"/, `rainbow${column}`],
      [new RegExp(sep), { token: 'delimiter', next }],
      [new RegExp(`[^${sep}"]+`), `rainbow${column}`],
    ]
  }
  // Fim de linha: volta à primeira coluna.
  for (const state of Object.keys(tokenizer)) if (state !== 'root') tokenizer[state].unshift([/$/, { token: '', next: 'root' }])
  return { defaultToken: '', tokenizer: tokenizer as Monaco.languages.IMonarchLanguage['tokenizer'] }
}

const COMMENT_TAGS: Array<{ test: RegExp; className: string }> = [
  { test: /^\/\//, className: 'bc-strike' },
  { test: /^!/, className: 'bc-alert' },
  { test: /^\?/, className: 'bc-query' },
  { test: /^(TODO|FIXME)\b/i, className: 'bc-todo' },
  { test: /^\*/, className: 'bc-highlight' },
]

/** Onde começa o comentário de linha, por linguagem (aproximado: ignora `//` dentro de URL). */
function commentStart(line: string, language: string): number | undefined {
  const markers = ['python', 'yaml', 'shell', 'ruby', 'dockerfile', 'ini', 'toml', 'perl', 'r', 'makefile'].includes(language) ? ['#'] : ['//', '#']
  for (const marker of markers) {
    let from = 0
    for (;;) {
      const at = line.indexOf(marker, from)
      if (at < 0) break
      // `https://`: não é comentário.
      if (marker === '//' && at > 0 && line[at - 1] === ':') {
        from = at + 2
        continue
      }
      if (marker === '#' && !['python', 'yaml', 'shell', 'ruby', 'dockerfile', 'ini', 'toml', 'perl', 'r', 'makefile'].includes(language)) break
      return at + marker.length
    }
  }
  return undefined
}

/** Better Comments: decora o texto do comentário conforme a marca logo depois do `//` (ou `#`). */
export function betterComments(monaco: TMonaco, editor: TEditor): () => void {
  const collection = editor.createDecorationsCollection()
  let timer: ReturnType<typeof setTimeout> | undefined
  const paint = () => {
    const model = editor.getModel()
    if (!model) return collection.clear()
    const language = model.getLanguageId()
    const decorations: Monaco.editor.IModelDeltaDecoration[] = []
    const lines = Math.min(model.getLineCount(), 20_000)
    for (let number = 1; number <= lines; number += 1) {
      const text = model.getLineContent(number)
      const start = commentStart(text, language)
      if (start === undefined) continue
      const rest = text.slice(start).trimStart()
      const tag = COMMENT_TAGS.find((one) => one.test.test(rest))
      if (!tag) continue
      decorations.push({ range: new monaco.Range(number, start - 1, number, text.length + 1), options: { inlineClassName: tag.className } })
    }
    collection.set(decorations)
  }
  const later = () => {
    clearTimeout(timer)
    timer = setTimeout(paint, 200)
  }
  const subscriptions = [editor.onDidChangeModel(paint), editor.onDidChangeModelContent(later)]
  paint()
  return () => {
    clearTimeout(timer)
    for (const subscription of subscriptions) subscription.dispose()
    collection.clear()
  }
}

/** Error Lens: a primeira mensagem de cada linha com problema, no fim dela (e a linha tingida). */
export function errorLens(monaco: TMonaco, editor: TEditor): () => void {
  const collection = editor.createDecorationsCollection()
  const paint = () => {
    const model = editor.getModel()
    if (!model) return collection.clear()
    const markers = monaco.editor.getModelMarkers({ resource: model.uri })
    const byLine = new Map<number, Monaco.editor.IMarker>()
    for (const marker of markers) {
      const current = byLine.get(marker.startLineNumber)
      if (!current || marker.severity > current.severity) byLine.set(marker.startLineNumber, marker)
    }
    const decorations: Monaco.editor.IModelDeltaDecoration[] = []
    for (const [line, marker] of byLine) {
      if (line > model.getLineCount()) continue
      const error = marker.severity === monaco.MarkerSeverity.Error
      const end = model.getLineMaxColumn(line)
      decorations.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: error ? 'el-line-error' : 'el-line-warn' } })
      decorations.push({
        range: new monaco.Range(line, end, line, end),
        options: {
          // Faixa vazia (o fim da linha): sem isto o Monaco não mostra a decoração.
          showIfCollapsed: true,
          after: {
            content: `    ${marker.message}${marker.code ? ` (${typeof marker.code === 'string' ? marker.code : marker.code.value})` : ''}`,
            inlineClassName: error ? 'el-text-error' : 'el-text-warn',
          },
        },
      })
    }
    collection.set(decorations)
  }
  const subscriptions = [
    editor.onDidChangeModel(paint),
    monaco.editor.onDidChangeMarkers((uris) => {
      const model = editor.getModel()
      if (model && uris.some((uri) => uri.toString() === model.uri.toString())) paint()
    }),
  ]
  paint()
  return () => {
    for (const subscription of subscriptions) subscription.dispose()
    collection.clear()
  }
}

/** O que está antes do cursor, dentro das aspas de um import/require/export que começa com `./` ou `../`. */
export function importPrefix(before: string): string | undefined {
  const typed = moduleString(before)
  return typed !== undefined && /^\.{1,2}\//.test(typed) ? typed : undefined
}

/** O texto dentro das aspas de um import/require/export, até o cursor (relativo, alias ou pacote). */
export function moduleString(before: string): string | undefined {
  const match = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bexport\s+\*\s+from\s+)(['"])([^'"]*)$/.exec(before)
  return match?.[2]
}

/** Um alias dos `paths` do tsconfig: `@domain/*` → a pasta (relativa à raiz do repositório) que ele aponta. */
export interface IPathAlias {
  /** O que vem antes do `*` (`@domain/`), ou o alias inteiro, sem `*` (`~`). */
  prefix: string
  wildcard: boolean
  /** A pasta de destino (sem o `*`), relativa à raiz do repositório. */
  target: string
}

/** JSON com comentário e vírgula sobrando (o tsconfig). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[index + 1] ?? ''
        index += 1
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
    } else if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 1
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Junta `pasta` + `./relativo` (com `..`), relativo à raiz do repositório. */
export function joinPath(folder: string, relative: string): string | undefined {
  const parts = folder ? folder.split('/') : []
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Os aliases do tsconfig (`compilerOptions.paths`, com o `baseUrl`), seguindo o `extends` relativo — o do filho vence.
 * `read`: o texto de um arquivo do repositório (ou `undefined`).
 */
export async function tsconfigAliases(tsconfigPath: string, read: (path: string) => Promise<string | undefined>, depth = 0): Promise<IPathAlias[]> {
  if (depth > 4) return []
  const text = await read(tsconfigPath)
  if (text === undefined) return []
  let config: { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> } }
  try {
    config = parseJsonc(text) as typeof config
  } catch {
    return []
  }
  const dir = tsconfigPath.split('/').slice(0, -1).join('/')
  const parents = (Array.isArray(config.extends) ? config.extends : [config.extends]).filter((value): value is string => typeof value === 'string' && value.startsWith('.'))
  const inherited: IPathAlias[] = []
  for (const parent of parents) {
    const file = joinPath(dir, parent.endsWith('.json') ? parent : `${parent}.json`)
    if (file !== undefined) inherited.push(...(await tsconfigAliases(file, read, depth + 1)))
  }
  const paths = config.compilerOptions?.paths
  if (!paths || typeof paths !== 'object') return inherited
  const baseUrl = typeof config.compilerOptions?.baseUrl === 'string' ? config.compilerOptions.baseUrl : '.'
  const base = joinPath(dir, baseUrl)
  if (base === undefined) return inherited
  const own: IPathAlias[] = []
  for (const [key, targets] of Object.entries(paths)) {
    const first = Array.isArray(targets) ? targets.find((value): value is string => typeof value === 'string') : undefined
    if (!first) continue
    const wildcard = key.endsWith('*')
    const target = joinPath(base, first.replace(/\*$/, ''))
    if (target === undefined) continue
    own.push({ prefix: wildcard ? key.slice(0, -1) : key, wildcard, target })
  }
  const keys = new Set(own.map((alias) => alias.prefix))
  return [...own, ...inherited.filter((alias) => !keys.has(alias.prefix))]
}

/** Resolve `./x/../y` a partir da pasta do arquivo (relativo à raiz do repositório). `undefined`: sai da raiz. */
export function resolveFolder(fromFolder: string, typed: string): string | undefined {
  const parts = fromFolder ? fromFolder.split('/') : []
  const typedFolder = typed.slice(0, typed.lastIndexOf('/'))
  for (const part of typedFolder.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

const NO_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * 📎 Caminhos no `import './'`: sugere as pastas e os arquivos da árvore a partir da pasta do arquivo aberto (como o VS
 * Code). Código TS/JS sai sem a extensão; o resto (`.vue`, `.css`, `.json`), com ela.
 */
export function importPathCompletion(
  monaco: TMonaco,
  files: () => string[],
  pathOf: (model: Monaco.editor.ITextModel) => string | undefined,
  aliasesOf: (path: string) => Promise<IPathAlias[]> = async () => [],
): () => void {
  const provider = monaco.languages.registerCompletionItemProvider(['typescript', 'javascript', 'vue'], {
    triggerCharacters: ['/', '.', "'", '"'],
    async provideCompletionItems(model, position) {
      const path = pathOf(model)
      if (!path) return { suggestions: [] }
      const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column))
      const typed = moduleString(before)
      if (typed === undefined) return { suggestions: [] }
      let folder: string | undefined
      if (/^\.{1,2}\//.test(typed)) folder = resolveFolder(path.split('/').slice(0, -1).join('/'), typed)
      else {
        // 🏷️ Alias do tsconfig (`@domain/…`): a pasta para onde ele aponta.
        const aliases = await aliasesOf(path)
        const alias = aliases
          .filter((one) => (one.wildcard ? typed.startsWith(one.prefix) : typed === one.prefix || typed.startsWith(`${one.prefix}/`)))
          .sort((a, b) => b.prefix.length - a.prefix.length)[0]
        if (alias) {
          const rest = typed.slice(alias.prefix.length).replace(/^\//, '')
          folder = joinPath(alias.target, rest.slice(0, rest.lastIndexOf('/') + 1))
        } else {
          // Ainda digitando o nome do alias: sugere os aliases que começam assim.
          const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column)
          return {
            suggestions: aliases
              .filter((one) => one.prefix.startsWith(typed) && one.prefix !== typed)
              .map((one) => ({
                label: one.prefix,
                kind: monaco.languages.CompletionItemKind.Module,
                detail: `→ ${one.target || '.'}`,
                insertText: one.prefix,
                range,
                ...(one.wildcard ? { command: { id: 'editor.action.triggerSuggest', title: 'Continuar' } } : {}),
              })),
          }
        }
      }
      if (folder === undefined) return { suggestions: [] }
      const prefix = folder ? `${folder}/` : ''
      const seen = new Map<string, boolean>()
      for (const file of files()) {
        if (!file.startsWith(prefix) || file === path) continue
        const rest = file.slice(prefix.length)
        const slash = rest.indexOf('/')
        const name = slash === -1 ? rest : rest.slice(0, slash)
        if (!seen.has(name)) seen.set(name, slash !== -1)
      }
      const word = typed.slice(typed.lastIndexOf('/') + 1)
      const range = new monaco.Range(position.lineNumber, position.column - word.length, position.lineNumber, position.column)
      const suggestions = [...seen].map(([name, isFolder]) => ({
        label: isFolder ? `${name}/` : name,
        kind: isFolder ? monaco.languages.CompletionItemKind.Folder : monaco.languages.CompletionItemKind.File,
        insertText: isFolder ? `${name}/` : name.replace(NO_EXTENSION, ''),
        // Pasta primeiro, como na árvore.
        sortText: `${isFolder ? '0' : '1'}${name.toLowerCase()}`,
        range,
        ...(isFolder ? { command: { id: 'editor.action.triggerSuggest', title: 'Continuar' } } : {}),
      }))
      return { suggestions }
    },
  })
  return () => provider.dispose()
}
