import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { IMcpProcess } from '@domain/models/McpServer.Model'
import { dataDir } from '@infra/adapters/support/Subscription.Workspace'

const run = promisify(execFile)
const INSTALL_TIMEOUT_MS = 10 * 60_000
const LOG_LINES = 40
const MANIFEST = 'gateway-install.json'

interface IInstallManifest {
  spec: string
  name: string
  version: string
  installedAt: string
}

export interface IInstallResult {
  ok: boolean
  version?: string
  log: string
}

/** Onde mora a instalação de cada MCP `process`: `<dados>/mcp/<id>` (no pod, o PVC — sobrevive ao restart). */
export const mcpRoot = (env: NodeJS.ProcessEnv = process.env) => join(dataDir(env), 'mcp')
export const installDir = (serverId: string, root = mcpRoot()) => join(root, serverId)

const installing = new Map<string, Promise<IInstallResult>>()

/**
 * `npm install` do pacote numa pasta PRÓPRIA do servidor.
 *
 * ⚖️ INSTALA AO LADO E TROCA NO FIM: um reinstall que falha (rede, versão inexistente) deixa a instalação
 * anterior de pé. ⚠️ O cache do npm vai para `<dados>/mcp/.npm`: no pod o HOME é só leitura.
 */
export function installPackage(serverId: string, spec: string, root = mcpRoot()): Promise<IInstallResult> {
  const pending = installing.get(serverId)
  if (pending) return pending
  const work = doInstall(serverId, spec, root).finally(() => installing.delete(serverId))
  installing.set(serverId, work)
  return work
}

async function doInstall(serverId: string, spec: string, root: string): Promise<IInstallResult> {
  const target = installDir(serverId, root)
  const staging = `${target}.installing`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: `gateway-mcp-${serverId}`, private: true }))

  const env = { ...getDefaultEnvironment(), npm_config_cache: join(root, '.npm'), npm_config_update_notifier: 'false' }
  let log: string
  try {
    const out = await run('npm', ['install', '--prefix', staging, '--no-audit', '--no-fund', '--omit=dev', spec], { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    log = `${out.stdout}${out.stderr}`
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true })
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, log: tail(`${failure.stdout ?? ''}${failure.stderr ?? ''}` || (failure.message ?? String(error))) }
  }

  const dependencies = (JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {}
  const name = Object.keys(dependencies)[0]
  if (!name) {
    rmSync(staging, { recursive: true, force: true })
    return { ok: false, log: tail(`${log}\nnpm installed nothing for ${spec}`) }
  }
  const version = packageJson(staging, name)?.version ?? '?'
  const manifest: IInstallManifest = { spec, name, version, installedAt: new Date().toISOString() }
  writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))

  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
  return { ok: true, version, log: tail(log) }
}

/** O que está instalado e se ainda é o pacote do cadastro (`stale`: trocaram o pacote, falta reinstalar). */
export function installStatus(
  serverId: string,
  spec: string | undefined,
  root = mcpRoot(),
): { installed: boolean; version?: string; spec?: string; installedAt?: string; stale?: boolean } {
  const manifest = readManifest(serverId, root)
  if (!manifest) return { installed: false }
  return { installed: true, version: manifest.version, spec: manifest.spec, installedAt: manifest.installedAt, ...(spec && spec !== manifest.spec ? { stale: true } : {}) }
}

/**
 * O executável: o bin do pacote instalado ou, sem pacote, o `command` como está (procurado no PATH).
 *
 * Pacote com vários bins: vale o de nome `command`; senão o de nome igual ao do pacote; senão o primeiro.
 */
export function resolveCommand(serverId: string, config: Pick<IMcpProcess, 'package' | 'command'>, root = mcpRoot()): string {
  if (!config.package) {
    if (!config.command) throw new Error('set a package or a command')
    return config.command
  }
  const manifest = readManifest(serverId, root)
  if (!manifest) throw new Error(`${config.package} is not installed yet: use Install on the MCP screen`)
  const dir = installDir(serverId, root)
  const bin = packageJson(dir, manifest.name)?.bin
  const short = manifest.name.replace(/^@[^/]+\//, '')
  const bins = typeof bin === 'string' ? { [short]: bin } : (bin ?? {})
  const names = Object.keys(bins)
  if (!names.length) throw new Error(`${manifest.name} has no executable (bin) to run`)
  const chosen = config.command ? names.find((name) => name === config.command) : (names.find((name) => name === short) ?? names[0])
  if (!chosen) throw new Error(`${manifest.name} has no bin named ${config.command}; it has ${names.join(', ')}`)
  const path = join(dir, 'node_modules', '.bin', chosen)
  if (!existsSync(path)) throw new Error(`the ${chosen} executable is missing: reinstall ${manifest.name}`)
  return path
}

export function removeInstall(serverId: string, root = mcpRoot()): void {
  rmSync(installDir(serverId, root), { recursive: true, force: true })
  rmSync(`${installDir(serverId, root)}.installing`, { recursive: true, force: true })
}

function readManifest(serverId: string, root: string): IInstallManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(installDir(serverId, root), MANIFEST), 'utf8')) as IInstallManifest
  } catch {
    return undefined
  }
}

function packageJson(prefix: string, name: string): { version?: string; bin?: string | Record<string, string> } | undefined {
  try {
    return JSON.parse(readFileSync(join(prefix, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string; bin?: string | Record<string, string> }
  } catch {
    return undefined
  }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-LOG_LINES).join('\n')
}
