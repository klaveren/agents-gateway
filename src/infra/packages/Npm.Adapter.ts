import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'
import { IInstalledPackage, IPackageHit, IPackageResult, PackageBusyError, toolsPrefix } from './Micromamba.Adapter'

const run = promisify(execFile)
const TIMEOUT_MS = 10 * 60_000
const SEARCH_TIMEOUT_MS = 60_000
const LOG_LINES = 40
const SEARCH_LIMIT = 30

/** Nome npm: com escopo (`@org/nome`) ou sem; minúsculas, como o registro exige. */
export const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/
/** ⚖️ A versão é EXATA (`2.14.1`): a aba não instala "a mais nova", que mudaria por baixo de quem usa. */
export const NPM_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

/** Onde fica: `<dados>/tools/npm` — o `bin` dele já está no PATH de todo comando (ver `Persistent.Installs`). */
export const npmPrefix = (env: NodeJS.ProcessEnv = process.env) => join(toolsPrefix(env), 'npm')

/**
 * Pacotes do REGISTRO npm (o `mongosh`, CLIs em Node) para a guia Pacotes, ao lado do conda-forge.
 *
 * ⛔ SÓ PELA GUIA (admin): o agente não grava na pasta de ferramentas. ⛔ `--ignore-scripts`: o script de instalação de
 * um pacote de terceiros não roda no servidor — quem precisa dele falha com o aviso, e a pessoa decide.
 */
export class NpmAdapter {
  private busy?: string

  constructor(
    /** O npm do MESMO Node do gateway (o PATH do serviço pode não tê-lo). */
    private readonly bin: string = process.env.NPM_BIN?.trim() || join(dirname(process.execPath), 'npm'),
    private readonly prefix: string = npmPrefix(),
  ) {}

  async available(): Promise<{ available: boolean; version?: string }> {
    return this.exec(['--version'], 30_000).then(
      ({ stdout }) => ({ available: true, version: stdout.trim() }),
      () => ({ available: false }),
    )
  }

  async search(query: string): Promise<IPackageHit[]> {
    const term = query.trim().toLowerCase()
    if (!NPM_PACKAGE_NAME.test(term)) return []
    const { stdout } = await this.exec(['search', '--json', '--searchlimit', String(SEARCH_LIMIT), term], SEARCH_TIMEOUT_MS)
    return parseNpmSearch(stdout, term)
  }

  async list(): Promise<IInstalledPackage[]> {
    if (!existsSync(join(this.prefix, 'lib', 'node_modules'))) return []
    const { stdout } = await this.exec(['ls', '-g', '--depth=0', '--json'], 60_000).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '{}' }))
    return parseNpmList(stdout)
  }

  async install(name: string, version: string): Promise<IPackageResult> {
    if (!NPM_PACKAGE_NAME.test(name)) throw new Error(`not an npm package name: ${name}`)
    if (!NPM_PACKAGE_VERSION.test(version)) throw new Error(`not an exact version: ${version}`)
    return this.exclusive(`npm install ${name}@${version}`, () => this.mutate(['install', '-g', '--ignore-scripts', '--no-fund', '--no-audit', `${name}@${version}`]))
  }

  async remove(name: string): Promise<IPackageResult> {
    if (!NPM_PACKAGE_NAME.test(name)) throw new Error(`not an npm package name: ${name}`)
    return this.exclusive(`npm uninstall ${name}`, () => this.mutate(['uninstall', '-g', name]))
  }

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
    // ⛔ O ambiente dele não herda o `.env` do gateway: só o mínimo, o destino e o cache no PVC.
    const env: Record<string, string> = {
      ...getDefaultEnvironment(),
      NPM_CONFIG_PREFIX: this.prefix,
      npm_config_cache: join(dataDir(), 'cache', 'npm'),
      npm_config_update_notifier: 'false',
    }
    return run(this.bin, args, { env, timeout, maxBuffer: 64 * 1024 * 1024 })
  }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-LOG_LINES).join('\n')
}

/** `npm search --json`: um resultado por nome, o nome exato primeiro. */
export function parseNpmSearch(stdout: string, term: string): IPackageHit[] {
  let rows: Array<{ name?: string; version?: string; license?: string }> = []
  try {
    const parsed = JSON.parse(stdout) as unknown
    rows = Array.isArray(parsed) ? (parsed as typeof rows) : []
  } catch {
    return []
  }
  const hits = rows
    .filter((row) => typeof row.name === 'string' && typeof row.version === 'string')
    .map((row) => ({ name: row.name!, version: row.version!, ...(typeof row.license === 'string' ? { license: row.license } : {}) }))
  return [...hits.filter((hit) => hit.name === term), ...hits.filter((hit) => hit.name !== term)].slice(0, SEARCH_LIMIT)
}

/** `npm ls -g --json`: o que foi instalado (sem o próprio npm, que não vem do prefixo). */
export function parseNpmList(stdout: string): IInstalledPackage[] {
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> }
    return Object.entries(parsed.dependencies ?? {})
      .filter(([name, item]) => name !== 'npm' && typeof item.version === 'string')
      .map(([name, item]) => ({ name, version: item.version!, explicit: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}
