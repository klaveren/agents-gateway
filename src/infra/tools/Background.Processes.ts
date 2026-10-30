import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, openSync, readSync, closeSync, statSync, type WriteStream } from 'node:fs'
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
/** Depois do SIGTERM, quanto se espera antes do SIGKILL. */
const KILL_GRACE_MS = 5000

/** ⛔ O GRUPO INTEIRO: matar só o filho deixava o `sleep` neto (e o servidor que ele subiu) vivo. */
export function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* já saiu */
    }
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
  const take = (chunk: Buffer) => {
    log?.write(chunk)
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
      log?.end()
      options.onExit?.()
      resolve({ code, ...(signal ? { signal } : {}), output, timedOut, ...(options.logFile ? { logFile: options.logFile } : {}) })
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

/**
 * Os processos de cada conversa: os em segundo plano (`bash_start`) e os logs dos comandos que passaram do corte. ⛔ Cada
 * conversa só vê os seus, e todos morrem com ela, com o gateway e depois de 8 h.
 */
export class BackgroundProcesses {
  private readonly entries = new Map<string, IProcessEntry>()

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
  }

  stopAll(): void {
    for (const entry of this.entries.values()) if (entry.background && entry.status === 'running') killGroup(entry.pid)
  }

  /** Guarda os 500 mais recentes que já acabaram (os rodando nunca saem). */
  private prune(): void {
    const finished = [...this.entries.values()].filter((entry) => entry.status !== 'running')
    for (const entry of finished.slice(0, Math.max(0, finished.length - 500))) this.entries.delete(entry.id)
  }
}

let shared: BackgroundProcesses | undefined
export function backgroundProcesses(): BackgroundProcesses {
  shared ??= new BackgroundProcesses()
  return shared
}
