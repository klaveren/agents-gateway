import { exec } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dataDir, projectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { esmImport } from '@infra/adapters/support/Esm.Import'
import { networkGate } from '@infra/permissions/Network.Gate'
import type { ICercoBase, ICercoPlan } from '@domain/Cerco.Plan'

const run = promisify(exec)

export interface ISandboxStatus {
  available: boolean
  mechanism: 'seatbelt' | 'bubblewrap' | 'none'
  /** Sem cerco: o erro real (ex.: "bwrap: No permissions to create new namespace"). */
  reason?: string
}

/** O que o gateway usa do `@anthropic-ai/sandbox-runtime` (o srt, o sandbox do Claude Code). */
interface ISandboxManager {
  initialize(config: Record<string, unknown>, ask?: (target: { host: string; port?: number }) => Promise<boolean>): Promise<void>
  wrapWithSandbox(command: string, binShell?: string, customConfig?: Record<string, unknown>): Promise<string>
}

/** Onde o comando embrulhado roda e quem o roda (o `run_bash`, o Bash do Claude). */
export interface IProjectSandbox {
  status(): Promise<ISandboxStatus>
  /** O comando preso à pasta do projeto. ⛔ Lança se não há cerco — quem chama recusa. */
  wrap(command: string, projectId: string): Promise<string>
  /**
   * O comando no cerco MONTADO DAS REGRAS (`Cerco.Plan`), em qualquer pasta (a do projeto ou a da conversa), com a rede
   * pela porta do gateway (`Network.Gate`) e o token do comando. ⛔ Lança se não há cerco.
   */
  wrapWith?(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string): Promise<string>
}

export const SANDBOX_UNAVAILABLE = 'cerco indisponível neste servidor'

/** O shell do comando embrulhado: o srt monta a linha para ele. */
export const SANDBOX_SHELL = '/bin/bash'

/**
 * ⛔ O CERCO DO AGENTE DE PROJETO: o comando só lê e grava na pasta do projeto (e lê as ferramentas do
 * servidor, `<dados>/tools`). O banco, as chaves, os logins, os outros projetos, o app (`.env`) e o HOME do
 * gateway ficam invisíveis. ⚖️ A rede fica LIBERADA (decisão de quem administra): o callback `ask` diz sim a
 * todo destino — o cerco é do disco.
 *
 * Mac: seatbelt (`sandbox-exec`). Linux: bubblewrap, que precisa de user namespaces — num contêiner, o
 * seccomp do pod tem de liberá-los, e o modo `enableWeakerNestedSandbox` (`SANDBOX_NESTED=1`) evita montar
 * um `/proc` novo, que o contêiner não deixa.
 */
export class ProjectSandbox implements IProjectSandbox {
  private manager?: Promise<ISandboxManager>
  private probe?: Promise<ISandboxStatus>

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly load: () => Promise<{ SandboxManager: ISandboxManager }> = () => esmImport('@anthropic-ai/sandbox-runtime'),
  ) {}

  /** A política de UM projeto: o que o comando pode ler e gravar. */
  policy(projectId: string): Record<string, unknown> {
    const project = projectWorkspace(projectId, this.env)
    return {
      ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: {
        denyRead: [dataDir(this.env), process.cwd(), homedir()],
        allowRead: [project, join(dataDir(this.env), 'tools'), ...runtimeHelpers()],
        allowWrite: [project],
        denyWrite: [],
      },
    }
  }

  /** A base do cerco de uma pasta: as de trabalho dentro dela, o que se lê sempre e o que nunca se toca. */
  base(root: string): ICercoBase {
    return {
      root,
      scratch: ['.home', '.tmp', '.cache'].map((name) => join(root, name)),
      // A instalação do Node em uso (num Mac com nvm, fica na pasta pessoal, que o cerco fecha) e as ferramentas.
      alwaysRead: [join(dataDir(this.env), 'tools'), dirname(dirname(process.execPath)), ...runtimeHelpers()],
      alwaysDeny: [dataDir(this.env), process.cwd(), homedir()],
    }
  }

  async wrapWith(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string): Promise<string> {
    const status = await this.status()
    if (!status.available) throw new Error(`${SANDBOX_UNAVAILABLE}: ${status.reason ?? 'sem motivo'}`)
    const manager = await this.ready()
    const port = await networkGate().start()
    const cerco = plan(this.base(root))
    const scratch = (name: string) => {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    }
    const home = scratch('.home')
    const cache = scratch('.cache')
    const proxy = `http://${networkToken}:x@127.0.0.1:${port}`
    const connector = writeConnector(home)
    const scoped: Record<string, string> = {
      HOME: home,
      TMPDIR: scratch('.tmp'),
      npm_config_cache: join(cache, 'npm'),
      PIP_CACHE_DIR: join(cache, 'pip'),
      UV_CACHE_DIR: join(cache, 'uv'),
      GOCACHE: join(cache, 'go'),
      // A rede: só pela porta do gateway, com o token deste comando (quem decide é a regra do agente).
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      // O `fetch` do Node só segue o proxy com isto (Node 24+).
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: '',
      no_proxy: '',
      // SSH e git por SSH: pelo CONNECT da porta, com o auxiliar (o `nc` do Mac não fala o proxy).
      GIT_SSH_COMMAND: `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='${process.execPath} ${connector} %h %p'`,
    }
    const prelude = Object.entries(scoped)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join('; ')
    return manager.wrapWithSandbox(`${prelude}; ${command}`, SANDBOX_SHELL, {
      ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: { denyRead: cerco.readDeny, allowRead: cerco.readAllow, allowWrite: cerco.writeAllow, denyWrite: cerco.writeDeny },
    })
  }

  async wrap(command: string, projectId: string): Promise<string> {
    const status = await this.status()
    if (!status.available) throw new Error(`${SANDBOX_UNAVAILABLE}: ${status.reason ?? 'sem motivo'}`)
    const project = projectWorkspace(projectId, this.env)
    // HOME, TMPDIR e caches DENTRO do projeto: os de fora estão fechados, e sem isto `npm install` falhava.
    const scratch = (name: string) => {
      const dir = join(project, name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    }
    const cache = scratch('.cache')
    const scoped = {
      HOME: scratch('.home'),
      TMPDIR: scratch('.tmp'),
      npm_config_cache: join(cache, 'npm'),
      PIP_CACHE_DIR: join(cache, 'pip'),
      UV_CACHE_DIR: join(cache, 'uv'),
      GOCACHE: join(cache, 'go'),
    }
    const prelude = Object.entries(scoped)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join('; ')
    return (await this.ready()).wrapWithSandbox(`${prelude}; ${command}`, SANDBOX_SHELL, this.policy(projectId))
  }

  /** Funciona aqui? Testado UMA vez (um `true` embrulhado), e o resultado fica. */
  status(): Promise<ISandboxStatus> {
    this.probe ??= this.check()
    return this.probe
  }

  private async check(): Promise<ISandboxStatus> {
    const mechanism = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'bubblewrap' : 'none'
    if (mechanism === 'none') return { available: false, mechanism, reason: `sem sandbox para ${process.platform}` }
    try {
      const manager = await this.ready()
      const probeDir = join(tmpdir(), 'gw-sandbox-probe')
      mkdirSync(probeDir, { recursive: true })
      const wrapped = await manager.wrapWithSandbox('true', SANDBOX_SHELL, {
        ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
        filesystem: { denyRead: [], allowWrite: [probeDir], denyWrite: [] },
      })
      await run(wrapped, { shell: SANDBOX_SHELL, timeout: 20_000 })
      return { available: true, mechanism }
    } catch (error: unknown) {
      const failure = error as { stderr?: string; message?: string }
      const reason = (failure.stderr || failure.message || String(error)).trim().split('\n').pop()?.slice(0, 300)
      console.warn(`[sandbox] ${SANDBOX_UNAVAILABLE} (${mechanism}): ${reason}. O Bash dos agentes de projeto fica bloqueado.`)
      return { available: false, mechanism, reason }
    }
  }

  private ready(): Promise<ISandboxManager> {
    this.manager ??= this.load().then(async ({ SandboxManager }) => {
      // ⛔ A rede do cerco é a PORTA DO GATEWAY (`Network.Gate`): o comando só alcança 127.0.0.1:<porta>, e cada
      // conexão é decidida pelas regras do agente do comando. Sem `ask`: nada passa por fora.
      const port = await networkGate().start()
      await SandboxManager.initialize({
        ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
        network: { allowedDomains: [], deniedDomains: [], httpProxyPort: port, socksProxyPort: port },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      })
      return SandboxManager
    })
    return this.manager
  }

  private nested(): boolean {
    return this.env.SANDBOX_NESTED === '1'
  }
}

/**
 * ⚠️ O srt roda, DENTRO do cerco, um auxiliar dele (`vendor/seccomp/<arch>/apply-seccomp`), que mora em
 * `node_modules` — dentro do app, que o cerco fecha (é onde está o `.env`). Só essa pasta é reaberta.
 */
function runtimeHelpers(): string[] {
  try {
    return [realpathSync(join(dirname(require.resolve('@anthropic-ai/sandbox-runtime')), '..', 'vendor', 'seccomp'))]
  } catch {
    return []
  }
}

/**
 * O auxiliar de ProxyCommand do SSH: abre um CONNECT na porta do gateway (com o token do `HTTPS_PROXY`) e liga a
 * entrada e a saída do ssh ao túnel. Escrito na HOME do comando (dentro do cerco), que ele pode ler.
 */
function writeConnector(home: string): string {
  const path = join(home, '.gateway-connect.cjs')
  if (!existsSync(path))
    writeFileSync(
      path,
      [
        "const net = require('net')",
        'const [host, port] = process.argv.slice(2)',
        'const proxy = new URL(process.env.HTTPS_PROXY)',
        'const socket = net.connect(Number(proxy.port), proxy.hostname, () => {',
        "  const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64')",
        "  socket.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\\r\\nHost: ' + host + ':' + port + '\\r\\nProxy-Authorization: Basic ' + auth + '\\r\\n\\r\\n')",
        '})',
        'let buffer = Buffer.alloc(0)',
        'const onHead = (chunk) => {',
        '  buffer = Buffer.concat([buffer, chunk])',
        "  const end = buffer.indexOf('\\r\\n\\r\\n')",
        '  if (end < 0) return',
        "  socket.off('data', onHead)",
        "  if (!/^HTTP\\/1\\.[01] 200/.test(buffer.toString('utf8', 0, end))) { process.stderr.write(buffer.toString('utf8', 0, end) + '\\n'); process.exit(1) }",
        '  const rest = buffer.subarray(end + 4)',
        '  if (rest.length) process.stdout.write(rest)',
        '  socket.pipe(process.stdout)',
        '  process.stdin.pipe(socket)',
        '}',
        "socket.on('data', onHead)",
        "socket.on('error', (error) => { process.stderr.write(String(error) + '\\n'); process.exit(1) })",
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
  return path
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

let shared: IProjectSandbox | undefined
/** O cerco do processo (um só: o srt é um singleton, com o proxy de rede dentro deste processo). */
export function projectSandbox(): IProjectSandbox {
  shared ??= new ProjectSandbox()
  return shared
}

/** As ferramentas de ARQUIVO do Claude e onde cada uma diz o caminho. */
export const PATH_FIELDS: Readonly<Record<string, string[]>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
  LS: ['path'],
}

/**
 * ⛔ O FILTRO DE CAMINHO das ferramentas de arquivo (não dependem do sistema operacional): todo caminho que
 * a ferramenta recebe tem de cair DENTRO da pasta do projeto, depois de resolvido (relativo ao cwd, `..`,
 * symlink). `undefined` = pode; texto = o motivo da recusa.
 */
export function projectPathIssue(projectDir: string, cwd: string, toolName: string, input: Record<string, unknown>): string | undefined {
  const fields = PATH_FIELDS[toolName]
  if (!fields) return undefined
  const root = realOrSelf(projectDir)
  for (const field of fields) {
    const value = input[field]
    if (typeof value !== 'string' || !value) continue
    // `pattern`/`glob` relativos são do próprio diretório; só o absoluto aponta para fora.
    if ((field === 'pattern' || field === 'glob') && !isAbsolute(value)) continue
    const target = realOrNearest(resolve(cwd, field === 'pattern' || field === 'glob' ? globBase(value) : value))
    const inside = relative(root, target)
    if (inside.startsWith('..') || isAbsolute(inside)) return `${toolName}: ${value} está fora da pasta do projeto`
  }
  return undefined
}

/** A parte fixa de um glob absoluto (`/etc/**\/*.conf` → `/etc`). */
function globBase(pattern: string): string {
  const parts = pattern.split('/')
  const fixed: string[] = []
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break
    fixed.push(part)
  }
  return fixed.join('/') || '/'
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Arquivo que ainda não existe (Write): o caminho real do pai mais próximo que existe, mais o resto. */
function realOrNearest(path: string): string {
  let current = path
  const rest: string[] = []
  while (!existsSync(current) && dirname(current) !== current) {
    rest.unshift(current.slice(dirname(current).length + 1))
    current = dirname(current)
  }
  return join(realOrSelf(current), ...rest)
}
