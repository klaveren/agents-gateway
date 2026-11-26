import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, openSync, readSync, readdirSync, readFileSync, closeSync, rmSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/** O que um comando deixou: a saída (inteira até o teto em memória), o código e se estourou o tempo. */
export interface IRunResult {
  code: number | null
  signal?: string
  output: string
  timedOut: boolean
  /** O arquivo com a saída inteira (o da memória pode ter sido cortado no começo). */
  logFile?: string
}

export interface IRunOptions {
  cwd: string
  env: Record<string, string>
  shell: string
  timeoutMs: number
  logFile?: string
  /** Chamado quando o processo sai (para soltar o token de rede, o kit SSH). */
  onExit?: () => void
}

/** Quanto da saída fica na memória (o resto, só no log). */
const MEMORY_BYTES = 8 * 1024 * 1024
/** O teto do log de UM comando em bytes (`BASH_LOG_MAX_BYTES`): passou, o resto não é gravado e o log diz isso. */
const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024
export const logMaxBytes = (): number => positiveInt(process.env.BASH_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES)

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Depois do SIGTERM, quanto se espera antes do SIGKILL. */
const KILL_GRACE_MS = 5000

/**
 * Os pares `pid → ppid` da máquina. Linux: o `/proc` (o pod não tem `ps`). macOS: `ps -A -o pid=,ppid=`.
 * Falhou a leitura: vazio (sobra matar o grupo, como antes).
 */
export function processTable(): Map<number, number> {
  const table = new Map<number, number>()
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
        // `pid (nome) estado ppid …`: o nome pode ter espaço e parêntese; o ppid vem depois do ÚLTIMO `)`.
        const ppid = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '', 10)
        if (Number.isFinite(ppid)) table.set(Number(name), ppid)
      } catch {
        /* saiu no meio da leitura */
      }
    }
    if (table.size > 0) return table
  } catch {
    /* sem `/proc`: macOS */
  }
  try {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).split('\n')) {
      const [pid, ppid] = line
        .trim()
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 10))
      if (Number.isFinite(pid) && Number.isFinite(ppid)) table.set(pid, ppid)
    }
  } catch {
    /* sem `ps` */
  }
  return table
}

/** Os descendentes (filhos, netos…) das raízes, sem as raízes. */
export function descendantsOf(roots: Iterable<number>, table: Map<number, number> = processTable()): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, ppid] of table) if (pid !== ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid])
  const seen = new Set<number>(roots)
  const queue = [...seen]
  const found: number[] = []
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig)
    return true
  } catch {
    return false
  }
}

/**
 * ⛔ A ÁRVORE CONGELADA: lida com tudo andando, um processo que cria um filho no meio da leitura deixa o filho de fora — e
 * ele escapa, órfão, quando o pai morre. Congela (SIGSTOP) o grupo e cada descendente visto e relê até a árvore parar de
 * crescer: parado, ninguém cria filho novo. Quem chama manda o SIGTERM e depois o SIGCONT.
 */
function frozenTree(pid: number): number[] {
  signal(-pid, 'SIGSTOP')
  signal(pid, 'SIGSTOP')
  const frozen = new Set<number>()
  for (let round = 0; round < 10; round += 1) {
    const fresh = descendantsOf([pid]).filter((child) => !frozen.has(child))
    if (fresh.length === 0) break
    for (const child of fresh) {
      signal(child, 'SIGSTOP')
      frozen.add(child)
    }
  }
  return [...frozen]
}

/**
 * ⛔ O GRUPO E A ÁRVORE: matar só o filho deixava o `sleep` neto vivo; matar só o grupo deixava quem abriu grupo ou
 * sessão própria (`setsid`, `detached` — o `validate-all.mjs` do `pnpm validate` seguiu 1 h). A árvore é lida ANTES do
 * SIGTERM: morto o pai, o neto vai para o `init` e some dela. No fim da graça, SIGKILL no grupo, em quem foi visto e em
 * quem esses abriram depois. ⚖️ Nada fora da árvore do pid.
 */
export function killGroup(pid: number | undefined): void {
  if (!pid) return
  const tree = frozenTree(pid)
  const group = signal(-pid, 'SIGTERM')
  const leader = group || signal(pid, 'SIGTERM')
  for (const child of tree) signal(child, 'SIGTERM')
  // Congelados, não tratavam o SIGTERM: voltam a andar só agora, já com ele pendente.
  signal(-pid, 'SIGCONT')
  for (const child of tree) signal(child, 'SIGCONT')
  if (!leader && tree.length === 0) return
  setTimeout(() => {
    // O pid só entra se o grupo dele ainda existe: saído, o número pode ter ido para outro processo.
    const known = signal(-pid, 'SIGKILL') ? [pid, ...tree] : tree
    for (const target of new Set([...tree, ...descendantsOf(known)])) signal(target, 'SIGKILL')
  }, KILL_GRACE_MS).unref()
}

interface IStarted {
  pid?: number
  done: Promise<IRunResult>
}

/**
 * Roda a linha (já cercada) no shell, num GRUPO DE PROCESSOS próprio, com a saída lida em fluxo (sem o teto de 1 MiB do
 * `exec`): o stdout e o stderr juntos, na ordem em que saem, como no terminal. Estourou o tempo: SIGTERM no grupo e,
 * se não sair, SIGKILL.
 */
export function startCommand(line: string, options: IRunOptions): IStarted {
  // `exec 2>&1`: stdout e stderr num canal só, na ordem em que saem (em dois canais a ordem entre eles se perde).
  const child = spawn(options.shell, ['-c', `exec 2>&1; ${line}`], { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log: WriteStream | undefined
  if (options.logFile) {
    mkdirSync(join(options.logFile, '..'), { recursive: true, mode: 0o700 })
    log = createWriteStream(options.logFile, { mode: 0o600 })
  }
  let output = ''
  // ⛔ O log tem teto: um `yes` ou um servidor falante enchia o disco. Passou, grava o aviso uma vez e para (a memória segue com o fim).
  const cap = logMaxBytes()
  let logged = 0
  const write = (chunk: Buffer) => {
    if (!log || logged > cap) return
    if (logged + chunk.length > cap) {
      log.write(chunk.subarray(0, cap - logged))
      log.write(`\n…[log cortado em ${cap} bytes: o resto da saída não é gravado]…\n`)
      logged = cap + 1
      return
    }
    log.write(chunk)
    logged += chunk.length
  }
  const take = (chunk: Buffer) => {
    write(chunk)
    output += chunk.toString('utf8')
    // A memória guarda o FIM: é onde está o erro. O começo segue no log.
    if (output.length > MEMORY_BYTES) output = output.slice(output.length - MEMORY_BYTES)
  }
  child.stdout?.on('data', take)
  child.stderr?.on('data', take)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child.pid)
  }, options.timeoutMs)
  timer.unref()
  const done = new Promise<IRunResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      options.onExit?.()
      const result = { code, ...(signal ? { signal } : {}), output, timedOut, ...(options.logFile ? { logFile: options.logFile } : {}) }
      // ⛔ Só resolve com o log gravado: o `bash_logs` lê o arquivo logo depois, e `end()` sozinho deixava o fim na fila.
      if (log) log.end(() => resolve(result))
      else resolve(result)
    }
    child.on('close', finish)
    child.on('error', (error) => {
      output += `${error.message}\n`
      finish(null, null)
    })
  })
  return { ...(child.pid ? { pid: child.pid } : {}), done }
}

/**
 * A saída que vai ao modelo: inteira se cabe; senão o COMEÇO (20%) e o FIM (80%), com o que saiu do meio dito — e onde
 * ler o resto. O fim pesa mais porque é onde o build e o teste dizem o que falhou.
 */
export function clipOutput(output: string, maxChars: number, logHint?: string): string {
  if (output.length <= maxChars) return output
  const head = Math.floor(maxChars * 0.2)
  const tail = maxChars - head
  const omitted = output.length - head - tail
  return `${output.slice(0, head)}\n…[${omitted} caracteres omitidos${logHint ? `; ${logHint}` : ''}]…\n${output.slice(output.length - tail)}`
}

export type TProcessStatus = 'running' | 'exited' | 'stopped' | 'timed-out'

export interface IProcessEntry {
  id: string
  sessionId: string
  name: string
  command: string
  background: boolean
  startedAt: Date
  status: TProcessStatus
  code?: number | null
  logFile?: string
  pid?: number
}

/** O fim do arquivo de log, em linhas (sem ler o arquivo inteiro). */
export function tailOf(file: string, lines: number, maxBytes = 512 * 1024): string {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return ''
  }
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  return buffer
    .toString('utf8')
    .split('\n')
    .slice(-lines - 1)
    .join('\n')
}

export const BACKGROUND_LIMITS = { perSession: 5, lifetimeMs: 8 * 60 * 60 * 1000 } as const

/** O teto de processos em segundo plano do GATEWAY inteiro (`BACKGROUND_MAX_PROCESSES`): o por conversa sozinho não segura muitas conversas. */
export const backgroundMaxProcesses = (): number => positiveInt(process.env.BACKGROUND_MAX_PROCESSES, 30)

/**
 * Os processos de cada conversa: os em segundo plano (`bash_start`) e os logs dos comandos que passaram do corte. ⛔ Cada
 * conversa só vê os seus, e todos morrem com ela, com o gateway e depois de 8 h.
 */
export class BackgroundProcesses {
  private readonly entries = new Map<string, IProcessEntry>()
  /** As vagas guardadas por conversa: comandos em preparação, ainda sem processo (`reserve`). */
  private readonly pending = new Map<string, number>()

  constructor() {
    process.once('exit', () => this.stopAll())
  }

  newId(): string {
    return randomBytes(5).toString('hex')
  }

  /** Um comando em primeiro plano que deixou log (o `bash_logs` lê). */
  remember(entry: Omit<IProcessEntry, 'status' | 'background'> & { code: number | null; timedOut: boolean }): void {
    this.entries.set(entry.id, { ...entry, background: false, status: entry.timedOut ? 'timed-out' : 'exited' })
    this.prune()
  }

  running(sessionId: string): IProcessEntry[] {
    return this.list(sessionId).filter((entry) => entry.background && entry.status === 'running')
  }

  /**
   * ⛔ Guarda a vaga ANTES de preparar o comando: a preparação espera (cerco, permissão), e várias chamadas juntas
   * passariam todas pela conta antes de a primeira registrar o processo. Devolve quem solta a vaga (o processo já
   * registrado conta por si), ou qual teto estourou.
   */
  reserve(sessionId: string): (() => void) | 'session' | 'total' {
    const waiting = this.pending.get(sessionId) ?? 0
    if (this.running(sessionId).length + waiting >= BACKGROUND_LIMITS.perSession) return 'session'
    const allWaiting = [...this.pending.values()].reduce((sum, count) => sum + count, 0)
    if (this.runningTotal() + allWaiting >= backgroundMaxProcesses()) return 'total'
    this.pending.set(sessionId, waiting + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.pending.get(sessionId) ?? 1) - 1
      if (left > 0) this.pending.set(sessionId, left)
      else this.pending.delete(sessionId)
    }
  }

  /** Quantos rodam agora, de todas as conversas (o teto global). */
  runningTotal(): number {
    return [...this.entries.values()].filter((entry) => entry.background && entry.status === 'running').length
  }

  list(sessionId: string): IProcessEntry[] {
    return [...this.entries.values()].filter((entry) => entry.sessionId === sessionId)
  }

  get(sessionId: string, id: string): IProcessEntry | undefined {
    const entry = this.entries.get(id)
    return entry?.sessionId === sessionId ? entry : undefined
  }

  /** Começa em segundo plano. Quem chama já conferiu o teto (`running`). */
  start(sessionId: string, id: string, name: string, command: string, line: string, options: Omit<IRunOptions, 'timeoutMs'>): IProcessEntry {
    const started = startCommand(line, { ...options, timeoutMs: BACKGROUND_LIMITS.lifetimeMs })
    const entry: IProcessEntry = {
      id,
      sessionId,
      name,
      command,
      background: true,
      startedAt: new Date(),
      status: 'running',
      ...(options.logFile ? { logFile: options.logFile } : {}),
      ...(started.pid ? { pid: started.pid } : {}),
    }
    this.entries.set(id, entry)
    void started.done.then((result) => {
      if (entry.status === 'running') entry.status = result.timedOut ? 'timed-out' : 'exited'
      entry.code = result.code
      this.prune()
    })
    return entry
  }

  stop(sessionId: string, id: string): IProcessEntry | undefined {
    const entry = this.get(sessionId, id)
    if (!entry || entry.status !== 'running') return entry
    entry.status = 'stopped'
    killGroup(entry.pid)
    return entry
  }

  /** A conversa acabou (apagada): os processos dela vão junto. */
  stopSession(sessionId: string): void {
    for (const entry of this.running(sessionId)) this.stop(sessionId, entry.id)
    // Os logs dela vão junto: a conversa não existe mais para ler.
    for (const entry of this.list(sessionId)) {
      this.entries.delete(entry.id)
      if (entry.logFile) rmSync(entry.logFile, { force: true })
    }
  }

  stopAll(): void {
    for (const entry of this.entries.values()) if (entry.background && entry.status === 'running') killGroup(entry.pid)
  }

  /** Guarda os 500 mais recentes que já acabaram (os rodando nunca saem). */
  private prune(): void {
    const finished = [...this.entries.values()].filter((entry) => entry.status !== 'running')
    for (const entry of finished.slice(0, Math.max(0, finished.length - 500))) {
      this.entries.delete(entry.id)
      // O log vai junto: podar só da memória deixava o arquivo (e o que ele guarda) no disco para sempre.
      if (entry.logFile) rmSync(entry.logFile, { force: true })
    }
  }
}

let shared: BackgroundProcesses | undefined
export function backgroundProcesses(): BackgroundProcesses {
  shared ??= new BackgroundProcesses()
  return shared
}
