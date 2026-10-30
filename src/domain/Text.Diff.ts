/**
 * O DIFF DE LINHAS do catálogo (ver docs/integration/plano-catalogo-historico.md §2.2): compara dois textos canônicos e
 * devolve os trechos que mudaram (hunks com contexto) e o mesmo resultado em texto unificado (`diff -u`).
 *
 * ⚖️ PRÓPRIO, sem dependência: o algoritmo de Myers (o caminho de edição mais curto), depois de cortar o começo e o fim
 * iguais — o caso comum do catálogo é uma mudança pequena num documento grande.
 *
 * ⚠️ TETO DE ESFORÇO: o rastro do Myers cresce com o quadrado do número de edições. Passando de `EDIT_LIMIT`, o miolo
 * diferente sai como "tudo saiu, tudo entrou" — correto, só não é o menor. Reescrever um documento inteiro já é isso.
 */

export type TDiffOp = 'equal' | 'add' | 'remove'

export interface IDiffLine {
  op: TDiffOp
  text: string
  /** O número da linha (1..n) no texto de antes; ausente na linha que entrou. */
  oldLine?: number
  /** O número da linha (1..n) no texto de depois; ausente na linha que saiu. */
  newLine?: number
  /** A última linha do texto, sem quebra no fim (`\ No newline at end of file`). */
  noNewline?: true
}

/** Um trecho que mudou, com as linhas de contexto em volta. `oldStart`/`newStart` seguem o `diff -u` (0 quando vazio). */
export interface IDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: IDiffLine[]
}

export interface ITextDiff {
  equal: boolean
  added: number
  removed: number
  hunks: IDiffHunk[]
  /** O texto unificado (`---`/`+++`/`@@`); vazio quando os textos são iguais. */
  unified: string
}

export interface IDiffOptions {
  /** Linhas de contexto em volta de cada mudança. Padrão: 3. */
  context?: number
  /** Os rótulos de `---` e `+++`. */
  fromLabel?: string
  toLabel?: string
}

export const DIFF_CONTEXT_DEFAULT = 3
/** O número de edições a partir do qual o miolo sai inteiro (ver o cabeçalho). */
export const EDIT_LIMIT = 2_000

const NO_NEWLINE = '\\ No newline at end of file'

interface ISplit {
  lines: string[]
  /** As linhas para comparar: a última sem quebra ganha uma marca, para não empatar com a mesma linha com quebra. */
  keys: string[]
  noNewline: boolean
}

function split(text: string): ISplit {
  if (text === '') return { lines: [], keys: [], noNewline: false }
  const lines = text.split('\n')
  const noNewline = lines[lines.length - 1] !== ''
  if (!noNewline) lines.pop()
  const keys = noNewline ? [...lines.slice(0, -1), `${lines[lines.length - 1]}\0`] : lines
  return { lines, keys, noNewline }
}

type TStep = { op: TDiffOp; a?: number; b?: number }

/**
 * O caminho de edição mais curto entre `a` e `b` (Myers, 1986), na ordem. `a`/`b` são índices nos arrays.
 * `undefined` = passou do teto de esforço.
 */
function myers(a: readonly string[], b: readonly string[], aStart: number, aEnd: number, bStart: number, bEnd: number): TStep[] | undefined {
  const n = aEnd - aStart
  const m = bEnd - bStart
  const max = n + m
  const limit = Math.min(max, EDIT_LIMIT)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // O rastro guarda, a cada passo d, só a faixa de diagonais que o passo pode ler ([-d-1, d+1]).
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m, aStart, bStart)
    }
  }
  return undefined
}

function backtrack(trace: Int32Array[], n: number, m: number, aStart: number, bStart: number): TStep[] {
  const steps: TStep[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]
    const at = (k: number) => snapshot[k + d + 1]
    const k = x - y
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      x--
      y--
      steps.push({ op: 'equal', a: aStart + x, b: bStart + y })
    }
    if (d > 0) {
      if (x === previousX) steps.push({ op: 'add', b: bStart + previousY })
      else steps.push({ op: 'remove', a: aStart + previousX })
    }
    x = previousX
    y = previousY
  }
  return steps.reverse()
}

/** O roteiro inteiro: o começo igual, o miolo (Myers, ou tudo sai/tudo entra além do teto) e o fim igual. */
function script(a: readonly string[], b: readonly string[]): TStep[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
  }
  const steps: TStep[] = []
  for (let i = 0; i < start; i++) steps.push({ op: 'equal', a: i, b: i })
  const middle = myers(a, b, start, aEnd, start, bEnd)
  if (middle) steps.push(...middle)
  else {
    for (let i = start; i < aEnd; i++) steps.push({ op: 'remove', a: i })
    for (let j = start; j < bEnd; j++) steps.push({ op: 'add', b: j })
  }
  for (let i = 0; aEnd + i < a.length; i++) steps.push({ op: 'equal', a: aEnd + i, b: bEnd + i })
  return steps
}

/** Agrupa as mudanças em trechos: duas mudanças a até `2 × context` linhas iguais uma da outra ficam no mesmo trecho. */
function hunksOf(lines: readonly IDiffLine[], context: number): IDiffHunk[] {
  const changes = lines.flatMap((line, index) => (line.op === 'equal' ? [] : [index]))
  const hunks: IDiffHunk[] = []
  let i = 0
  while (i < changes.length) {
    let last = changes[i]
    let j = i + 1
    while (j < changes.length && changes[j] - last - 1 <= 2 * context) last = changes[j++]
    const from = Math.max(0, changes[i] - context)
    const to = Math.min(lines.length, last + context + 1)
    const slice = lines.slice(from, to)
    // A linha antes do trecho dá o início quando o lado não tem linha nenhuma nele (o `diff -u` escreve `-3,0`).
    const before = lines.slice(0, from)
    const oldBefore = before.filter((line) => line.op !== 'add').length
    const newBefore = before.filter((line) => line.op !== 'remove').length
    const oldLines = slice.filter((line) => line.op !== 'add').length
    const newLines = slice.filter((line) => line.op !== 'remove').length
    hunks.push({ oldStart: oldLines ? oldBefore + 1 : oldBefore, oldLines, newStart: newLines ? newBefore + 1 : newBefore, newLines, lines: slice })
    i = j
  }
  return hunks
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)
const PREFIX: Record<TDiffOp, string> = { equal: ' ', add: '+', remove: '-' }

function unifiedOf(hunks: readonly IDiffHunk[], fromLabel: string, toLabel: string): string {
  if (!hunks.length) return ''
  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  for (const hunk of hunks) {
    out.push(`@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`)
    for (const line of hunk.lines) {
      out.push(`${PREFIX[line.op]}${line.text}`)
      if (line.noNewline) out.push(NO_NEWLINE)
    }
  }
  return `${out.join('\n')}\n`
}

/** O diff de linhas de `before` para `after`. */
export function diffText(before: string, after: string, options: IDiffOptions = {}): ITextDiff {
  const context = Math.max(0, Math.floor(options.context ?? DIFF_CONTEXT_DEFAULT))
  const a = split(before)
  const b = split(after)
  const lines: IDiffLine[] = script(a.keys, b.keys).map((step) => {
    const lastOld = step.a !== undefined && a.noNewline && step.a === a.lines.length - 1
    const lastNew = step.b !== undefined && b.noNewline && step.b === b.lines.length - 1
    return {
      op: step.op,
      text: step.a !== undefined ? a.lines[step.a] : b.lines[step.b!],
      ...(step.a !== undefined ? { oldLine: step.a + 1 } : {}),
      ...(step.b !== undefined ? { newLine: step.b + 1 } : {}),
      ...(lastOld || lastNew ? { noNewline: true as const } : {}),
    }
  })
  const hunks = hunksOf(lines, context)
  const added = lines.filter((line) => line.op === 'add').length
  const removed = lines.filter((line) => line.op === 'remove').length
  return { equal: added === 0 && removed === 0, added, removed, hunks, unified: unifiedOf(hunks, options.fromLabel ?? 'a', options.toLabel ?? 'b') }
}
