import { execFile } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import type { ILocalTool, IToolResult } from './Tool.Types'

const run = promisify(execFile)

export interface IProcessInfo {
  pid: number
  ppid: number
  command: string
  /** A pasta de trabalho; vazia quando o sistema não a mostra. */
  cwd: string
}

/** O embrulho do cerco: o que roda abaixo dele saiu de um comando de agente. */
const SANDBOX_WRAPPERS = /(^|\/)(sandbox-exec|bwrap)(\s|$)/

/** A pasta está dentro da raiz (ou é ela)? */
function inside(dir: string, root: string): boolean {
  return !!dir && (dir === root || dir.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

/**
 * ⛔ QUEM O AGENTE PODE VER E PARAR: só processo com a pasta de trabalho dentro do projeto, e só se ele saiu de um comando
 * de agente, por um destes caminhos:
 * - abaixo do cerco (`sandbox-exec`/`bwrap`) de um comando deste gateway;
 * - órfão: a cadeia sobe até o sistema sem passar pelo gateway, e o primeiro dela também roda dentro do projeto (o
 *   `start.sh` que ficou para trás).
 * Ficam de fora o gateway, quem o iniciou, o executor do agente (o CLI do modelo, filho do gateway mas fora do cerco) e o
 * que a pessoa abriu (a IDE, o terminal): o primeiro da cadeia deles não roda dentro do projeto.
 */
export function eligibleProcesses(all: readonly IProcessInfo[], root: string, self: number = process.pid): IProcessInfo[] {
  const byPid = new Map(all.map((info) => [info.pid, info]))
  const chainOf = (pid: number): IProcessInfo[] => {
    const chain: IProcessInfo[] = []
    const seen = new Set<number>()
    for (let info = byPid.get(pid); info && !seen.has(info.pid) && info.pid > 1; info = byPid.get(info.ppid)) {
      seen.add(info.pid)
      chain.push(info)
    }
    return chain
  }
  const gateway = new Set(chainOf(self).map((info) => info.pid))
  gateway.add(self)
  return all.filter((info) => {
    if (gateway.has(info.pid) || !inside(info.cwd, root)) return false
    const chain = chainOf(info.pid)
    const viaGateway = chain.findIndex((link) => link.pid === self)
    if (viaGateway >= 0) return chain.slice(0, viaGateway).some((link) => SANDBOX_WRAPPERS.test(link.command))
    if (chain.some((link) => gateway.has(link.pid))) return false
    const top = chain.at(-1)
    return !!top && inside(top.cwd, root)
  })
}

/** Os processos do usuário do servidor, com a pasta de trabalho de cada um. */
export async function processSnapshot(platform: NodeJS.Platform = process.platform): Promise<IProcessInfo[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 32 * 1024 * 1024 })
  const list = stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command!, cwd: '' }))
  if (platform === 'linux') {
    for (const info of list)
      try {
        info.cwd = readlinkSync(`/proc/${info.pid}/cwd`)
      } catch {
        // De outro usuário, ou já saiu.
      }
    return list
  }
  const cwd = new Map<number, string>()
  const { stdout: lsof } = await run('lsof', ['-a', '-d', 'cwd', '-u', String(process.getuid?.() ?? ''), '-Fpn'], { maxBuffer: 32 * 1024 * 1024 }).catch(
    (error: { stdout?: string }) => ({
      stdout: error.stdout ?? '',
    }),
  )
  let pid = 0
  for (const line of lsof.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1))
  }
  for (const info of list) info.cwd = cwd.get(info.pid) ?? ''
  return list
}

/** Os escolhidos e os descendentes deles que também são do projeto (o `start.sh` leva junto o `pnpm` e o `node`). */
export function withDescendants(picked: readonly IProcessInfo[], eligible: readonly IProcessInfo[]): IProcessInfo[] {
  const out = new Map(picked.map((info) => [info.pid, info]))
  for (let grew = true; grew;) {
    grew = false
    for (const info of eligible)
      if (!out.has(info.pid) && out.has(info.ppid)) {
        out.set(info.pid, info)
        grew = true
      }
  }
  return [...out.values()]
}

/** Uma linha por processo: pid, pai, pasta relativa ao projeto e o comando (cortado). */
export function describeProcess(info: IProcessInfo, root: string): string {
  const where = relative(root, info.cwd) || '.'
  const command = info.command.length > 200 ? `${info.command.slice(0, 200)}…` : info.command
  return `${info.pid} · pai ${info.ppid} · ${where} · ${command}`
}

export const PROCESSES_TOOL = 'processes'

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * `processes`: lista e para os processos do PROJETO (ver `eligibleProcesses`). O cerco não deixa o comando sinalizar
 * processo de fora dele, nem o `ps` rodar no Mac: o `stop.sh` que derruba o ambiente de ontem passa por aqui.
 */
export function processesTool(
  rootOf: (context: IExecutionContext | undefined) => string | undefined,
  masked: (text: string, context: IExecutionContext | undefined) => string,
  snapshot: () => Promise<IProcessInfo[]> = processSnapshot,
): ILocalTool {
  return {
    origin: 'local',
    name: PROCESSES_TOOL,
    description:
      'Lists the processes running inside this project folder that came from agent commands (dev servers, watchers, leftovers of an earlier start.sh), and stops them. Use it where ps or kill are refused in the sandbox. Without stop it only lists; with stop it sends SIGTERM (SIGKILL with force) to the matched processes and their children.',
    inputSchema: {
      type: 'object',
      properties: {
        match: { type: 'string', description: 'Only processes whose command line contains this text' },
        pids: { type: 'array', items: { type: 'number' }, description: 'Only these process ids' },
        stop: { type: 'boolean', description: 'Stop the matched processes (and their children). Needs match or pids.' },
        force: { type: 'boolean', description: 'With stop: SIGKILL instead of SIGTERM' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, context): Promise<IToolResult> {
      const root = rootOf(context)
      if (!root) return { status: 'error', result: 'Esta conversa não tem pasta de projeto: não há processos do projeto para ver.' }
      const match = typeof args.match === 'string' && args.match ? args.match : undefined
      const pids = Array.isArray(args.pids) ? args.pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 1) : undefined
      const eligible = eligibleProcesses(await snapshot(), root)
      const own = new Set(eligible.map((info) => info.pid))
      const picked = eligible.filter((info) => (!match || info.command.includes(match)) && (!pids || pids.includes(info.pid)))
      const outside = (pids ?? []).filter((pid) => !own.has(pid))
      const outsideNote = outside.length ? `\nFora do projeto (ou do gateway, ou abertos pela pessoa), não mexo: ${outside.join(', ')}.` : ''
      if (!args.stop) {
        const lines = picked.slice(0, 200).map((info) => describeProcess(info, root))
        const more = picked.length > 200 ? `\n… e mais ${picked.length - 200}.` : ''
        return { status: 'success', result: masked(`${lines.length ? lines.join('\n') : 'Nenhum processo do projeto.'}${more}${outsideNote}`, context) }
      }
      if (!match && !pids?.length) return { status: 'error', result: 'Para parar, diga quais: match (um trecho do comando) ou pids.' }
      const targets = withDescendants(picked, eligible)
      if (!targets.length) return { status: 'success', result: `Nenhum processo do projeto bate com o pedido.${outsideNote}` }
      const signal = args.force ? 'SIGKILL' : 'SIGTERM'
      for (const info of targets)
        try {
          process.kill(info.pid, signal)
        } catch {
          // Já saiu.
        }
      for (let tries = 0; tries < 10 && targets.some((info) => alive(info.pid)); tries++) await wait(300)
      const left = targets.filter((info) => alive(info.pid))
      const report = [
        `${signal} para ${targets.length} processo(s) do projeto; ${targets.length - left.length} saíram.`,
        ...(left.length ? [`Seguem vivos (use force): ${left.map((info) => info.pid).join(', ')}.`] : []),
      ].join('\n')
      return { status: left.length ? 'error' : 'success', result: masked(`${report}${outsideNote}`, context) }
    },
  }
}
