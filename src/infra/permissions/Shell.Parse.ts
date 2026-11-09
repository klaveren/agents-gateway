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
  /** Índices do argv cujo valor só existe em execução (`$x`, `$(…)`): o texto resolvido não é o que roda. Ausente = não se sabe. */
  dynamicArgs?: number[]
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
      // ⚠️ O `$$` no FIM da palavra (`x-$$`) vem como token anônimo, fora dos `namedChildren`: sem contar, sumia do valor.
      const parts = node.children.map((child) => (child.isNamed ? resolve(child) : { value: child.text, dynamic: true, glob: false }))
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

/**
 * ⚖️ `while IFS= read -r l` — o `IFS` na frente do `read` vale SÓ para ele (que não roda nada, só lê uma linha): não muda
 * a divisão de palavras do resto da linha. Em qualquer outro lugar (`IFS=/; …`, `IFS=x cmd`) segue opaco.
 */
function ifsOfRead(node: Node, name: string): boolean {
  if (name !== 'IFS' || node.parent?.type !== 'command') return false
  return node.parent.childForFieldName('name')?.text === 'read'
}

/** Pula flags (e seus argumentos) a partir de i; devolve o índice do primeiro não-flag. */
function skipFlags(argv: string[], i: number, withArg: string[]): number {
  while (i < argv.length && isFlag(argv[i])) {
    if (argv[i] === '--') return i + 1
    i += withArg.includes(argv[i]) ? 2 : 1
  }
  return i
}

/** Builtins que gravam em variável pelo nome (`read TMPDIR`, `unset TMPDIR`, `printf -v`…). */
const VARIABLE_WRITERS = new Set(['read', 'unset', 'printf', 'declare', 'typeset', 'local', 'readonly', 'mapfile', 'readarray', 'getopts', 'let', 'export', 'eval', 'set'])
const MAX_VALUES = 64

/** A variável `name` pode ser (re)escrita dentro de `node`? Conservador: na dúvida, sim. */
function touches(node: Node, name: string): boolean {
  return writes(node, name, 1) > 0
}

/** Quantos pontos de `node` podem (re)escrever `name` (para no `limit`). Conservador: na dúvida, conta. */
function writes(node: Node, name: string, limit: number): number {
  let count = 0
  const stack: Node[] = [node]
  for (let n = stack.pop(); n && count < limit; n = stack.pop()) {
    if (writesHere(n, name)) {
      count += 1
      continue
    }
    stack.push(...n.children)
  }
  return count
}

function writesHere(n: Node, name: string): boolean {
  {
    if (n.type === 'variable_assignment' && n.childForFieldName('name')?.text === name) return true
    if (n.type === 'for_statement' && n.childForFieldName('variable')?.text === name) return true
    if (n.text.includes(name)) {
      // Só quando o NOME é argumento do builtin (`read TMPDIR`, `printf -v TMPDIR`); `printf %s $TMPDIR` apenas lê.
      if ((n.type === 'command' || n.type === 'declaration_command') && VARIABLE_WRITERS.has(n.children[0]?.text ?? '')) {
        if (n.children.slice(1).some((c) => c.text === name || c.text.startsWith(`${name}=`) || c.text.startsWith(`${name}[`))) return true
      }
      if (/arith|binary_expression|postfix_expression|unary_expression/.test(n.type)) return true
      // `${X:=v}`, `${X:?}`…: só a forma simples `${X}` lê sem mexer.
      if (n.type === 'expansion' && n.text !== `\${${name}}`) return true
    }
  }
  return false
}

class Analyzer {
  readonly commands: IShellCommand[] = []
  readonly redirects: IShellRedirect[] = []
  readonly opaque = new Set<string>()
  /** Variáveis que o PRÓPRIO gateway define para o comando (TMPDIR, HOME): valem como literal enquanto o script não as mexe. */
  private env: Readonly<Record<string, string>>
  /** Variável de laço `for v in <literais>` -> as palavras; só dentro do corpo. */
  private loops = new Map<string, string[]>()
  /** Variável atribuída na própria linha (`D=$TMPDIR/x; … $D`) -> o valor; só depois da atribuição (ver `localAssignments`). */
  private locals = new Map<string, { value: string; after: number }>()

  constructor(
    private readonly parser: Parser,
    variables: Readonly<Record<string, string>> = {},
  ) {
    this.env = variables
  }

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
    const previous = { env: this.env, loops: this.loops, locals: this.locals }
    try {
      if (tree.rootNode.hasError) this.opaque.add('parse-error')
      // ⛔ Script que reatribui a variável (em qualquer ponto) volta a ser dinâmico para ela; o script de dentro (`bash -c`) começa sem laços.
      this.env = Object.fromEntries(Object.entries(this.env).filter(([name]) => !touches(tree.rootNode, name)))
      this.loops = new Map()
      this.locals = new Map()
      this.localAssignments(tree.rootNode, previous.env)
      this.walk(tree.rootNode, depth)
    } finally {
      this.env = previous.env
      this.loops = previous.loops
      this.locals = previous.locals
      tree.delete()
    }
  }

  /**
   * Os valores literais que a palavra pode ter, ou undefined se só existem em execução. Só entram variável conhecida do
   * gateway e variável de laço sobre palavras literais; qualquer outra expansão continua dinâmica (falha fechada).
   */
  private values(node: Node, loops = true, locals = true): string[] | undefined {
    switch (node.type) {
      case 'simple_expansion':
      case 'expansion': {
        const [variable] = node.namedChildren
        if (node.namedChildren.length !== 1) return undefined
        if (node.type === 'expansion' && node.text !== `\${${variable.text}}`) return undefined
        // ⚖️ `$$` é só dígitos (o PID; nem atribuição nem `unset` o mudam): `"$TMPDIR/x-$$"` é um nome dentro da pasta, nunca
        // `..` nem `/`. Vale um número qualquer, para a regra ver a pasta certa. ⛔ `$RANDOM` e `$BASHPID` não: com `unset`,
        // viram variáveis comuns (`unset RANDOM; RANDOM=../x`).
        if (variable.type === 'special_variable_name' && variable.text === '$') return ['0']
        if (variable.type !== 'variable_name') return undefined
        const loop = loops ? this.loops.get(variable.text) : undefined
        if (loop) return loop
        // ⛔ Nunca para o NOME do comando (`X=rm; $X -rf …` fugiria da trava do texto): só destino e argumento.
        const local = locals ? this.locals.get(variable.text) : undefined
        if (local) return node.startIndex >= local.after ? [local.value] : undefined
        const value = this.env[variable.text]
        return value === undefined ? undefined : [value]
      }
      case 'string': {
        const children = node.namedChildren
        const parts = children.map((c) => (c.type === 'string_content' ? [unescapeDouble(c.text)] : c.type.endsWith('expansion') ? this.values(c, loops, locals) : undefined))
        const covered = children.reduce((sum, c) => sum + c.text.length, 0)
        if (parts.some((p) => !p) || covered !== node.text.length - (node.text.startsWith('$"') ? 3 : 2)) return undefined
        return this.product(parts as string[][])
      }
      case 'concatenation':
      case 'command_name': {
        // O `$$` anônimo do fim da palavra (ver `resolve`) é o PID; outro token anônimo, não dá para provar.
        const parts = node.children.map((c) => (c.isNamed ? this.values(c, loops, locals) : c.text === '$$' ? ['0'] : undefined))
        return parts.some((p) => !p) || !parts.length ? undefined : this.product(parts as string[][])
      }
      default: {
        const resolved = resolve(node)
        return resolved.dynamic || resolved.glob || /[$`]/.test(resolved.value) ? undefined : [resolved.value]
      }
    }
  }

  private product(parts: string[][]): string[] | undefined {
    let all = ['']
    for (const part of parts) {
      all = all.flatMap((head) => part.map((tail) => head + tail))
      if (all.length > MAX_VALUES) return undefined
    }
    return all
  }

  /**
   * ⚖️ `D=$TMPDIR/x; mkdir -p $D; cp a $D/` — a variável da PRÓPRIA linha vale o valor dela, só quando dá para provar: a
   * atribuição é um comando do nível de cima (separado por `;` ou quebra de linha, nunca depois de `&&`/`||`, num `if`,
   * laço ou subshell), é a ÚNICA escrita da variável no script, o valor é conhecido e sem espaço nem curinga, e a leitura
   * vem DEPOIS dela. Fora disso, segue dinâmica (falha fechada).
   */
  private localAssignments(root: Node, given: Readonly<Record<string, string>>): void {
    for (const child of root.namedChildren) {
      if (child.type !== 'variable_assignment' || child.text.includes('+=')) continue
      const name = child.childForFieldName('name')?.text
      const value = child.childForFieldName('value')
      // As do gateway (`TMPDIR`, `HOME`) reatribuídas seguem dinâmicas: o rascunho do cerco é o que ele deu, não o do script.
      if (!name || !value || name in given || dangerousEnv(name) || this.locals.has(name)) continue
      if (writes(root, name, 2) !== 1) continue
      const known = this.values(value, false)
      if (known?.length !== 1 || !known[0] || /[\s*?[{~]/.test(known[0])) continue
      this.locals.set(name, { value: known[0], after: child.endIndex })
    }
  }

  /** `for v in a b c; do …; done` com só palavras literais (sem expansão, glob ou chave): v vale cada uma, e nada no laço a reatribui. */
  private literalLoop(node: Node): string[] | undefined {
    const name = node.childForFieldName('variable')?.text
    const body = node.childForFieldName('body')
    const items = node.childrenForFieldName('value')
    if (!name || !body || !items.length) return undefined
    const words: string[] = []
    for (const item of items) {
      const resolved = resolve(item)
      // Sem espaço/glob no valor: `> $f` sem aspas racharia ou expandiria.
      if (resolved.dynamic || resolved.glob || /[$`\s*?[{~]/.test(resolved.value) || resolved.value === '') return undefined
      words.push(resolved.value)
    }
    return words.length > MAX_VALUES || touches(body, name) ? undefined : words
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
        if (dangerousEnv(name) && !ifsOfRead(node, name)) this.opaque.add(`env:${name}`)
        break
      }
      case 'file_redirect':
        this.fileRedirect(node)
        break
    }
    // A variável do laço só vale no corpo; fora dele (ou num laço que não é literal), segue dinâmica.
    const loopName = node.type === 'for_statement' ? node.childForFieldName('variable')?.text : undefined
    const loopBody = loopName ? node.childForFieldName('body') : null
    for (const child of node.children) {
      if (!loopName || child.id !== loopBody?.id) {
        this.walk(child, depth)
        continue
      }
      const outer = this.loops.get(loopName)
      const words = this.literalLoop(node)
      if (words) this.loops.set(loopName, words)
      else this.loops.delete(loopName)
      try {
        this.walk(child, depth)
      } finally {
        if (outer) this.loops.set(loopName, outer)
        else this.loops.delete(loopName)
      }
    }
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
    let name = resolve(nameNode)
    if (name.dynamic) {
      // `$TMPDIR/run.sh`: variável do gateway vale o caminho que o cerco dá a ela.
      const known = this.values(nameNode, false, false)
      if (known?.length === 1) name = { value: known[0], dynamic: false, glob: false }
    }
    if (name.dynamic || name.glob || name.value === '') this.opaque.add('dynamic-command')
    const resolved = args.map(resolve)
    // `cd $TMPDIR`: a pasta que o cerco dá à variável, para os caminhos relativos seguintes (ver `leadingCd`). Só no `cd`.
    if (name.value === 'cd' && args.length === 1 && resolved[0].dynamic) {
      const known = this.values(args[0], false, false)
      if (known?.length === 1) resolved[0] = { value: known[0], dynamic: false, glob: false }
    }
    const argv = [name.value, ...resolved.map((a) => a.value)]
    const index = this.commands.length
    this.register(argv, node.text, depth)
    const at = this.commands[index]
    if (at && at.argv === argv) at.dynamicArgs = resolved.flatMap((a, i) => (a.dynamic || a.glob ? [i + 1] : []))
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
      // `bash --version` (e `--help`) imprime e sai: não lê o stdin nem roda nada.
      if (a === '--version' || a === '--help') return
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
    let targets = [target.value]
    if (/[$`]/.test(target.value) || target.dynamic) {
      // `$TMPDIR/x` e a variável de um laço literal viram os valores conhecidos; o resto (inclusive dup de fd `>&$fd`, que não dá para provar) é dinâmico.
      const known = this.values(dest)
      if (!known) {
        this.opaque.add('dynamic-redirect')
        return
      }
      targets = known
    }
    for (const value of targets) {
      if ((op === '>&' || op === '<&') && (/^\d+-?$|^-$/.test(value) || op === '<&')) continue
      if (value === '/dev/null') continue
      const kind = WRITE_OPS.has(op) || op === '>&' ? 'write' : 'read'
      this.redirects.push({ kind, target: value })
    }
  }
}

/**
 * Analisa o comando bash sem executá-lo. `opaque` não vazio = o chamador deve falhar fechado.
 * `variables`: o que o próprio gateway define para o comando (TMPDIR, HOME): valem como literal, salvo se o script as reatribui.
 */
export async function analyzeShell(command: string, variables?: Readonly<Record<string, string>>): Promise<IShellAnalysis> {
  const analyzer = new Analyzer(await getParser(), variables)
  analyzer.analyze(command, 0)
  return { commands: analyzer.commands, redirects: analyzer.redirects, opaque: [...analyzer.opaque] }
}

/** O que fazer em vez do que não se deixa analisar, por motivo (os que o agente mais bate). */
const OPAQUE_ADVICE: Readonly<Record<string, string>> = {
  'env:PATH': 'mudar o PATH esconde qual programa roda; chame pelo caminho: ./node_modules/.bin/x (ou packages/…/node_modules/.bin/x)',
  'dynamic-command': 'o nome do comando vem de variável; escreva o caminho literal (relativo à pasta) no lugar de $VAR',
  'dynamic-redirect': 'o destino vem de variável; escreva o caminho literal',
  function:
    'uma função do shell esconde o que roda a cada chamada; escreva os comandos por extenso, um por vez, ou grave cada arquivo pela ferramenta de escrita (em vez de `f() { … }; f a; f b`)',
  'heredoc-interpreter':
    'o script no heredoc não é analisável; grave-o num arquivo em $TMPDIR (pela ferramenta de escrita) e rode o arquivo com o interpretador que a sua regra libera (`node $TMPDIR/x.mjs`, `python3 $TMPDIR/x.py`…)',
}

/** A recusa por não poder analisar: a saída em uma linha por motivo, com o motivo técnico entre parênteses no fim (o log usa). */
export function opaqueRefusal(reasons: readonly string[]): string {
  const advice = [...new Set(reasons.map((reason) => OPAQUE_ADVICE[reason]).filter((line): line is string => !!line))]
  const detail = `(${reasons.join('; ')})`
  return advice.length ? `não dá para analisar com segurança: ${advice.join('. ')} ${detail}` : `não dá para analisar com segurança ${detail}`
}
