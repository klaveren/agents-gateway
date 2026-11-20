import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * ⌨️ O TERMINAL LOCAL, como abrir o Terminal do Mac: o shell de login da pessoa (`$SHELL -l`), com ambiente LIMPO —
 * nada do processo do gateway (chaves, `.env`, config) — e o perfil dela recarregado pelo próprio shell.
 *
 * ⛔ Só existe quando a tela e o gateway estão na MESMA máquina (o app do Mac): quem decide é o controller
 * (`fromThisMachine`). Não é terminal de servidor: na .4 (ou pela rede) ele não abre.
 */
export interface ITerminalSession {
  id: string
  title: string
  cwd: string
  startedAt: string
  exited?: number
}

type TListener = (event: { type: 'data'; data: string } | { type: 'exit'; code: number }) => void

interface IPty {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}
interface IPtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): IPty
}

/** O que o terminal guarda para quem reabre a coluna (o fim do que saiu). */
const SCROLLBACK = 200_000
/** Sem ninguém olhando por tanto tempo, o shell é encerrado. */
const IDLE_MS = 30 * 60_000
const MAX_SESSIONS = 8

interface IEntry {
  session: ITerminalSession
  pty: IPty
  buffer: string
  listeners: Set<TListener>
  idle?: NodeJS.Timeout
}

let ptyModule: IPtyModule | null | undefined

/** O node-pty (nativo: só onde há binário pronto, o Mac). `null`: indisponível aqui. */
export function loadPty(): IPtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    const require = createRequire(__filename)
    const root = dirname(require.resolve('node-pty/package.json'))
    // ⚠️ O pnpm não roda o script de instalação: o `spawn-helper` pronto vem sem o bit de execução, e o spawn falha.
    const helper = join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    if (existsSync(helper)) {
      try {
        accessSync(helper, constants.X_OK)
      } catch {
        chmodSync(helper, statSync(helper).mode | 0o111)
      }
    }
    ptyModule = require('node-pty') as IPtyModule
  } catch (error: unknown) {
    console.warn('[terminal] node-pty indisponível:', error instanceof Error ? error.message : error)
    ptyModule = null
  }
  return ptyModule
}

/** O ambiente de um terminal novo: só o mínimo para o shell de login montar o resto (perfil, PATH, aliases). */
export function cleanEnv(user = userInfo(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    HOME: user.homedir,
    USER: user.username,
    LOGNAME: user.username,
    SHELL: loginShell(user, env),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: env.LANG && /^[\w.@-]+$/.test(env.LANG) ? env.LANG : 'en_US.UTF-8',
    TERM_PROGRAM: 'AgentsGateway',
  }
}

export function loginShell(user = userInfo(), env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [user.shell, env.SHELL, '/bin/zsh', '/bin/bash']
  return candidates.find((shell): shell is string => !!shell && shell.startsWith('/') && existsSync(shell)) ?? '/bin/sh'
}

export class LocalTerminals {
  private readonly entries = new Map<string, IEntry>()

  available(): boolean {
    return !!loadPty()
  }

  list(): ITerminalSession[] {
    return [...this.entries.values()].map((entry) => entry.session)
  }

  open(options: { cwd?: string; cols: number; rows: number }): ITerminalSession {
    const pty = loadPty()
    if (!pty) throw new Error('terminal unavailable on this machine')
    if (this.entries.size >= MAX_SESSIONS) throw new Error(`too many terminals open (${MAX_SESSIONS})`)
    const user = userInfo()
    const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : user.homedir
    const shell = loginShell(user)
    const process = pty.spawn(shell, ['-l'], { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd, env: cleanEnv(user) })
    const session: ITerminalSession = { id: randomBytes(9).toString('base64url'), title: shell.split('/').pop() ?? 'shell', cwd, startedAt: new Date().toISOString() }
    const entry: IEntry = { session, pty: process, buffer: '', listeners: new Set() }
    process.onData((data) => {
      entry.buffer = (entry.buffer + data).slice(-SCROLLBACK)
      for (const listener of entry.listeners) listener({ type: 'data', data })
    })
    process.onExit(({ exitCode }) => {
      session.exited = exitCode
      for (const listener of entry.listeners) listener({ type: 'exit', code: exitCode })
      this.entries.delete(session.id)
      if (entry.idle) clearTimeout(entry.idle)
    })
    this.entries.set(session.id, entry)
    this.armIdle(entry)
    return session
  }

  private armIdle(entry: IEntry): void {
    if (entry.idle) clearTimeout(entry.idle)
    if (entry.listeners.size) return
    entry.idle = setTimeout(() => this.close(entry.session.id), IDLE_MS)
    entry.idle.unref()
  }

  /** Assina a saída: primeiro o que já saiu (para quem reabre), depois o resto. */
  watch(id: string, listener: TListener): (() => void) | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (entry.buffer) listener({ type: 'data', data: entry.buffer })
    entry.listeners.add(listener)
    this.armIdle(entry)
    return () => {
      entry.listeners.delete(listener)
      this.armIdle(entry)
    }
  }

  write(id: string, data: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.pty.resize(Math.max(2, Math.min(500, Math.round(cols))), Math.max(1, Math.min(300, Math.round(rows))))
    return true
  }

  close(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    if (entry.idle) clearTimeout(entry.idle)
    try {
      entry.pty.kill('SIGHUP')
    } catch {
      // já saiu
    }
    return true
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id)
  }
}

let shared: LocalTerminals | undefined
export const localTerminals = (): LocalTerminals => (shared ??= new LocalTerminals())

/** Desligado com `GATEWAY_LOCAL_TERMINAL=0`. */
export const localTerminalEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.GATEWAY_LOCAL_TERMINAL !== '0'
