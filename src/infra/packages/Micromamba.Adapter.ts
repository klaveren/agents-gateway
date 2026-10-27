import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dataDir, isWritable } from '@infra/adapters/support/Subscription.Workspace'

const run = promisify(execFile)
const TIMEOUT_MS = 10 * 60_000
const SEARCH_TIMEOUT_MS = 2 * 60_000
const LOG_LINES = 40
const SEARCH_LIMIT = 30
const CHANNEL = 'conda-forge'

export const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/
export const PACKAGE_VERSION = /^[\w.*+!-]{1,40}$/

export interface IPackageHit {
  name: string
  version: string
  license?: string
}

export interface IInstalledPackage {
  name: string
  version: string
  /** Pedido por quem administra (e não trazido como dependência). */
  explicit: boolean
}

export interface IPackageResult {
  ok: boolean
  log: string
}

/** Onde ficam as ferramentas: `<dados>/tools` (no pod, o PVC — sobrevive ao restart). O `bin` dele entra no PATH. */
export const toolsPrefix = (env: NodeJS.ProcessEnv = process.env) => join(dataDir(env), 'tools')
const mambaRoot = (env: NodeJS.ProcessEnv = process.env) => join(dataDir(env), 'mamba')

/**
 * ⚖️ PÕE AS FERRAMENTAS NO PATH DO PRÓPRIO GATEWAY, no boot: o `run_bash`, os clientes de assinatura, o
 * Bash do SDK e os MCPs `process` derivam o PATH deste processo — todos passam a ver o que a guia Pacotes
 * instalou, sem cada um saber dela.
 */
export function addToolsToPath(env: NodeJS.ProcessEnv = process.env): void {
  const bin = join(toolsPrefix(env), 'bin')
  const parts = (env.PATH ?? '').split(delimiter).filter(Boolean)
  if (!parts.includes(bin)) env.PATH = [bin, ...parts].join(delimiter)
}

/**
 * Instala ferramentas (git, curl, jq, ffmpeg…) do conda-forge pelo micromamba, SEM ROOT, numa pasta do
 * gateway.
 *
 * ⚖️ POR QUE MICROMAMBA: no pod não há root e o disco do sistema é só leitura — `apt` não roda, e o que se
 * instalasse à mão sumiria no reboot. O micromamba instala binários autocontidos (com as bibliotecas deles)
 * numa pasta qualquer, e a pasta é o PVC. ⛔ O ambiente dele não herda o `.env` do gateway.
 */
export class MicromambaAdapter {
  private busy?: string

  constructor(
    private readonly bin: string = process.env.MICROMAMBA_BIN?.trim() || 'micromamba',
    private readonly prefix: string = toolsPrefix(),
    private readonly root: string = mambaRoot(),
  ) {}

  /** O micromamba responde? A tela avisa quando não. */
  async available(): Promise<{ available: boolean; version?: string }> {
    return this.exec(['--version'], 15_000).then(
      ({ stdout }) => ({ available: true, version: stdout.trim() }),
      () => ({ available: false }),
    )
  }

  /** `*termo*` no conda-forge: um resultado por nome (a versão mais nova), o nome exato primeiro. */
  async search(query: string): Promise<IPackageHit[]> {
    const term = query.trim().toLowerCase()
    if (!PACKAGE_NAME.test(term)) return []
    const { stdout } = await this.exec(['search', '-c', CHANNEL, '--override-channels', '--json', `*${term}*`], SEARCH_TIMEOUT_MS)
    return rankHits(parseSearch(stdout), term).slice(0, SEARCH_LIMIT)
  }

  async list(): Promise<IInstalledPackage[]> {
    if (!existsSync(join(this.prefix, 'conda-meta'))) return []
    const [listed, history] = await Promise.all([
      this.exec(['list', '-p', this.prefix, '--json'], 60_000),
      this.exec(['env', 'export', '-p', this.prefix, '--from-history', '--json'], 60_000),
    ])
    return parseInstalled(listed.stdout, history.stdout)
  }

  async install(name: string, version?: string): Promise<IPackageResult> {
    if (!PACKAGE_NAME.test(name)) throw new Error(`not a package name: ${name}`)
    if (version !== undefined && !PACKAGE_VERSION.test(version)) throw new Error(`not a version: ${version}`)
    const spec = version ? `${name}=${version}` : name
    return this.exclusive(`install ${spec}`, async () => {
      // A primeira instalação cria o ambiente; as seguintes instalam nele.
      const verb = existsSync(join(this.prefix, 'conda-meta')) ? 'install' : 'create'
      return this.mutate([verb, '-y', '-p', this.prefix, '-c', CHANNEL, '--override-channels', spec])
    })
  }

  async remove(name: string): Promise<IPackageResult> {
    if (!PACKAGE_NAME.test(name)) throw new Error(`not a package name: ${name}`)
    return this.exclusive(`remove ${name}`, () => this.mutate(['remove', '-y', '-p', this.prefix, name]))
  }

  /** ⛔ UMA OPERAÇÃO POR VEZ: duas transações no mesmo ambiente brigam pelo lock e uma falha no meio. */
  private async exclusive(label: string, work: () => Promise<IPackageResult>): Promise<IPackageResult> {
    if (this.busy) throw new PackageBusyError(this.busy)
    this.busy = label
    try {
      return await work()
    } finally {
      this.busy = undefined
    }
  }

  private async mutate(args: string[]): Promise<IPackageResult> {
    try {
      const out = await this.exec(args, TIMEOUT_MS)
      return { ok: true, log: tail(`${out.stdout}${out.stderr}`) }
    } catch (error: unknown) {
      const failure = error as { stdout?: string; stderr?: string; message?: string }
      return { ok: false, log: tail(`${failure.stdout ?? ''}${failure.stderr ?? ''}` || (failure.message ?? String(error))) }
    }
  }

  private exec(args: string[], timeout: number) {
    const env: Record<string, string> = { ...getDefaultEnvironment(), MAMBA_ROOT_PREFIX: this.root, CONDA_PKGS_DIRS: join(this.root, 'pkgs'), MAMBA_NO_BANNER: '1' }
    // ⚠️ O micromamba guarda o índice do conda-forge em `~/.cache`; no pod o HOME é só leitura. Sem HOME
    // gravável, o HOME dele é a própria pasta do micromamba (no PVC: o índice também sobrevive ao reboot).
    if (!isWritable(env.HOME)) {
      mkdirSync(this.root, { recursive: true })
      env.HOME = this.root
    }
    return run(this.bin, args, { env, timeout, maxBuffer: 64 * 1024 * 1024 })
  }
}

export class PackageBusyError extends Error {
  constructor(readonly operation: string) {
    super(`another package operation is running: ${operation}`)
  }
}

interface ISearchRecord {
  name?: string
  version?: string
  license?: string
  timestamp?: number
}

/** O JSON do `micromamba search`: um registro por build. Fica o mais recente de cada nome. */
export function parseSearch(stdout: string): IPackageHit[] {
  const records = ((JSON.parse(stdout) as { result?: { pkgs?: ISearchRecord[] } }).result?.pkgs ?? []).filter((record) => record.name && record.version)
  const newest = new Map<string, ISearchRecord>()
  for (const record of records) {
    const current = newest.get(record.name!)
    if (!current || (record.timestamp ?? 0) > (current.timestamp ?? 0)) newest.set(record.name!, record)
  }
  return [...newest.values()].map((record) => ({ name: record.name!, version: record.version!, ...(record.license ? { license: record.license } : {}) }))
}

/** O nome exato, depois os que começam com o termo, depois o resto — cada grupo em ordem alfabética. */
export function rankHits(hits: IPackageHit[], term: string): IPackageHit[] {
  const rank = (name: string) => (name === term ? 0 : name.startsWith(term) ? 1 : 2)
  return [...hits].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}

/** `list --json` traz tudo; o histórico (`env export --from-history`) diz o que foi pedido. */
export function parseInstalled(listed: string, history: string): IInstalledPackage[] {
  const packages = (JSON.parse(listed) as { packages?: Array<{ name: string; version: string }> } | Array<{ name: string; version: string }>) ?? []
  const all = Array.isArray(packages) ? packages : (packages.packages ?? [])
  const requested = new Set(((JSON.parse(history) as { dependencies?: string[] }).dependencies ?? []).map((spec) => spec.split(/[=<>!~\s]/)[0].toLowerCase()))
  return all.map((entry) => ({ name: entry.name, version: entry.version, explicit: requested.has(entry.name.toLowerCase()) })).sort((a, b) => a.name.localeCompare(b.name))
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-LOG_LINES).join('\n')
}
