import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { Language, Parser, type Node } from 'web-tree-sitter'

/** Análise estática de um comando bash para o motor de permissões. Nunca executa nada. */
export interface IShellCommand {
  /** Basename do argv[0] (`/bin/rm` -> `rm`). */
  name: string
  /** Argumentos com as aspas resolvidas (`g"it"` -> `git`). */
  argv: string[]
  /** Trecho do fonte. */
  text: string
}

export interface IShellRedirect {
  kind: 'read' | 'write'
  /** Como escrito, com as aspas resolvidas. */
  target: string
}

export interface IShellAnalysis {
  commands: IShellCommand[]
  redirects: IShellRedirect[]
  /** Motivos de opacidade; não vazio = falha fechada. */
  opaque: string[]
}

const MAX_DEPTH = 5
// O wasm da gramática vem do pacote; resolvido por require para valer em src (tsx) e dist (CJS).
const WASM_PATH = createRequire(__filename).resolve('tree-sitter-bash/tree-sitter-bash.wasm')

const DANGEROUS_ENV = new Set(['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'PS4', 'SHELLOPTS', 'BASHOPTS'])
const dangerousEnv = (name: string) => DANGEROUS_ENV.has(name) || name.startsWith('LD_') || name.startsWith('DYLD_')

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const INTERPRETER = /^(bash|sh|zsh|dash|ksh|python[\d.]*|node|nodejs|perl|ruby|php|deno|bun|lua|osascript|pwsh)$/
const OPAQUE_BUILTINS: Record<string, string> = { eval: 'eval', source: 'source', '.': 'source', alias: 'alias' }

const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
const REDIRECT_NODES = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])

// Flags de wrapper que consomem o argumento seguinte.
const WRAPPER_FLAGS: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  nice: ['-n', '--adjustment'],
  time: ['-f', '-o', '--format', '--output'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  xargs: [
    '-I',
    '-n',
    '-P',
    '-L',
    '-l',
    '-d',
    '-E',
    '-e',
    '-s',
    '-a',
    '-J',
    '--max-args',
    '--max-procs',
    '--delimiter',
    '--arg-file',
    '--replace',
    '--max-lines',
    '--eof',
    '--max-chars',
  ],
  sudo: [
    '-u',
    '-g',
    '-h',
    '-p',
    '-C',
    '-D',
    '-r',
    '-t',
    '-T',
    '-U',
    '-R',
    '--user',
    '--group',
    '--host',
    '--prompt',
    '--close-from',
    '--chdir',
    '--role',
    '--type',
    '--command-timeout',
    '--other-user',
    '--chroot',
  ],
  doas: ['-u', '-C'],
}
const PLAIN_WRAPPERS = new Set(['nohup', 'builtin', 'command', 'coproc', 'exec'])

let parserPromise: Promise<Parser> | undefined

/** Inicializa o parser uma única vez (lazy). */
function getParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init()
    const parser = new Parser()
    parser.setLanguage(await Language.load(WASM_PATH))
    return parser
  })()
  return parserPromise
}

interface IResolved {
  value: string
  /** Contém expansão/substituição: o valor real só existe em execução. */
  dynamic: boolean
  /** Contém glob/brace fora de aspas. */
  glob: boolean
}

const unescapeWord = (s: string) => s.replace(/\\\n/g, '').replace(/\\(.)/gs, '$1')
const unescapeDouble = (s: string) => s.replace(/\\\n/g, '').replace(/\\(["\\$`])/g, '$1')

/** Resolve aspas/escapes de um nó de palavra. */
function resolve(node: Node): IResolved {
  switch (node.type) {
    case 'word':
      return { value: unescapeWord(node.text), dynamic: false, glob: /[*?[{]/.test(node.text.replace(/\\./g, '')) }
    case 'number':
    case 'file_descriptor':
      return { value: node.text, dynamic: false, glob: false }
    case 'raw_string':
      return { value: node.text.slice(1, -1), dynamic: false, glob: false }
    case 'string': {
      const inner = node.text.slice(node.text.startsWith('$"') ? 2 : 1, -1)
      const dynamic = node.namedChildren.some((c) => c.type !== 'string_content')
      return { value: unescapeDouble(inner), dynamic, glob: false }
    }
    case 'concatenation':
    case 'command_name': {
      const parts = node.namedChildren.map(resolve)
      return {
        value: parts.map((p) => p.value).join(''),
        dynamic: parts.some((p) => p.dynamic),
        glob: parts.some((p) => p.glob),
      }
    }
    default:
      // ansi_c_string, expansões, substituições, brace etc.: não literal.
      return { value: node.text, dynamic: true, glob: false }
  }
}

const isFlag = (s: string) => s.startsWith('-') && s !== '-'

/** Pula flags (e seus argumentos) a partir de i; devolve o índice do primeiro não-flag. */
function skipFlags(argv: string[], i: number, withArg: string[]): number {
  while (i < argv.length && isFlag(argv[i])) {
    if (argv[i] === '--') return i + 1
    i += withArg.includes(argv[i]) ? 2 : 1
  }
  return i
}

class Analyzer {
  readonly commands: IShellCommand[] = []
  readonly redirects: IShellRedirect[] = []
  readonly opaque = new Set<string>()

  constructor(private readonly parser: Parser) {}

  analyze(script: string, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.opaque.add('depth-limit')
      return
    }
    const tree = this.parser.parse(script)
    if (!tree) {
      this.opaque.add('parse-error')
      return
    }
    try {
      if (tree.rootNode.hasError) this.opaque.add('parse-error')
      this.walk(tree.rootNode, depth)
    } finally {
      tree.delete()
    }
  }

  private walk(node: Node, depth: number): void {
    if (node.type === 'ERROR' || node.isMissing) this.opaque.add('parse-error')
    const start = this.commands.length
    switch (node.type) {
      case 'command':
        this.command(node, depth)
        break
      case 'declaration_command':
        this.declaration(node)
        break
      case 'function_definition':
        this.opaque.add('function')
        break
      case 'variable_assignment': {
        const name = node.childForFieldName('name')?.text ?? ''
        if (dangerousEnv(name)) this.opaque.add(`env:${name}`)
        break
      }
      case 'file_redirect':
        this.fileRedirect(node)
        break
    }
    for (const child of node.children) this.walk(child, depth)
    // Heredoc/herestring alimentando um shell/interpretador = script que não vemos.
    if (node.children.some((c) => c.type === 'heredoc_redirect' || c.type === 'herestring_redirect')) {
      if (this.commands.slice(start).some((c) => INTERPRETER.test(c.name))) this.opaque.add('heredoc-interpreter')
    }
  }

  private declaration(node: Node): void {
    const words = node.children.filter((c) => !REDIRECT_NODES.has(c.type) && c.type !== 'variable_assignment' && c.isNamed)
    const argv = words.map((w) => resolve(w).value)
    if (argv.length) this.commands.push({ name: argv[0], argv, text: node.text })
  }

  private command(node: Node, depth: number): void {
    let nameNode: Node | undefined
    const args: Node[] = []
    for (const c of node.namedChildren) {
      if (c.type === 'command_name') nameNode = c
      else if (c.type === 'variable_assignment' || c.type === 'comment' || REDIRECT_NODES.has(c.type)) continue
      else args.push(c)
    }
    if (!nameNode) return
    const name = resolve(nameNode)
    if (name.dynamic || name.glob || name.value === '') this.opaque.add('dynamic-command')
    const argv = [name.value, ...args.map((a) => resolve(a).value)]
    this.register(argv, node.text, depth)
  }

  /** Registra o comando e desembrulha wrappers/shells. */
  private register(argv: string[], text: string, depth: number): void {
    const name = posix.basename(argv[0])
    this.commands.push({ name, argv, text })
    const reason = OPAQUE_BUILTINS[name]
    if (reason) this.opaque.add(reason)
    if (name === 'trap' && argv.length > 2) this.opaque.add('trap')
    if (SHELLS.has(name)) return this.shell(argv, depth)
    if (name === 'find') return this.find(argv, depth)
    if (name === 'exec' && argv.slice(1).some((a) => !isFlag(a))) this.opaque.add('exec')

    const rest = this.unwrap(name, argv)
    if (rest?.length) this.register(rest, rest.join(' '), depth)
  }

  /** Devolve o argv do comando embrulhado, ou undefined se `name` não é wrapper. */
  private unwrap(name: string, argv: string[]): string[] | undefined {
    const withArg = WRAPPER_FLAGS[name] ?? []
    if (PLAIN_WRAPPERS.has(name) || name in WRAPPER_FLAGS) {
      if (name === 'command' && argv.slice(1).some((a) => a === '-v' || a === '-V')) return undefined
      let i = skipFlags(argv, 1, withArg)
      if (name === 'env' || name === 'sudo') {
        if (name === 'env' && argv.slice(1, i).some((a) => a === '-S' || a === '--split-string' || a.startsWith('-S'))) {
          this.opaque.add('env:-S')
          return undefined
        }
        if (name === 'sudo' && argv.slice(1, i).some((a) => /^-[a-zA-Z]*[si][a-zA-Z]*$/.test(a) || a === '--shell' || a === '--login')) this.opaque.add('sudo:shell')
        // VAR=val entre as flags e o comando (e flags depois deles, no env).
        while (i < argv.length) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(argv[i])
          if (m) {
            if (dangerousEnv(m[1])) this.opaque.add(`env:${m[1]}`)
            i++
          } else if (name === 'env' && isFlag(argv[i])) i = skipFlags(argv, i, withArg)
          else break
        }
      }
      if (name === 'doas' && argv.slice(1, i).includes('-s')) this.opaque.add('doas:shell')
      if (name === 'timeout') i++ // duração
      return argv.slice(i)
    }
    return undefined
  }

  /** `bash -c '<script>'` é analisado de forma recursiva; sem -c nem arquivo, lê o stdin. */
  private shell(argv: string[], depth: number): void {
    let hasC = false
    let i = 1
    for (; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--') {
        i++
        break
      }
      if (!/^[-+]/.test(a)) break
      if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(a)) i++
      else if (!a.startsWith('--') && a.startsWith('-') && a.includes('c')) hasC = true
    }
    if (hasC) {
      if (i < argv.length) this.analyze(argv[i], depth + 1)
      return
    }
    if (i >= argv.length) this.opaque.add('shell-stdin')
  }

  /** `find ... -exec cmd {} \;` executa cmd. */
  private find(argv: string[], depth: number): void {
    for (let i = 1; i < argv.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[i])) continue
      let j = i + 1
      while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') j++
      const inner = argv.slice(i + 1, j)
      if (inner.length) this.register(inner, inner.join(' '), depth)
      i = j
    }
  }

  private fileRedirect(node: Node): void {
    const op = node.children.find((c) => !c.isNamed && /[<>]/.test(c.type))?.type ?? ''
    const dest = node.childForFieldName('destination')
    if (!dest) return
    const target = resolve(dest)
    if (/[$`]/.test(target.value) || target.dynamic) {
      // Dup de fd (`>&$fd`) não toca arquivo, mas não dá para provar.
      this.opaque.add('dynamic-redirect')
      return
    }
    if (op === '>&' || op === '<&') {
      if (/^\d+-?$|^-$/.test(target.value) || op === '<&') return
    }
    if (target.value === '/dev/null') return
    const kind = WRITE_OPS.has(op) || op === '>&' ? 'write' : 'read'
    this.redirects.push({ kind, target: target.value })
  }
}

/** Analisa o comando bash sem executá-lo. `opaque` não vazio = o chamador deve falhar fechado. */
export async function analyzeShell(command: string): Promise<IShellAnalysis> {
  const analyzer = new Analyzer(await getParser())
  analyzer.analyze(command, 0)
  return { commands: analyzer.commands, redirects: analyzer.redirects, opaque: [...analyzer.opaque] }
}
