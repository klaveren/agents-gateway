import { exec } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dataDir, projectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { esmImport } from '@infra/adapters/support/Esm.Import'

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
      await SandboxManager.initialize(
        {
          ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        },
        async () => true,
      )
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
