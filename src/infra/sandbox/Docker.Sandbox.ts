import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { EGRESS_PORT, egressProxySource } from './Egress.Proxy'

const run = promisify(execFile)

/** O rótulo de tudo que o gateway cria no Docker — é por ele que os órfãos são limpos no boot. */
export const SANDBOX_LABEL = 'gateway.mcp'
export const PROXY_IMAGE = 'node:22-alpine'

/**
 * De QUAL gateway é cada contêiner: dois gateways no mesmo Docker (produção e teste) não podem limpar os
 * órfãos um do outro. Sai da porta e do banco — o que distingue as instâncias.
 */
export function sandboxOwner(env: NodeJS.ProcessEnv = process.env): string {
  return createHash('sha256')
    .update(`${env.PORT ?? '3000'}\u0000${env.CONVERSATIONS_DB ?? ''}`)
    .digest('hex')
    .slice(0, 12)
}
const OWNER_LABEL = `${SANDBOX_LABEL}.owner`
const ownerLabel = () => `${OWNER_LABEL}=${sandboxOwner()}`

/** O que define UM contêiner de MCP. Só campos que não abrem o contêiner: as travas não são configuráveis. */
export interface IContainerSpec {
  image: string
  args: string[]
  /** Caminhos graváveis (tmpfs, só em memória); o resto do disco do contêiner é só leitura. */
  writable: string[]
  memoryMb: number
  cpus: number
  /** Nomes das variáveis repassadas. ⛔ O VALOR vai pelo ambiente do processo `docker`, nunca na linha de comando. */
  envNames: string[]
  network: { mode: 'none' } | { mode: 'allowlist'; name: string; proxyUrl: string }
  /** Para os rótulos e o nome: de que servidor e de que instância. */
  serverId: string
  instance: string
}

/**
 * Os argumentos do `docker run` de um MCP.
 *
 * ⛔ AS TRAVAS SÃO FIXAS, e nenhuma vem do cadastro: disco só leitura, sem capacidades, sem escalar
 * privilégio, limite de processos, memória e CPU, `--init`. Não há volume, porta publicada, `--privileged`
 * nem rede do host — o contêiner não vê o disco, o `.env`, as chaves nem a rede do servidor.
 */
export function containerArgs(spec: IContainerSpec): string[] {
  const args = [
    'run',
    '-i',
    '--rm',
    '--init',
    '--name',
    `gw-mcp-${spec.serverId}-${spec.instance}`,
    '--label',
    `${SANDBOX_LABEL}=${spec.serverId}`,
    '--label',
    ownerLabel(),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    `${spec.memoryMb}m`,
    '--cpus',
    String(spec.cpus),
    '--tmpfs',
    '/tmp:rw,size=256m,mode=1777',
  ]
  for (const path of spec.writable) if (path !== '/tmp') args.push('--tmpfs', `${path}:rw,size=256m,mode=1777`)

  if (spec.network.mode === 'none') args.push('--network', 'none')
  else {
    args.push('--network', spec.network.name)
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) args.push('-e', `${name}=${spec.network.proxyUrl}`)
    args.push('-e', 'NO_PROXY=', '-e', 'no_proxy=')
  }
  for (const name of spec.envNames) args.push('-e', name)

  args.push(spec.image, ...spec.args.map((arg) => (spec.network.mode === 'allowlist' ? arg.replaceAll('{proxy}', spec.network.proxyUrl) : arg)))
  return args
}

/** Um nome curto e único por instância (nome de contêiner e de rede). */
export function instanceName(): string {
  return randomBytes(5).toString('hex')
}

/**
 * A rede de UMA instância com `allowlist`: `--internal` (sem saída nenhuma) e o proxy nosso, ligado a ela e
 * à bridge — a única porta para fora, com a lista de domínios daquela conversa.
 */
export async function openEgress(serverId: string, instance: string, allowedHosts: readonly string[]): Promise<{ name: string; proxyUrl: string; close: () => Promise<void> }> {
  const network = `gw-mcp-net-${serverId}-${instance}`
  const proxy = `gw-mcp-egress-${serverId}-${instance}`
  const close = async () => {
    await run('docker', ['rm', '-f', proxy]).catch(() => undefined)
    await run('docker', ['network', 'rm', network]).catch(() => undefined)
  }

  try {
    await run('docker', ['network', 'create', '--internal', '--label', `${SANDBOX_LABEL}=${serverId}`, '--label', ownerLabel(), network])
    await run(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        proxy,
        '--label',
        `${SANDBOX_LABEL}=${serverId}`,
        '--label',
        ownerLabel(),
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '128m',
        '-e',
        'GW_EGRESS',
        '-e',
        'ALLOWED_HOSTS',
        PROXY_IMAGE,
        'node',
        '-e',
        'eval(process.env.GW_EGRESS)',
      ],
      { env: { ...process.env, GW_EGRESS: egressProxySource(), ALLOWED_HOSTS: JSON.stringify(allowedHosts) } },
    )
    await run('docker', ['network', 'connect', network, proxy])
    await waitForProxy(proxy)
    return { name: network, proxyUrl: `http://${proxy}:${EGRESS_PORT}`, close }
  } catch (error: unknown) {
    await close()
    throw error
  }
}

async function waitForProxy(proxy: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { stdout } = await run('docker', ['logs', proxy]).catch(() => ({ stdout: '' }))
    if (stdout.includes('egress ready')) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('egress proxy did not start')
}

/** Remove contêineres e redes que um processo anterior DESTE gateway deixou (queda, reinício). */
export async function cleanupOrphans(): Promise<void> {
  const containers = await run('docker', ['ps', '-aq', '--filter', `label=${ownerLabel()}`]).catch(() => ({ stdout: '' }))
  const ids = containers.stdout.split('\n').filter(Boolean)
  if (ids.length) await run('docker', ['rm', '-f', ...ids]).catch(() => undefined)
  const networks = await run('docker', ['network', 'ls', '-q', '--filter', `label=${ownerLabel()}`]).catch(() => ({ stdout: '' }))
  const nets = networks.stdout.split('\n').filter(Boolean)
  if (nets.length) await run('docker', ['network', 'rm', ...nets]).catch(() => undefined)
}

export interface IDockerStatus {
  available: boolean
  /** Sem Docker: o motivo, para a tela dizer (ex.: "cliente docker não instalado neste servidor"). */
  reason?: string
}

const DOCKER_CHECK_TTL_MS = 30_000
let lastCheck: { at: number; status: Promise<IDockerStatus> } | undefined

/**
 * O Docker responde AQUI? É do que o MCP "Contêiner isolado" precisa; a tela desliga a opção quando não.
 * ⚖️ Guardado por 30s: a página de configurações e a de MCPs perguntam a cada abertura, e o Docker do Mac pode
 * subir depois do gateway. No pod não há cliente nem socket — e dar o socket ao pod seria dar root no nó.
 */
export function dockerStatus(now = Date.now()): Promise<IDockerStatus> {
  if (lastCheck && now - lastCheck.at < DOCKER_CHECK_TTL_MS) return lastCheck.status
  const status = run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5_000 }).then(
    (): IDockerStatus => ({ available: true }),
    (error: NodeJS.ErrnoException & { stderr?: string }): IDockerStatus => ({
      available: false,
      reason:
        error.code === 'ENOENT'
          ? 'cliente docker não instalado neste servidor'
          : /connect|daemon|socket/i.test(`${error.stderr ?? ''}${error.message}`)
            ? 'o Docker não responde neste servidor (sem daemon ou sem acesso ao socket)'
            : (error.stderr || error.message).trim().split('\n').pop()?.slice(0, 200),
    }),
  )
  lastCheck = { at: now, status }
  return status
}
