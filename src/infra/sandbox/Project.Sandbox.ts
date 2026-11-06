import { exec } from 'node:child_process'
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { dataDir, projectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { esmImport } from '@infra/adapters/support/Esm.Import'
import { networkGate } from '@infra/permissions/Network.Gate'
import { commandDirOf } from '@infra/accounts/Ssh.Kit'
import type { ICercoBase, ICercoPlan } from '@domain/Cerco.Plan'
import { globToRegex, pathMatches } from '@domain/Permission.Policy'
import { FILE_DIRS } from '@domain/models/ResourceFile.Model'
import { agentFolders, globalResourcesDir, projectResourceDirs, readOnlyResourceDirs } from '@infra/workspace/Resource.Files'

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
  /** Linux: os sockets da ponte do proxy, no `/tmp` do host. */
  getLinuxHttpSocketPath?(): string | undefined
  getLinuxSocksSocketPath?(): string | undefined
  /** Linux: tira do disco os arquivos vazios que o bwrap criou como ponto de montagem (quando o último comando sai). */
  cleanupAfterCommand?(): void
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
  wrapWith?(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string, place?: ICercoPlace): Promise<string>
  /**
   * ⛔ O comando embrulhado (`wrap`, `wrapWith`) saiu: uma chamada por linha embrulhada. No Linux, o bwrap cria no disco um arquivo
   * vazio (só leitura) para cada caminho negado que não existe (`apps/legacy` numa worktree), e só esta chamada o tira —
   * depois que o ÚLTIMO comando cercado sai (tirar antes soltaria a negação de quem ainda roda). Sem ela, o arquivo
   * ficava e o `git status` da worktree acusava a sobra.
   */
  done?(): void
  /**
   * ⛔ A pasta PRIVADA do servidor para o que é de UM comando (a chave SSH, a configuração do proxychains com o token de rede) e
   * para os logs: fica na pasta de dados, que NENHUM comando lê — só o comando dono recebe leitura da sua subpasta
   * (`commands/<token>`). Na pasta do projeto, que os agentes dividem, outro comando leria tudo pelo terminal.
   */
  runDir?(): string
}

/** Onde ficam o rascunho (HOME, TMPDIR, caches) e o `.git` quando a raiz é um repositório ou uma worktree. */
export interface ICercoPlace {
  /** A pasta do projeto: o rascunho mora nela, nunca dentro da worktree (sujaria o `git status`). Ausente = a raiz. */
  scratchBase?: string
  gitCommonDir?: string
  worktreeGitDir?: string
  /** A pasta privada do agente do comando e o que ele faz nela (ver `agentFolderAccess`). As dos outros, fechadas. */
  agentFolder?: { dir: string; read: boolean; write: boolean }
  /** ⛔ As pastas de skills e commands que outro projeto compartilhou com este: só leitura (entram em `readOnly`). */
  sharedFolders?: readonly string[]
  /** As portas de serviço LOCAL que as regras liberam exatas (`localhost:<porta>`): no Linux ganham um encaminhador. */
  localPorts?: readonly number[]
  /**
   * Há regra EXATA de TCP fora do HTTP (`10.10.0.1:32017`, `db.interno:5432`): no Linux o comando roda com o
   * interceptador (`tcpInterceptor`), que leva a conexão de qualquer cliente (mongosh, psql, ssh) pelo portão.
   */
  tcp?: boolean
}

/** A biblioteca do proxychains-ng (Debian/Ubuntu). Sem ela, o TCP fora do HTTP segue sem caminho (como antes). */
export const PROXYCHAINS_LIBS = ['/usr/lib/x86_64-linux-gnu/libproxychains.so.4', '/usr/lib/aarch64-linux-gnu/libproxychains.so.4', '/usr/lib/libproxychains4.so']

/**
 * ⚖️ O TCP DE QUALQUER CLIENTE PELO PORTÃO: o cliente de banco e o ssh não falam o proxy HTTP. O `proxychains-ng`
 * (`LD_PRELOAD`) intercepta o `connect` e o leva pelo CONNECT da ponte do cerco, com o token do comando — quem decide
 * continua sendo a regra, conexão a conexão (rede local só com regra exata). A ponte e o loopback ficam de fora.
 * Devolve o trecho do prelúdio, ou nada sem a biblioteca.
 */
export function tcpInterceptor(confDir: string, token: string, bridgePort: number, libs: readonly string[] = PROXYCHAINS_LIBS): string {
  const lib = libs.find((path) => existsSync(path))
  if (!lib) return ''
  const conf = join(confDir, `proxychains-${token.slice(0, 16)}.conf`)
  writeFileSync(
    conf,
    [
      'strict_chain',
      'proxy_dns',
      'quiet_mode',
      'tcp_read_time_out 15000',
      'tcp_connect_time_out 8000',
      'localnet 127.0.0.0/255.0.0.0',
      '[ProxyList]',
      `http 127.0.0.1 ${bridgePort} ${token} x`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  return `export LD_PRELOAD=${quote(lib)} PROXYCHAINS_CONF_FILE=${quote(conf)} PROXYCHAINS_QUIET_MODE=1;`
}

/**
 * ⛔ OS SERVIÇOS LOCAIS NO LINUX: lá o comando tem a própria rede (`--unshare-net`) e o `localhost` dele é outro. Um
 * cliente de banco não fala proxy, então cada porta liberada ganha, dentro do cerco, um `socat` ouvindo em
 * `127.0.0.1:<porta>` que leva a conexão pelo PORTÃO (com o token do comando) ao serviço do host. Quem decide continua
 * sendo a regra, conexão a conexão. Os encaminhadores morrem com o comando.
 */
export function localForwards(ports: readonly number[], token: string, bridgePort: number): string {
  if (!ports.length) return ''
  const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
  const forwards = unique.map(
    (port) => `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork PROXY:127.0.0.1:localhost:${port},proxyport=${bridgePort},proxyauth=${token}:x >/dev/null 2>&1 &`,
  )
  // O `trap` derruba os encaminhadores quando o comando acaba; a espera curta deixa eles abrirem a porta antes do uso.
  return `${forwards.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT; sleep 0.2;`
}

export const SANDBOX_UNAVAILABLE = 'cerco indisponível neste servidor'

/** A porta da ponte HTTP que o runtime monta DENTRO do cerco no Linux (`initializeLinuxNetworkBridge`). */
const LINUX_BRIDGE_PORT = 3128

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
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** ⛔ `CERCO_READ_ALLOWLIST=1` (padrão desligado): o cerco lê só o liberado, não o host inteiro. Só no Linux (bubblewrap). */
  readAllowlistOn(): boolean {
    return this.env.CERCO_READ_ALLOWLIST === '1' && this.platform === 'linux'
  }

  /** A política de UM projeto: o que o comando pode ler e gravar. */
  policy(projectId: string, bridge: readonly string[] = []): Record<string, unknown> {
    const project = projectWorkspace(projectId, this.env)
    return {
      ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: {
        // ⛔ Sem agente aqui: nenhuma pasta privada de agente se alcança (as do projeto ficam fechadas; as globais, fora).
        denyRead: [dataDir(this.env), process.cwd(), homedir(), ...hostSocketDirs(), ...existing([join(project, FILE_DIRS.agent)])],
        allowRead: [project, join(dataDir(this.env), 'tools'), ...existing(readOnlyResourceDirs(project, this.env)), ...runtimeHelpers(), ...bridge],
        allowWrite: [project],
        // Os arquivos de recurso do projeto (dentro dele) e os globais: só leitura.
        denyWrite: existing([...projectResourceDirs(projectId, this.env), globalResourcesDir(this.env)]),
      },
    }
  }

  /** A base do cerco de uma pasta: as de trabalho dentro dela, o que se lê sempre e o que nunca se toca. */
  base(root: string, place: ICercoPlace = {}): ICercoBase {
    return {
      root,
      ...(place.scratchBase && place.scratchBase !== root ? { projectRoot: place.scratchBase } : {}),
      scratch: ['.home', '.tmp', '.cache'].map((name) => join(place.scratchBase ?? root, name)),
      ...(place.gitCommonDir ? { gitCommonDir: place.gitCommonDir } : {}),
      ...(place.gitCommonDir && place.worktreeGitDir ? { worktreeGitDir: place.worktreeGitDir } : {}),
      // A instalação do Node em uso (num Mac com nvm, fica na pasta pessoal, que o cerco fecha) e as ferramentas.
      alwaysRead: [join(dataDir(this.env), 'tools'), dirname(dirname(process.execPath)), ...runtimeHelpers()],
      // ⛔ As pastas privadas dos OUTROS agentes: fechadas para ler e gravar, mesmo com regra que as cubra (`**`).
      alwaysDeny: [dataDir(this.env), process.cwd(), homedir(), ...hostSocketDirs(), ...agentFolders(root, place.agentFolder?.dir, this.env).others],
      ...(place.agentFolder ? { agentFolder: place.agentFolder } : {}),
      ...(this.readAllowlistOn() ? { readAllowlist: systemReadAllowlist() } : {}),
      // Os arquivos de recurso: o global sempre; os do projeto quando a raiz é dele. Lê, não grava.
      readOnly: existing([...readOnlyResourceDirs(root, this.env), ...(place.sharedFolders ?? [])]),
      find: (pattern) => findUnder(root, pattern),
    }
  }

  async wrapWith(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string, place: ICercoPlace = {}): Promise<string> {
    const status = await this.status()
    if (!status.available) throw new Error(`${SANDBOX_UNAVAILABLE}: ${status.reason ?? 'sem motivo'}`)
    const manager = await this.ready()
    const port = await networkGate().start()
    const planned = plan(this.base(root, place))
    planned.readAllow.push(...bridgeSockets(manager))
    // ⛔ Só ESTE comando lê o que o servidor guardou para ele (a chave SSH, o proxychains): a pasta de dados segue negada aos outros.
    const own = commandDirOf(this.runDir(), networkToken)
    const wantsTcp = process.platform === 'linux' && place.tcp
    if (wantsTcp) mkdirSync(own, { recursive: true, mode: 0o700 })
    if (existsSync(own)) planned.readAllow.push(own)
    const cerco = this.platform === 'linux' ? withWriteGlobsExpanded(forBubblewrap(planned, root, listDir)) : planned
    for (const dir of writeFolders(cerco, root)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const scratch = (name: string) => {
      const dir = join(place.scratchBase ?? root, name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    }
    const home = scratch('.home')
    const cache = scratch('.cache')
    // ⚠️ No Linux o comando roda noutro namespace de rede: o runtime põe lá dentro uma ponte (socat) em `localhost:3128`
    // que leva à porta do gateway no host. No Mac o seatbelt divide a rede com o host, e a porta é a própria.
    const proxy = `http://${networkToken}:x@127.0.0.1:${process.platform === 'linux' ? LINUX_BRIDGE_PORT : port}`
    const connector = writeConnector(home)
    ensureGitProxyAuth(home)
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
    // No Mac o seatbelt divide a rede com o host: lá só o cliente que fala proxy chega ao serviço local.
    const forwards = process.platform === 'linux' ? localForwards(place.localPorts ?? [], networkToken, LINUX_BRIDGE_PORT) : ''
    // Depois dos encaminhadores (eles mesmos não passam pelo interceptador): só o comando do agente.
    const tcp = wantsTcp ? tcpInterceptor(own, networkToken, LINUX_BRIDGE_PORT) : ''
    return manager.wrapWithSandbox(`${prelude}; ${forwards} ${tcp} ${command}`, SANDBOX_SHELL, {
      ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: { denyRead: cerco.readDeny, allowRead: cerco.readAllow, allowWrite: cerco.writeAllow, denyWrite: cerco.writeDeny },
    })
  }

  runDir(): string {
    return join(dataDir(this.env), 'run')
  }

  done(): void {
    void this.manager?.then((manager) => manager.cleanupAfterCommand?.()).catch(() => undefined)
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
    const manager = await this.ready()
    return manager.wrapWithSandbox(`${prelude}; ${command}`, SANDBOX_SHELL, this.policy(projectId, bridgeSockets(manager)))
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
      // O teste também conta como comando cercado: sem a saída dele, a limpeza dos pontos de montagem nunca rodava.
      await run(wrapped, { shell: SANDBOX_SHELL, timeout: 20_000 }).finally(() => manager.cleanupAfterCommand?.())
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
        // ⚖️ Socket Unix liberado no Linux (o `tsx`, o pre-commit, servidores de linguagem abrem um no TMPDIR): é seguro
        // SÓ porque os do host ficam fora de alcance (`hostSocketDirs`); os abstratos, a rede própria do cerco isola.
        network: { allowedDomains: [], deniedDomains: [], httpProxyPort: port, socksProxyPort: port, ...(process.platform === 'linux' ? { allowAllUnixSockets: true } : {}) },
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
 * ⚠️ O CERCO NO LINUX (bubblewrap): uma pasta REABERTA para leitura volta só leitura por cima de tudo o que está
 * abaixo dela, e a escrita liberada ali dentro morre (provado no contêiner: `apps/` gravável sob a raiz reaberta dá
 * "Read-only file system"). No Mac (seatbelt) a escrita vale. Então, no Linux, nada que contém uma escrita é fechado e
 * reaberto:
 * - a raiz que as regras liberam INTEIRA para leitura não é fechada (os segredos seguem negados um a um);
 * - a pasta fechada que CONTÉM a raiz (os dados do gateway, com o projeto dentro) vira o fechamento de cada vizinho no
 *   caminho até a raiz — o que é reaberto (as ferramentas) fica de fora.
 * Leitura parcial com escrita DENTRO do que é lido continua só leitura no Linux: falha fechada.
 */
export function forBubblewrap(plan: ICercoPlan, root: string, list: (dir: string) => string[]): ICercoPlan {
  const bare = (path: string) => path.replace(/\/\*\*$/, '') || '/'
  const whole = plan.readAllow.some((path) => bare(path) === root)
  const readAllow = whole ? plan.readAllow.filter((path) => bare(path) !== root) : plan.readAllow
  const keep = [root, ...readAllow.map(bare)]
  const readDeny = plan.readDeny.flatMap((path) => {
    if (whole && path === root) return []
    return path !== root && isAtOrUnder(root, path) ? denyAllBut(path, keep, list) : [path]
  })
  return { ...plan, readAllow, readDeny: [...new Set(readDeny)] }
}

/** Arquivos de `/etc` que os programas precisam (nome exato) e prefixos (`ld.so.conf`, `ld.so.conf.d`…). O resto de `/etc` fica fechado. */
const ETC_FILES = [
  'ssl',
  'ca-certificates',
  'ca-certificates.conf',
  'resolv.conf',
  'hosts',
  'host.conf',
  'gai.conf',
  'nsswitch.conf',
  'passwd',
  'group',
  'localtime',
  'alternatives',
  'ld.so.cache',
  'gitconfig',
  'os-release',
  'mime.types',
  'protocols',
  'services',
  'shells',
]
const ETC_PREFIXES = ['ld.so.conf']

/**
 * ⛔ O que o cerco reabre com `CERCO_READ_ALLOWLIST=1`: o sistema que os comandos usam (binários e bibliotecas, alguns arquivos
 * de `/etc`) e a instalação do Node em uso. Só o que existe. `/etc/ssh/ssh_config.d` o runtime esconde sozinho. O projeto,
 * o rascunho, os recursos e as ferramentas entram pelo plano, não por aqui.
 */
export function systemReadAllowlist(has: (path: string) => boolean = pathExists, list: (dir: string) => string[] = listDir, execPath: string = process.execPath): string[] {
  const system = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32']
  const etc = [
    ...ETC_FILES.map((name) => `/etc/${name}`),
    ...list('/etc')
      .filter((name) => ETC_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map((name) => `/etc/${name}`),
    '/etc/ssh/ssh_config',
  ]
  const node = [
    dirname(dirname(execPath)),
    ...(() => {
      try {
        return [dirname(dirname(realpathSync(execPath)))]
      } catch {
        return []
      }
    })(),
  ]
  return [...new Set([...system, ...etc, ...node].filter((path) => has(path)))]
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * As PASTAS que as regras de escrita liberam (`notas/**`), dentro da raiz: o gateway as cria antes do comando. Sem
 * isso, o cerco não abre o que ainda não existe, e criar a pasta pediria escrita na raiz. Só pasta explícita (com `/**`)
 * e sem curinga no caminho; nada fora da raiz.
 */
export function writeFolders(plan: ICercoPlan, root: string): string[] {
  return plan.writeAllow
    .filter((path) => path.endsWith('/**'))
    .map((path) => path.slice(0, -3))
    .filter((dir) => !/[*?[\]{}]/.test(dir) && dir !== root && isAtOrUnder(dir, root))
}

/**
 * As pastas dos arquivos de recurso, criadas se faltarem: o cerco não abre nem fecha o que não existe (e o recurso
 * gravado depois já cai numa pasta que ele fecha para escrita).
 */
function existing(dirs: readonly string[]): string[] {
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o755 })
    } catch {
      // Sem como criar (somente leitura): o cerco segue sem ela.
    }
  }
  return dirs.filter((dir) => existsSync(dir))
}

/** O que o runtime monta sozinho na raiz (e que fechar quebraria o comando): nunca entra no fechamento de `/`. */
const KERNEL_DIRS = new Set(['/proc', '/dev', '/sys'])

/** Fecha tudo dentro de `dir` menos o que leva ao que fica aberto (`keep`). */
function denyAllBut(dir: string, keep: readonly string[], list: (dir: string) => string[]): string[] {
  return list(dir).flatMap((name) => {
    const child = join(dir, name)
    if (keep.includes(child) || KERNEL_DIRS.has(child)) return []
    return keep.some((path) => isAtOrUnder(path, child)) ? denyAllBut(child, keep, list) : [child]
  })
}

function isAtOrUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * ⚠️ No Linux o runtime IGNORA regra de escrita com curinga no meio do caminho ("Skipping glob write pattern on Linux"):
 * `<raiz>/**\/*.test.ts` e `<repo>/_worktrees/*\/evidence/**` não valiam no terminal, e a ferramenta de edição gravava
 * onde o terminal (prettier, lint-staged no commit) dava "somente leitura". Aqui cada padrão vira os caminhos que
 * EXISTEM e casam (arquivos, ou a pasta quando o padrão termina em `/**`). O padrão fica junto (o runtime lê os que sabe).
 * ⚖️ Criar um arquivo NOVO por um padrão desses segue só pela ferramenta de edição: o terminal não abre a pasta inteira.
 * As negações com curinga também se expandem: o que existe fica fechado.
 */
export function withWriteGlobsExpanded(plan: ICercoPlan, list: (dir: string) => Array<{ name: string; dir: boolean }> = listEntries): ICercoPlan {
  const expand = (paths: readonly string[]) => [...new Set(paths.flatMap((path) => [path, ...expandGlobPath(path, list)]))]
  return { ...plan, writeAllow: expand(plan.writeAllow), writeDeny: expand(plan.writeDeny) }
}

/** Teto de caminhos por padrão: numa árvore enorme, o que passa fica fechado (falha fechada para a escrita). */
const GLOB_EXPAND_LIMIT = 4000
/** As pastas que o `**` não atravessa: dependências e o git por dentro. */
const GLOB_SKIP = new Set(['node_modules', '.git'])

/** Os caminhos que existem e casam um padrão absoluto com curinga; nada se ele não tem curinga (o runtime o lê). */
export function expandGlobPath(path: string, list: (dir: string) => Array<{ name: string; dir: boolean }> = listEntries): string[] {
  const whole = path.endsWith('/**')
  const base = whole ? path.slice(0, -3) : path
  if (!/[*?[\]{}]/.test(base) || !isAbsolute(base)) return []
  const segments = base.split('/').filter(Boolean)
  const found: string[] = []
  let visited = 0
  // Desce segmento a segmento: o literal só entra; o curinga lista a pasta; o `**` vale zero ou mais pastas.
  const walk = (dir: string, rest: readonly string[]): void => {
    if (found.length >= GLOB_EXPAND_LIMIT || visited > 200_000) return
    visited += 1
    const [head, ...tail] = rest
    if (head === undefined) {
      found.push(dir)
      return
    }
    if (head === '**') {
      walk(dir, tail)
      for (const entry of list(dir)) if (entry.dir && !GLOB_SKIP.has(entry.name)) walk(join(dir, entry.name), rest)
      return
    }
    if (!/[*?[\]{}]/.test(head)) {
      const next = join(dir, head)
      // O literal segue o link (no Mac, `/var` é `/private/var`); o curinga não entra em link.
      if (!tail.length ? existsSync(next) : isDirectory(next)) walk(next, tail)
      return
    }
    const matcher = globToRegex(head)
    for (const entry of list(dir)) if (matcher.test(entry.name) && (tail.length ? entry.dir : !whole || entry.dir)) walk(join(dir, entry.name), tail)
  }
  walk('/', segments)
  return found.map((item) => (whole ? `${item}/**` : item))
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listEntries(dir: string): Array<{ name: string; dir: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
  } catch {
    return []
  }
}

/** Teto da busca dos modelos: numa árvore maior, o que sobra fica escondido (falha fechada). */
const FIND_LIMIT = 50_000

/**
 * Os arquivos de um padrão relativo dentro da raiz (o casamento é o da regra), sem descer em `node_modules` nem `.git`:
 * lá dentro segue escondido. O `glob` do Node não serve: o `**` dele pula as entradas com ponto.
 */
export function findUnder(root: string, pattern: string): string[] {
  if (isAbsolute(pattern) || pattern.startsWith('~')) return []
  const found: string[] = []
  const pending = ['']
  let seen = 0
  while (pending.length && seen < FIND_LIMIT) {
    const dir = pending.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      const path = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // ⚖️ Outro checkout dentro da raiz (as worktrees em `_worktrees/`) não é desta pasta: o `git status` daqui não o vê,
        // e as 4 worktrees da raiz do repositório gastavam o teto antes de a busca chegar a `.agents/`. Lá, o modelo segue
        // fechado (falha fechada).
        if (entry.name !== 'node_modules' && entry.name !== '.git' && !existsSync(join(root, path, '.git'))) pending.push(path)
      } else if (entry.isFile() && pathMatches(pattern, path)) found.push(path)
    }
  }
  return found
}

/**
 * ⛔ Onde moram os sockets do HOST, fechados no Linux (onde o cerco libera socket Unix): o `docker.sock` (o usuário do
 * gateway está no grupo docker: um contêiner privilegiado seria root no host), o bus do systemd (`systemd-run --user`
 * roda fora do cerco) e o `/tmp` (ssh-agent, outros processos). O comando usa o TMPDIR dele, na pasta do projeto.
 */
export function hostSocketDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'linux' ? ['/run', '/var/run', '/tmp'] : []
}

/** A ponte do proxy mora no `/tmp` do host, que o cerco fecha: só os sockets dela voltam (sem eles, a rede cai). */
function bridgeSockets(manager: ISandboxManager): string[] {
  return [...new Set([manager.getLinuxHttpSocketPath?.(), manager.getLinuxSocksSocketPath?.()].filter((path): path is string => !!path))]
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
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
/**
 * ⚖️ O git (libcurl) só manda a senha do proxy DEPOIS do 407, e o portão fecha a conexão junto com o 407: o `git fetch`
 * por HTTPS caía com "Proxy CONNECT aborted" mesmo com a regra de rede. `proxyAuthMethod = basic` manda o token já no
 * primeiro CONNECT, como o curl faz. Vai no `.gitconfig` da casa do comando, sem apagar o que o agente pôs lá.
 */
export function ensureGitProxyAuth(home: string): void {
  const path = join(home, '.gitconfig')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (/proxyAuthMethod/i.test(current)) return
  writeFileSync(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}[http]\n\tproxyAuthMethod = basic\n`)
}

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
