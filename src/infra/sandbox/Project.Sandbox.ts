import { exec } from 'node:child_process'
import {
  closeSync,
  constants as fsc,
  type Dirent,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CONVERSATIONS_DIR, dataDir, projectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { esmImport } from '@infra/adapters/support/Esm.Import'
import { deniedGatewayPorts } from '@infra/permissions/Gateway.Reach'
import { networkGate } from '@infra/permissions/Network.Gate'
import { commandDirOf } from '@infra/accounts/Ssh.Kit'
import { drainConcurrently, expandReadDenyGlobs, READ_DENY_WALK_CONCURRENCY } from '@infra/sandbox/ReadDeny.Globs'
import type { ICercoBase, ICercoPlan } from '@domain/Cerco.Plan'
import { ENV_FILE_PATTERNS, globToRegex, pathMatches, SECRET_TEMPLATES } from '@domain/Permission.Policy'
import { FILE_DIRS } from '@domain/models/ResourceFile.Model'
import { discoveredGitSync } from '@infra/workspace/Git.Safe'
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
   * depois que o ÚLTIMO comando cercado NAQUELA PASTA sai (tirar antes soltaria a negação de quem ainda roda). Sem ela, o
   * arquivo ficava e o `git status` da worktree acusava a sobra. `line` é a linha que o `wrap`/`wrapWith` devolveu: diz qual
   * comando saiu (sem ela, o mais antigo).
   */
  done?(line?: string): void
  /**
   * ⛔ A pasta PRIVADA do servidor para o que é de UM comando (a chave SSH, a configuração do proxychains com o token de rede) e
   * para os logs: fica na pasta de dados, que NENHUM comando lê — só o comando dono recebe leitura da sua subpasta
   * (`commands/<token>`). Na pasta do projeto, que os agentes dividem, outro comando leria tudo pelo terminal.
   */
  runDir?(): string
  /** ⚠️ Os `.env` da raiz (caminhos absolutos, sem os modelos): o que a máscara registra quando o projeto liberou a leitura. */
  envFiles?(root: string): Promise<string[]>
}

/** Um comando cercado rodando: a linha que o embrulho devolveu (quando já devolveu) e as pastas que a varredura dele toca. */
interface IRunningCommand {
  line?: string
  dirs: readonly string[]
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
  /** Os repositórios de verdade do projeto (ver `ICercoBase.repositories`): irmãos só leitura e `.git` protegido. */
  repositories?: readonly string[]
  /**
   * As portas de serviço LOCAL que as regras liberam exatas (`localhost:<porta>`): no Linux ganham um encaminhador; no Mac,
   * o perfil abre a porta para ouvir e conectar (ver `withMacLocalPorts`).
   */
  localPorts?: readonly number[]
  /**
   * Há regra EXATA de TCP fora do HTTP (`10.10.0.1:32017`, `db.interno:5432`): no Linux o comando roda com o
   * interceptador (`tcpInterceptor`), que leva a conexão de qualquer cliente (mongosh, psql, ssh) pelo portão.
   */
  tcp?: boolean
  /**
   * As portas das regras EXATAS de TCP fora do HTTP. No Mac não há interceptador (o macOS tira o `DYLD_INSERT_LIBRARIES`
   * ao rodar o `/bin/bash`): o perfil abre a saída direta nessas portas (ver `withMacTcpPorts`).
   */
  tcpPorts?: readonly number[]
  /**
   * 🖥️ Agente de máquina: o cerco aberto (ver `machinePlan`). A casa de quem roda o gateway e a pasta de dados abrem; ficam
   * fechados os dados do gateway, a configuração dele e as pastas privadas dos outros agentes. A rede sai livre no Mac
   * (`withMacOpenNetwork`); no Linux, toda conexão TCP passa pelo portão (o interceptador vai sempre).
   */
  machine?: boolean
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
 * `127.0.0.1:<porta>` que leva a conexão pelo PORTÃO ao serviço do host. Quem decide continua sendo a regra, conexão a
 * conexão. Os encaminhadores morrem com o comando.
 * ⛔ A credencial NÃO vai na linha de comando (o `processes` e o `/proc/<pid>/cmdline` a mostrariam): o `socat` roda o auxiliar
 * do CONNECT (`writeConnector`), que lê o `HTTPS_PROXY` do ambiente do comando.
 */
export function localForwards(ports: readonly number[], node: string, connector: string): string {
  if (!ports.length) return ''
  const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
  // Para o `socat`, `:`, `,` e `\` do endereço precisam de barra; o comando em si vai para o `sh -c` entre aspas.
  const dq = (value: string) => `"${value.replace(/(["\\$`])/g, '\\$1')}"`
  const escape = (value: string) => value.replace(/([\\:,!])/g, '\\$1')
  const forwards = unique.map(
    (port) => `socat TCP-LISTEN:${port},bind=127.0.0.1,reuseaddr,fork ${quote(`SYSTEM:${escape(`exec ${dq(node)} ${dq(connector)} localhost ${port}`)}`)} >/dev/null 2>&1 &`,
  )
  // O `trap` derruba os encaminhadores quando o comando acaba; a espera curta deixa eles abrirem a porta antes do uso.
  return `${forwards.join(' ')} trap 'kill $(jobs -p) 2>/dev/null' EXIT; sleep 0.2;`
}

/**
 * ⚖️ As portas do HMR do servidor de desenvolvimento (a faixa do Vite, que o Nuxt usa para o HMR do lado do servidor): o
 * `nuxi dev` sorteia uma delas e, sem nenhuma livre, cai numa porta aleatória e não sobe (o 502 na porta do projeto). Abrem
 * junto com qualquer porta local liberada — quem tem servidor de desenvolvimento tem HMR.
 */
export const DEV_HMR_PORTS: readonly number[] = Array.from({ length: 21 }, (_, index) => 24_678 + index)

/**
 * ⚖️ AS PORTAS LOCAIS NO MAC: o seatbelt divide a rede com o host, e o perfil do runtime só abre a porta do gateway. Cada
 * porta que a regra EXATA libera (`localhost:4000`) ganha no perfil ouvir, receber e conectar NAQUELA porta do loopback —
 * o servidor de desenvolvimento sobe, e o cliente que não fala proxy alcança o serviço local. As outras seguem fechadas.
 * ⚠️ O seatbelt não separa `127.0.0.1` de `0.0.0.0`: o servidor que ouve em todas as interfaces numa porta liberada fica
 * visível na rede local.
 * ⛔ Sem o ponto de encaixe (a regra da porta do gateway), o perfil mudou de forma: lança, e o comando é recusado — nada
 * abre sem saber onde entra.
 */
export function withMacLocalPorts(wrapped: string, gatePort: number, ports: readonly number[]): string {
  const exact = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536 && port !== gatePort)
  if (!exact.length) return wrapped
  const anchor = `(allow network-outbound (remote ip "localhost:${gatePort}"))`
  const at = wrapped.indexOf(anchor)
  if (at < 0) throw new Error(`${SANDBOX_UNAVAILABLE}: o perfil do cerco não tem a regra da porta do gateway; as portas locais (${exact.join(', ')}) não foram abertas`)
  const unique = [...new Set([...exact, ...DEV_HMR_PORTS])].filter((port) => port !== gatePort)
  const rules = unique.flatMap((port) => [
    `(allow network-bind (local ip "localhost:${port}"))`,
    `(allow network-inbound (local ip "localhost:${port}"))`,
    `(allow network-outbound (remote ip "localhost:${port}"))`,
  ])
  const end = at + anchor.length
  return `${wrapped.slice(0, end)}\n${rules.join('\n')}${wrapped.slice(end)}`
}

/**
 * ⚖️ O TCP FORA DO HTTP NO MAC: o cliente de Redis, Kafka ou Mongo não fala proxy, e o interceptador do Linux não vale aqui
 * (o macOS tira o `DYLD_INSERT_LIBRARIES` ao rodar o `/bin/bash`, então o `start.sh` perderia o desvio). Cada porta de uma
 * regra EXATA liberada (`10.10.0.3:6379`) ganha no perfil a saída direta, e o DNS do sistema passa a responder.
 * ⚠️ O seatbelt só aceita `localhost` ou `*` como host: a porta abre para QUALQUER host, e essa conexão não passa pelo
 * portão (não há registro nem regra de negação por host nela). 80 e 443 nunca: o HTTP segue pelo portão.
 * ⛔ Sem o ponto de encaixe, lança, como em `withMacLocalPorts`.
 */
export function withMacTcpPorts(wrapped: string, gatePort: number, ports: readonly number[]): string {
  const unique = [...new Set(ports)].filter((port) => Number.isInteger(port) && port > 0 && port < 65536 && port !== gatePort && port !== 80 && port !== 443)
  if (!unique.length) return wrapped
  const anchor = `(allow network-outbound (remote ip "localhost:${gatePort}"))`
  const at = wrapped.indexOf(anchor)
  if (at < 0) throw new Error(`${SANDBOX_UNAVAILABLE}: o perfil do cerco não tem a regra da porta do gateway; as portas TCP (${unique.join(', ')}) não foram abertas`)
  const rules = [
    ...unique.map((port) => `(allow network-outbound (remote ip "*:${port}"))`),
    '(allow system-socket (socket-domain AF_UNIX))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(allow mach-lookup (global-name "com.apple.dnssd.service"))',
  ]
  const end = at + anchor.length
  return `${wrapped.slice(0, end)}\n${rules.join('\n')}${wrapped.slice(end)}`
}

/**
 * ⚖️ VER OS PROCESSOS NO MAC: o perfil do runtime só deixa o comando ver os do próprio cerco, e o `ps`, o `pgrep` e o
 * `stop.sh` do projeto falham ("Operation not permitted", "sysmond service not found"). A leitura passa a valer para todos
 * os processos do usuário. ⛔ Sinal, não: parar processo é pela ferramenta `processes`, presa à pasta do projeto.
 * Sem o trecho esperado, o perfil fica como está (só a listagem deixa de funcionar).
 */
/**
 * 🖥️ A REDE LIVRE do agente de máquina no Mac: sair, ouvir e receber em qualquer porta, depois do encaixe da porta do
 * portão. ⛔ As portas do gateway (a dele e a do portão) seguem fechadas no loopback: a negação vem por último e vence.
 * Sem o encaixe, nada abre e o comando não sai.
 */
export function withMacOpenNetwork(wrapped: string, gatePort: number, gatewayPorts: readonly number[]): string {
  const anchor = `(allow network-outbound (remote ip "localhost:${gatePort}"))`
  if (!wrapped.includes(anchor)) throw new Error(`${SANDBOX_UNAVAILABLE}: o perfil do cerco mudou e a rede do agente de máquina não foi aberta`)
  const closed = [...new Set([gatePort, ...gatewayPorts])].map((port) => `(deny network-outbound (remote ip "localhost:${port}"))`)
  const lines = [anchor, '(allow network*)', '(allow system-socket)', '(allow mach-lookup (global-name "com.apple.dnssd.service"))', ...closed]
  return wrapped.replace(anchor, lines.join('\n'))
}

/**
 * ⚖️ VIGIAR ARQUIVOS NO MAC: o `fs.watch` do Node (o Vite, o Nuxt, o `tsc --watch`, o nodemon) usa o FSEvents, e o perfil
 * do runtime não deixa falar com ele — o vigia quebra com EMFILE e o servidor de desenvolvimento reinicia sem parar. O
 * `fseventsd` filtra pelo cerco do cliente: quem vigia uma pasta acima não recebe o que muda nas pastas fechadas.
 * Sem o trecho esperado, o perfil fica como está (só o vigia deixa de funcionar).
 */
export function withMacFileEvents(wrapped: string): string {
  const anchor = '(allow mach-lookup (global-name "com.apple.SecurityServer"))'
  if (!wrapped.includes(anchor) || wrapped.includes('"com.apple.FSEvents"')) return wrapped
  return wrapped.replace(anchor, `${anchor}\n(allow mach-lookup (global-name "com.apple.FSEvents"))`)
}

export function withMacProcessList(wrapped: string): string {
  const own = '(allow process-info* (target same-sandbox))'
  if (!wrapped.includes(own)) return wrapped
  return wrapped.replace(own, `(allow process-info*)\n(allow mach-lookup (global-name "com.apple.sysmond"))`)
}

/** O `NO_PROXY` do comando: no Linux o loopback dele (rede própria) vai direto; no Mac, nada escapa do portão. */
export function noProxyFor(platform: NodeJS.Platform): string {
  return platform === 'linux' ? 'localhost,127.0.0.1,::1' : ''
}

export const SANDBOX_UNAVAILABLE = 'cerco indisponível neste servidor'

/** A porta da ponte HTTP que o runtime monta DENTRO do cerco no Linux (`initializeLinuxNetworkBridge`). */
const LINUX_BRIDGE_PORT = 3128

/** O shell do comando embrulhado: o srt monta a linha para ele. */
export const SANDBOX_SHELL = '/bin/bash'

/** Depois de quanto tempo o teste do cerco que falhou é refeito. */
const PROBE_RETRY_MS = 60_000

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
  /** Quando o teste do cerco falhou (ver `status`). */
  private failedAt?: number
  /** As varreduras das raízes, para achar os modelos poupados sem travar o servidor (ver `TreeIndexCache`). */
  private readonly trees: TreeIndexCache
  /**
   * Os comandos cercados que rodam agora: a linha embrulhada e as pastas dele. ⛔ A varredura de uma pasta espera TODO comando que
   * roda nela, acima dela ou abaixo dela (ver `busy`); os de outras pastas não a seguram — com a esteira contínua, um contador
   * global quase nunca zerava, e as sobras ficavam.
   */
  private readonly running: IRunningCommand[] = []
  /** As pastas onde um comando já rodou: a varredura do fim passa por elas. */
  private readonly sweepDirs = new Set<string>()

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly load: () => Promise<{ SandboxManager: ISandboxManager }> = () => esmImport('@anthropic-ai/sandbox-runtime'),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = Date.now,
  ) {
    this.trees = new TreeIndexCache(now)
  }

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
      ...(place.repositories?.length ? { repositories: place.repositories } : {}),
      ...(place.gitCommonDir && place.worktreeGitDir && !place.machine ? { checkout: mainCheckout(dirname(place.gitCommonDir), root) } : {}),
      // A instalação do Node em uso (num Mac com nvm, fica na pasta pessoal, que o cerco fecha) e as ferramentas.
      alwaysRead: [join(dataDir(this.env), 'tools'), dirname(dirname(process.execPath)), ...runtimeHelpers()],
      // ⛔ As pastas privadas dos OUTROS agentes: fechadas para ler e gravar, mesmo com regra que as cubra (`**`).
      alwaysDeny: place.machine
        ? // ⛔ Nunca o que contém a pasta de trabalho (o `/`, a casa de quem roda num servidor de desenvolvimento): fecharia tudo.
          machineDenied(this.env, agentFolders(root, place.agentFolder?.dir, this.env).others).filter((path) => path !== '/' && !isAtOrUnder(root, path))
        : [dataDir(this.env), process.cwd(), homedir(), ...hostSocketDirs(), ...agentFolders(root, place.agentFolder?.dir, this.env).others],
      ...(place.agentFolder ? { agentFolder: place.agentFolder } : {}),
      ...(this.readAllowlistOn() && !place.machine ? { readAllowlist: systemReadAllowlist() } : {}),
      ...(place.machine ? { anywhere: this.platform === 'darwin' ? ['/'] : [homedir(), dataDir(this.env)] } : {}),
      // Os arquivos de recurso: o global sempre; os do projeto quando a raiz é dele. Lê, não grava.
      readOnly: existing([...readOnlyResourceDirs(root, this.env), ...(place.sharedFolders ?? [])]),
      find: (pattern) => this.trees.find(root, pattern),
    }
  }

  /** Os `.env` da raiz, da varredura guardada (ver `TreeIndexCache`), sem os modelos (`.env.example`…). */
  async envFiles(root: string): Promise<string[]> {
    await this.trees.warm(root)
    const files = new Set(ENV_FILE_PATTERNS.flatMap((pattern) => this.trees.find(root, pattern)))
    return [...files].filter((path) => !SECRET_TEMPLATES.some((template) => pathMatches(template, path))).map((path) => join(root, path))
  }

  async wrapWith(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string, place: ICercoPlace = {}): Promise<string> {
    const entry = this.begin([root, place.scratchBase])
    try {
      return (entry.line = await this.wrapWithPlan(command, root, plan, networkToken, place))
    } catch (error: unknown) {
      // Nada embrulhado, ninguém chama `done()`: a conta fecha aqui.
      this.finish(entry)
      throw error
    }
  }

  private async wrapWithPlan(command: string, root: string, plan: (base: ICercoBase) => ICercoPlan, networkToken: string, place: ICercoPlace): Promise<string> {
    const status = await this.status()
    if (!status.available) throw new Error(`${SANDBOX_UNAVAILABLE}: ${status.reason ?? 'sem motivo'}`)
    const manager = await this.ready()
    const port = await networkGate().start()
    // A varredura dos modelos poupados, sem travar o servidor (ver `TreeIndexCache`): o plano abaixo é síncrono.
    await this.trees.warm(root)
    const planned = plan(this.base(root, place))
    planned.readAllow.push(...bridgeSockets(manager))
    // ⛔ Só ESTE comando lê o que o servidor guardou para ele (a chave SSH, o proxychains): a pasta de dados segue negada aos outros.
    const own = commandDirOf(this.runDir(), networkToken)
    const wantsTcp = process.platform === 'linux' && (place.tcp || place.machine)
    if (wantsTcp) mkdirSync(own, { recursive: true, mode: 0o700 })
    if (existsSync(own)) planned.readAllow.push(own)
    const bubblewrap = this.platform === 'linux' ? await withWriteGlobsExpanded(forBubblewrap(planned, root, listDir, [dirname(own)])) : undefined
    // ⚡ No Linux as negações de leitura com curinga chegam ao runtime já expandidas (ver `ReadDeny.Globs`): a varredura
    // dele, a cada comando, prendia o servidor por minutos numa worktree com `node_modules`.
    const cerco = bubblewrap ? { ...bubblewrap, readDeny: await expandReadDenyGlobs(bubblewrap.readDeny) } : planned
    for (const dir of writeFolders(cerco, root)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (place.gitCommonDir) ensureEmptyAttributes(place.gitCommonDir)
    const scratch = (name: string) => {
      const dir = join(place.scratchBase ?? root, name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    }
    const home = scratch('.home')
    const cache = scratch('.cache')
    cleanLegacyScratch(place.scratchBase ?? root)
    // ⚠️ No Linux o comando roda noutro namespace de rede: o runtime põe lá dentro uma ponte (socat) em `localhost:3128`
    // que leva à porta do gateway no host. No Mac o seatbelt divide a rede com o host, e a porta é a própria.
    const gatePort = process.platform === 'linux' ? LINUX_BRIDGE_PORT : port
    const proxy = `http://${networkToken}:x@127.0.0.1:${gatePort}`
    // ⚖️ O ALL_PROXY em SOCKS5, na mesma porta (ver `Network.Gate`): o cliente que só fala SOCKS (o driver do Mongo) passa direto
    // pelo portão. Em HTTP, ele montava uma ponte numa porta local — que o cerco nega. HTTP_PROXY e HTTPS_PROXY seguem em HTTP.
    // ⚠️ `socks5://`, não `socks5h://`: é o que o `mongosh` reconhece para usar o proxy direto (o nome segue para o portão).
    const socks = `socks5://${networkToken}:x@127.0.0.1:${gatePort}`
    const connector = writeConnector(home)
    ensureGitProxyAuth(home)
    const scoped: Record<string, string> = {
      // 🖥️ O agente de máquina usa a casa de verdade (o git, o brew, as configurações de quem roda o gateway).
      HOME: place.machine ? homedir() : home,
      TMPDIR: scratch('.tmp'),
      npm_config_cache: join(cache, 'npm'),
      PIP_CACHE_DIR: join(cache, 'pip'),
      UV_CACHE_DIR: join(cache, 'uv'),
      GOCACHE: join(cache, 'go'),
      // A rede: só pela porta do gateway, com o token deste comando (quem decide é a regra do agente).
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: socks,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: socks,
      // O `fetch` do Node só segue o proxy com isto (Node 24+).
      NODE_USE_ENV_PROXY: '1',
      // ⚖️ Linux: o cerco tem rede PRÓPRIA (`--unshare-net`), então o loopback é do comando (o servidor que o teste sobe, o
      // encaminhador de `localPorts`) e vai DIRETO; pelo proxy, cada `127.0.0.1:<porta efêmera>` caía no portão ("só com a
      // regra exata"). Mac: o seatbelt divide a rede com o host, o loopback é o do host e só passa pelo portão (`''`).
      NO_PROXY: noProxyFor(this.platform),
      no_proxy: noProxyFor(this.platform),
      // SSH e git por SSH: pelo CONNECT da porta, com o auxiliar (o `nc` do Mac não fala o proxy).
      // Entre aspas: no app do Mac o Node mora em "Agents Gateway.app".
      GIT_SSH_COMMAND: `ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='"${process.execPath}" "${connector}" %h %p'`,
    }
    const prelude = Object.entries(scoped)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join('; ')
    // No Mac o seatbelt divide a rede com o host: a porta liberada entra no perfil (`withMacLocalPorts`), sem encaminhador.
    const forwards = process.platform === 'linux' ? localForwards(place.localPorts ?? [], process.execPath, connector) : ''
    // Depois dos encaminhadores (eles mesmos não passam pelo interceptador): só o comando do agente.
    const tcp = wantsTcp ? tcpInterceptor(own, networkToken, LINUX_BRIDGE_PORT) : ''
    const wrapped = await manager.wrapWithSandbox(`${prelude}; ${forwards} ${tcp} ${command}`, SANDBOX_SHELL, {
      ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
      filesystem: { denyRead: cerco.readDeny, allowRead: cerco.readAllow, allowWrite: cerco.writeAllow, denyWrite: cerco.writeDeny },
    })
    if (this.platform !== 'darwin') return wrapped
    if (place.machine) return withMacFileEvents(withMacProcessList(withMacOpenNetwork(wrapped, port, deniedGatewayPorts())))
    return withMacFileEvents(withMacProcessList(withMacTcpPorts(withMacLocalPorts(wrapped, port, place.localPorts ?? []), port, place.tcpPorts ?? [])))
  }

  runDir(): string {
    return join(dataDir(this.env), 'run')
  }

  done(line?: string): void {
    const entry = (line !== undefined && this.running.find((command) => command.line === line)) || this.running[0]
    if (entry) this.finish(entry)
  }

  /** Algum comando cercado roda nesta pasta, acima ou abaixo dela? Então os pontos dela podem ser dele: nada sai. */
  private busy(dir: string): boolean {
    return this.running.some((command) => command.dirs.some((own) => isAtOrUnder(own, dir) || isAtOrUnder(dir, own)))
  }

  /**
   * ⛔ Um comando cercado vai começar: varre as sobras de pontos de montagem (do CLI do Claude, de uma queda, de um reinício)
   * das pastas dele em que NENHUM outro roda. Pasta com outro rodando fica: tirar o ponto soltaria a negação de quem está nele.
   */
  private begin(dirs: ReadonlyArray<string | undefined>): IRunningCommand {
    const real = [...new Set(dirs.filter((dir): dir is string => !!dir))]
    for (const dir of real) if (!this.busy(dir)) sweepMountPoints(dir)
    for (const dir of real) this.sweepDirs.add(dir)
    const entry: IRunningCommand = { dirs: real }
    this.running.push(entry)
    trackSweepOnExit(this.sweepDirs)
    return entry
  }

  /**
   * O comando cercado saiu (ou nem chegou a ser embrulhado): limpeza do srt e a varredura das pastas ligadas às dele (a mesma,
   * acima, abaixo — uma que esperava por ele) onde ninguém mais roda.
   */
  private finish(entry: IRunningCommand): void {
    const index = this.running.indexOf(entry)
    if (index < 0) return
    this.running.splice(index, 1)
    const sweep = () => {
      for (const dir of this.sweepDirs) {
        const related = entry.dirs.some((own) => isAtOrUnder(own, dir) || isAtOrUnder(dir, own))
        if (related && !this.busy(dir)) sweepMountPoints(dir)
      }
    }
    if (!this.manager) return sweep()
    void this.manager
      .then((manager) => manager.cleanupAfterCommand?.())
      .catch(() => undefined)
      .finally(sweep)
  }

  async wrap(command: string, projectId: string): Promise<string> {
    const status = await this.status()
    if (!status.available) throw new Error(`${SANDBOX_UNAVAILABLE}: ${status.reason ?? 'sem motivo'}`)
    const project = projectWorkspace(projectId, this.env)
    const entry = this.begin([project])
    try {
      return (entry.line = await this.wrapProject(command, projectId, project))
    } catch (error: unknown) {
      this.finish(entry)
      throw error
    }
  }

  private async wrapProject(command: string, projectId: string, project: string): Promise<string> {
    // HOME, TMPDIR e caches DENTRO do projeto: os de fora estão fechados, e sem isto `npm install` falhava.
    const scratch = (name: string) => {
      const dir = join(project, name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      return dir
    }
    const cache = scratch('.cache')
    cleanLegacyScratch(project)
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

  /**
   * Funciona aqui? Testado com um `true` embrulhado, e o resultado fica. ⛔ A FALHA fica só por um minuto: um tropeço
   * passageiro (o teste que estourou o tempo, o `/tmp` cheio) deixava o terminal de todos bloqueado até reiniciar.
   */
  status(): Promise<ISandboxStatus> {
    if (this.failedAt !== undefined && this.now() - this.failedAt >= PROBE_RETRY_MS) {
      this.failedAt = undefined
      this.probe = undefined
    }
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
      this.failedAt = this.now()
      return { available: false, mechanism, reason }
    }
  }

  private ready(): Promise<ISandboxManager> {
    if (this.manager) return this.manager
    const loading = this.load().then(async ({ SandboxManager }) => {
      // ⛔ A rede do cerco é a PORTA DO GATEWAY (`Network.Gate`): o comando só alcança 127.0.0.1:<porta>, e cada
      // conexão é decidida pelas regras do agente do comando. Sem `ask`: nada passa por fora.
      const port = await networkGate().start()
      await SandboxManager.initialize({
        ...(this.nested() ? { enableWeakerNestedSandbox: true } : {}),
        // ⚖️ Socket Unix liberado no Linux (o `tsx`, o pre-commit, servidores de linguagem abrem um no TMPDIR): é seguro
        // SÓ porque os do host ficam fora de alcance (`hostSocketDirs`); os abstratos, a rede própria do cerco isola.
        // ⛔ No Mac, só DENTRO das pastas de trabalho (a dos projetos e a das conversas sem projeto, onde mora o TMPDIR do
        // comando): o `tsx` do build passa; o do Docker, o do ssh-agent e os do usuário seguem fora.
        network: {
          allowedDomains: [],
          deniedDomains: [],
          httpProxyPort: port,
          socksProxyPort: port,
          ...(process.platform === 'linux' ? { allowAllUnixSockets: true } : process.platform === 'darwin' ? { allowUnixSockets: macSocketDirs(this.env) } : {}),
        },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      })
      return SandboxManager
    })
    this.manager = loading
    // A carga que falhou não fica guardada: a próxima tenta de novo.
    loading.catch(() => {
      if (this.manager === loading) this.manager = undefined
    })
    return loading
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
 *
 * ⛔ `sealed`: pastas fechadas INTEIRAS mesmo com algo reaberto dentro (só leitura; o runtime remonta o reaberto por cima do
 * tmpfs). É o caso de `run/commands`: quebrada em vizinhos, cada pasta de OUTRO comando entrava no plano; se aquele comando
 * acabava entre o plano e a subida do bwrap, a pasta sumia e o bwrap tentava criá-la no pai só leitura
 * ("bwrap: Can't mkdir …/run/commands/<token>: Read-only file system").
 */
export function forBubblewrap(plan: ICercoPlan, root: string, list: (dir: string) => string[], sealed: readonly string[] = []): ICercoPlan {
  const bare = (path: string) => path.replace(/\/\*\*$/, '') || '/'
  const whole = plan.readAllow.some((path) => bare(path) === root)
  const readAllow = whole ? plan.readAllow.filter((path) => bare(path) !== root) : plan.readAllow
  const keep = [root, ...readAllow.map(bare)]
  // Só a pasta sem a raiz dentro: com escrita lá, fechar e reabrir mataria a escrita (ver acima).
  const closed = sealed.filter((dir) => !isAtOrUnder(root, dir))
  const readDeny = plan.readDeny.flatMap((path) => {
    if (whole && path === root) return []
    return path !== root && isAtOrUnder(root, path) ? denyAllBut(path, keep, list, closed) : [path]
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
 * ⚠️ O `.git/info/attributes` que não existe vira, na negação de escrita do cerco, um caminho que o git nem LÊ: todo
 * `git status` avisava "unable to access '.git/info/attributes': Permission denied". Vazio, ele não muda nada (sem
 * atributo, sem filtro) e a negação fica sobre um arquivo legível. Sem como criar, segue o aviso.
 */
export function ensureEmptyAttributes(gitCommonDir: string): void {
  const path = join(gitCommonDir, 'info', 'attributes')
  try {
    if (!existsSync(join(gitCommonDir, 'HEAD')) || existsSync(path)) return
    mkdirSync(join(gitCommonDir, 'info'), { recursive: true })
    writeFileSync(path, '', { flag: 'wx', mode: 0o644 })
  } catch {
    // Somente leitura, ou outro comando criou antes: tanto faz.
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
function denyAllBut(dir: string, keep: readonly string[], list: (dir: string) => string[], sealed: readonly string[] = []): string[] {
  return list(dir).flatMap((name) => {
    const child = join(dir, name)
    if (keep.includes(child) || KERNEL_DIRS.has(child)) return []
    if (sealed.includes(child)) return [child]
    return keep.some((path) => isAtOrUnder(path, child)) ? denyAllBut(child, keep, list, sealed) : [child]
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
export async function withWriteGlobsExpanded(plan: ICercoPlan, list: TGlobLister = globLister()): Promise<ICercoPlan> {
  // ⚡ Uma listagem por pasta para TODOS os padrões (`list` guarda as lidas): cada `<raiz>/**/x` repetia a árvore inteira.
  const expand = async (paths: readonly string[]) => {
    const out: string[] = []
    for (const path of paths) out.push(path, ...(await expandGlobPath(path, list)))
    return [...new Set(out)]
  }
  const allow = await expand(plan.writeAllow)
  // ⛔ Cada caminho é uma montagem, e o bwrap aceita ~3000: passou do teto, a LIBERAÇÃO expandida sai (fica o padrão, que o
  // runtime ignora: escrever ali pelo terminal falha, mas o terminal funciona). A NEGAÇÃO expandida fica sempre.
  return { ...plan, writeAllow: allow.length > WRITE_EXPAND_TOTAL ? [...plan.writeAllow] : allow, writeDeny: await expand(plan.writeDeny) }
}

/** Teto das liberações de escrita expandidas, somadas: o bwrap para em ~9000 argumentos (~3000 montagens) no total. */
const WRITE_EXPAND_TOTAL = 1500

/** Teto de caminhos por padrão: numa árvore enorme, o que passa fica fechado (falha fechada para a escrita). */
const GLOB_EXPAND_LIMIT = 4000
/** Teto de passos por padrão (pasta × trecho do padrão): numa árvore enorme, para aí. */
const GLOB_VISIT_LIMIT = 200_000
/** As pastas que o `**` não atravessa: dependências e o git por dentro. */
const GLOB_SKIP = new Set(['node_modules', '.git'])

/** Uma entrada de pasta para a expansão: o nome, se é pasta e se é link (o literal segue o link; o curinga, não). */
export interface IGlobEntry {
  name: string
  dir: boolean
  link?: boolean
}
/** Lista uma pasta; `undefined` = não se lista (sem permissão, sumiu). */
export type TGlobLister = (dir: string) => Promise<IGlobEntry[] | undefined>

/** O lister de verdade, assíncrono, com as pastas já lidas guardadas (uma chamada de `withWriteGlobsExpanded`, não mais). */
export function globLister(read: (dir: string) => Promise<Dirent[]> = (dir) => readdir(dir, { withFileTypes: true })): TGlobLister {
  const listed = new Map<string, Promise<IGlobEntry[] | undefined>>()
  return (dir) => {
    let hit = listed.get(dir)
    if (!hit) {
      hit = read(dir).then(
        (entries) => entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory(), ...(entry.isSymbolicLink() ? { link: true } : {}) })),
        () => undefined,
      )
      listed.set(dir, hit)
    }
    return hit
  }
}

/** Existe (e, com `dir`, é pasta), seguindo o link. */
async function existsAs(path: string, dir: boolean): Promise<boolean> {
  try {
    const found = await stat(path)
    return !dir || found.isDirectory()
  } catch {
    return false
  }
}

/**
 * Os caminhos que existem e casam um padrão absoluto com curinga; nada se ele não tem curinga (o runtime o lê). ⚡ Sem
 * travar o servidor: assíncrona e em paralelo (ver `READ_DENY_WALK_CONCURRENCY`); a síncrona prendia o thread ~1,5 s por
 * comando numa worktree e ~4 s na raiz do projeto (27/11).
 */
export async function expandGlobPath(path: string, list: TGlobLister = globLister()): Promise<string[]> {
  const whole = path.endsWith('/**')
  const base = whole ? path.slice(0, -3) : path
  if (!/[*?[\]{}]/.test(base) || !isAbsolute(base)) return []
  const segments = base.split('/').filter(Boolean)
  const found = new Set<string>()
  let visited = 0
  // Desce segmento a segmento: o literal só entra; o curinga lista a pasta; o `**` vale zero ou mais pastas.
  const queue: Array<{ dir: string; rest: readonly string[] }> = [{ dir: '/', rest: segments }]
  await drainConcurrently(
    queue,
    READ_DENY_WALK_CONCURRENCY,
    async ({ dir, rest }) => {
      visited += 1
      const [head, ...tail] = rest
      if (head === undefined) {
        found.add(dir)
        return
      }
      if (head === '**') {
        queue.push({ dir, rest: tail })
        // ⚖️ O `**` não atravessa as worktrees (cada uma repete o repositório inteiro); quem quer uma worktree a nomeia
        // (`_worktrees/*/evidence/**`).
        for (const entry of (await list(dir)) ?? []) if (entry.dir && !GLOB_SKIP.has(entry.name) && !WORKTREE_DIRS.has(entry.name)) queue.push({ dir: join(dir, entry.name), rest })
        return
      }
      if (!/[*?[\]{}]/.test(head)) {
        const next = join(dir, head)
        // O literal segue o link (no Mac, `/var` é `/private/var`): pela listagem já lida; sem ela (pasta só de passagem), pelo `stat`.
        const entries = await list(dir)
        const entry = entries?.find((item) => item.name === head)
        const ok = entries === undefined || entry?.link ? await existsAs(next, tail.length > 0) : !!entry && (!tail.length || entry.dir)
        if (ok) queue.push({ dir: next, rest: tail })
        return
      }
      const matcher = globToRegex(head)
      for (const entry of (await list(dir)) ?? [])
        if (matcher.test(entry.name) && (tail.length ? entry.dir : !whole || entry.dir)) queue.push({ dir: join(dir, entry.name), rest: tail })
    },
    () => found.size >= GLOB_EXPAND_LIMIT || visited > GLOB_VISIT_LIMIT,
  )
  return [...found]
    .sort()
    .slice(0, GLOB_EXPAND_LIMIT)
    .map((item) => (whole ? `${item}/**` : item))
}

/** Teto da busca dos modelos: numa árvore maior, o que sobra fica escondido (falha fechada). */
const FIND_LIMIT = 100_000

/** O que a varredura de uma raiz achou: os arquivos (caminho relativo) e as pastas de worktree (não varridas). */
export interface ITreeIndex {
  files: string[]
  worktreeDirs: string[]
}

/**
 * A varredura da raiz: os arquivos, sem descer em `node_modules` nem nas pastas `.git` (lá dentro segue escondido), e as
 * pastas de worktree à parte. O `glob` do Node não serve: o `**` dele pula as entradas com ponto.
 *
 * ⚖️ Desce também em repositório ou worktree ANINHADO (`repositories/x`, `repositories/x/_worktrees/EP-1`): é lá que os
 * `.env.example` do projeto moram, e o cerco os trocava por /dev/null (o lint-staged parava em "Backing up original state").
 * Em LARGURA: o que está perto da raiz entra antes do teto, e um checkout fundo não gasta a cota dos rasos.
 *
 * ⛔ ASSÍNCRONA (a do `TreeIndexCache`): a síncrona, num projeto grande, prendia o servidor inteiro ~2 s a cada comando de
 * terminal de um agente — e todo pedido esperava, inclusive a troca de conversa na tela (16/11).
 */
async function walkTree(root: string, read: (dir: string) => Promise<Dirent[]>): Promise<ITreeIndex> {
  const files: string[] = []
  const worktreeDirs: string[] = []
  const pending = ['']
  let seen = 0
  // ⚡ Em paralelo (ver `READ_DENY_WALK_CONCURRENCY`): uma pasta por vez, cada leitura esperava uma volta do loop.
  await drainConcurrently(
    pending,
    READ_DENY_WALK_CONCURRENCY,
    async (dir) => {
      let entries: Dirent[]
      try {
        entries = await read(join(root, dir))
      } catch {
        return
      }
      for (const entry of entries) {
        seen += 1
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          if (WORKTREE_DIRS.has(entry.name)) worktreeDirs.push(path)
          else pending.push(path)
        } else if (entry.isFile()) files.push(path)
      }
    },
    () => seen >= FIND_LIMIT,
  )
  return { files, worktreeDirs }
}

/** A mesma varredura, síncrona: o `findUnder` (quem ainda não tem a guardada). */
function walkTreeSync(root: string): ITreeIndex {
  const files: string[] = []
  const worktreeDirs: string[] = []
  const pending = ['']
  let seen = 0
  for (let next = 0; next < pending.length && seen < FIND_LIMIT; next += 1) {
    const dir = pending[next]!
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
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        if (WORKTREE_DIRS.has(entry.name)) worktreeDirs.push(path)
        else pending.push(path)
      } else if (entry.isFile()) files.push(path)
    }
  }
  return { files, worktreeDirs }
}

/**
 * ⚖️ O FILTRO BARATO antes do padrão: o último trecho do padrão (sem `**`) tem de casar o NOME do arquivo — o `*` não
 * atravessa a barra, então quem casa o padrão inteiro casa esse trecho no nome. Nome é curto: a conta é de microssegundos,
 * e o padrão completo (que é proporcional ao caminho) só roda para os poucos que passam.
 */
function nameFilter(pattern: string): (name: string) => boolean {
  const last = pattern.trim().replace(/^\.\//, '').split('/').pop() ?? ''
  if (!last || last.includes('**')) return () => true
  // O começo e o fim LITERAIS do trecho (antes do primeiro coringa, depois do último): condição necessária, e só
  // comparação de texto. O padrão completo confere depois.
  const first = last.search(/[*?]/)
  if (first < 0) return (name) => name === last
  const prefix = last.slice(0, first)
  const suffix = last.slice(Math.max(last.lastIndexOf('*'), last.lastIndexOf('?')) + 1)
  return (name) => name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
}

/** Os arquivos de um padrão relativo dentro de uma varredura, com os modelos espelhados em cada worktree. */
function matchTemplates(root: string, index: ITreeIndex, pattern: string): string[] {
  if (isAbsolute(pattern) || pattern.startsWith('~')) return []
  const byName = nameFilter(pattern)
  const found = index.files.filter((path) => byName(path.slice(path.lastIndexOf('/') + 1)) && pathMatches(pattern, path))
  // ⚖️ As worktrees não são varridas (a árvore principal já gasta o teto, e cada uma repete os modelos dela): para cada
  // modelo do repositório, o MESMO caminho em cada worktree. Sem isso, o `git diff`/`merge` na worktree via o modelo
  // versionado como /dev/null ("unsupported file type") e o commit do épico travava (07/11). Vêm depois dos da árvore
  // principal, e o teto (abaixo) corta por elas.
  const mirrored = index.worktreeDirs.flatMap((worktrees) => {
    const repo = posix.dirname(worktrees) === '.' ? '' : posix.dirname(worktrees)
    const own = repo ? found.filter((path) => path.startsWith(`${repo}/`)) : found
    if (!own.length) return []
    let names: string[]
    try {
      names = readdirSync(join(root, worktrees), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    return names.flatMap((name) =>
      own
        .map((path) => `${worktrees}/${name}/${repo ? path.slice(repo.length + 1) : path}`)
        .filter((path) => {
          try {
            return lstatSync(join(root, path)).isFile()
          } catch {
            return false
          }
        }),
    )
  })
  // ⛔ Teto de modelos reabertos (cada um é uma montagem no bwrap, que para em ~9000 argumentos): passou, o resto fica
  // escondido, como antes — o terminal nunca quebra por isso.
  return [...found, ...mirrored].slice(0, TEMPLATE_LIMIT)
}

/** Os arquivos de um padrão relativo dentro da raiz (ver `walkTree` e `matchTemplates`). Síncrono: lê a árvore agora. */
export function findUnder(root: string, pattern: string): string[] {
  if (isAbsolute(pattern) || pattern.startsWith('~')) return []
  return matchTemplates(root, walkTreeSync(root), pattern)
}

/** Quanto a varredura de uma raiz vale: depois disso, o próximo comando usa a de antes e uma nova roda em segundo plano. */
export const TREE_INDEX_TTL_MS = 60_000

/**
 * ⚖️ A VARREDURA GUARDADA, por raiz: lida sem travar o servidor (assíncrona) e reaproveitada por `TREE_INDEX_TTL_MS`;
 * vencida, o comando segue com a de antes e uma nova roda em segundo plano. O padrão casado fica guardado junto, até a
 * próxima varredura. O modelo criado nesse meio-tempo fica escondido até a renovação (falha fechada, como o teto).
 */
export class TreeIndexCache {
  private readonly entries = new Map<string, { at: number; index: ITreeIndex; matches: Map<string, string[]>; refreshing?: Promise<void> }>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly read: (dir: string) => Promise<Dirent[]> = (dir) => readdir(dir, { withFileTypes: true }),
  ) {}

  /** Garante uma varredura da raiz: a primeira espera (sem travar o servidor); a vencida renova em segundo plano. */
  async warm(root: string): Promise<void> {
    const entry = this.entries.get(root)
    if (!entry) return this.refresh(root)
    if (this.now() - entry.at >= TREE_INDEX_TTL_MS && !entry.refreshing) void this.refresh(root).catch(() => undefined)
  }

  /** Os arquivos do padrão na raiz: da varredura guardada; sem ela, a síncrona de sempre. */
  find(root: string, pattern: string): string[] {
    const entry = this.entries.get(root)
    if (!entry) return findUnder(root, pattern)
    let hit = entry.matches.get(pattern)
    if (!hit) {
      hit = matchTemplates(root, entry.index, pattern)
      entry.matches.set(pattern, hit)
    }
    return hit
  }

  private refresh(root: string): Promise<void> {
    const current = this.entries.get(root)
    if (current?.refreshing) return current.refreshing
    const refreshing = walkTree(root, this.read).then((index) => {
      this.entries.set(root, { at: this.now(), index, matches: new Map() })
    })
    if (current) current.refreshing = refreshing.finally(() => (current.refreshing = undefined))
    return refreshing
  }
}

/** As pastas onde moram as worktrees de um repositório (`git worktree add _worktrees/EP-1`). */
const WORKTREE_DIRS = new Set(['_worktrees', '.worktrees'])
/** Quantos modelos (`.env.example`…) o cerco reabre no máximo: cada um custa montagens no bwrap (teto de ~3000). */
const TEMPLATE_LIMIT = 400

/**
 * ⛔ Onde moram os sockets do HOST, fechados no Linux (onde o cerco libera socket Unix): o `docker.sock` (o usuário do
 * gateway está no grupo docker: um contêiner privilegiado seria root no host), o bus do systemd (`systemd-run --user`
 * roda fora do cerco) e o `/tmp` e `/var/tmp` (ssh-agent, outros processos). O comando usa o TMPDIR dele, na pasta do projeto;
 * o `/tmp` e o `/var/tmp` que ele vê são vazios e só dele, descartados no fim (ver `privateTmp` em `terminalRefusal`).
 */
export function hostSocketDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'linux' ? ['/run', '/var/run', '/tmp', '/var/tmp'] : []
}

/** A ponte do proxy mora no `/tmp` do host, que o cerco fecha: só os sockets dela voltam (sem eles, a rede cai). */
function bridgeSockets(manager: ISandboxManager): string[] {
  return [...new Set([manager.getLinuxHttpSocketPath?.(), manager.getLinuxSocksSocketPath?.()].filter((path): path is string => !!path))]
}

/**
 * ⚖️ O repositório principal que a worktree `root` lê (ver `ICercoBase.checkout`): as entradas dele, menos o `.git` e a pasta
 * que contém a worktree. ⛔ Sem link simbólico: o bind seguiria o alvo, que pode morar fora do repositório.
 */
export function mainCheckout(
  dir: string,
  root: string,
  entries: (dir: string) => Array<{ name: string; link: boolean }> = listEntriesWithLinks,
): { dir: string; entries: string[] } {
  const paths = entries(dir)
    .filter((entry) => entry.name !== '.git' && !entry.link && !isAtOrUnder(root, join(dir, entry.name)))
    .map((entry) => join(dir, entry.name))
  return { dir, entries: paths }
}

function listEntriesWithLinks(dir: string): Array<{ name: string; link: boolean }> {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, link: entry.isSymbolicLink() }))
  } catch {
    return []
  }
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

/** O teto do `.gitconfig` que o servidor lê para acrescentar a linha do proxy: maior que isto, ele não mexe. */
const GITCONFIG_MAX_BYTES = 1024 * 1024

/**
 * ⛔ A casa do comando (`.home`) é do AGENTE: ele grava nela de dentro do cerco, e o servidor grava nela de FORA, com os
 * direitos dele. Um link plantado ali (`.gitconfig` → o banco, a chave dos segredos) era lido e regravado pelo servidor;
 * um link sem alvo fazia o servidor criar o arquivo onde o agente quisesse; um FIFO travava o processo inteiro na
 * leitura. Tudo o que o servidor abre na casa passa por aqui: a casa tem de ser pasta de verdade (não um link), o
 * arquivo abre sem seguir link e sem bloquear, e só vale arquivo comum com um nome só (o hard link de um arquivo de
 * outro lugar tem dois). `undefined` = não é do servidor mexer.
 * ⚠️ A pasta é conferida antes e depois de abrir. Trocá-la por um link exatamente nesse intervalo ainda alcança um
 * arquivo COM ESTE NOME noutra pasta, e o que se grava é fixo (a linha do proxy, o auxiliar do SSH): nada do agente.
 */
function openInHome(home: string, name: string, flags: number): number | undefined {
  let fd: number | undefined
  try {
    const before = lstatSync(home)
    if (!before.isDirectory()) return undefined
    fd = openSync(join(home, name), flags | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600)
    const info = fstatSync(fd)
    const after = lstatSync(home)
    if (info.isFile() && info.nlink === 1 && after.isDirectory() && after.dev === before.dev && after.ino === before.ino) return fd
  } catch {
    // Um link, um FIFO, uma pasta no lugar do arquivo, a casa que sumiu: segue sem mexer.
  }
  if (fd !== undefined) closeSync(fd)
  return undefined
}

/** O que há no arquivo aberto, até o teto; `undefined` se passa dele (ou cresceu durante a leitura). */
function readCapped(fd: number, max: number): string | undefined {
  if (fstatSync(fd).size > max) return undefined
  const buffer = Buffer.alloc(max + 1)
  let length = 0
  for (;;) {
    const read = readSync(fd, buffer, length, buffer.length - length, length)
    if (!read) break
    length += read
    if (length > max) return undefined
  }
  return buffer.toString('utf8', 0, length)
}

/**
 * ⚖️ O git (libcurl) só manda a senha do proxy DEPOIS do 407, e o portão fecha a conexão junto com o 407: o `git fetch`
 * por HTTPS caía com "Proxy CONNECT aborted" mesmo com a regra de rede. `proxyAuthMethod = basic` manda o token já no
 * primeiro CONNECT, como o curl faz. Vai no `.gitconfig` da casa do comando, sem apagar o que o agente pôs lá: a linha
 * é ACRESCENTADA ao fim (nunca regrava o arquivo). ⛔ Só pelo `openInHome`: o arquivo é do agente.
 */
export function ensureGitProxyAuth(home: string): void {
  const existing = openInHome(home, '.gitconfig', fsc.O_RDWR | fsc.O_APPEND)
  // Com `O_EXCL` só cria onde não há NADA: um link (com ou sem alvo) no lugar faz a criação falhar.
  const fd = existing ?? openInHome(home, '.gitconfig', fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL)
  if (fd === undefined) return
  try {
    const current = existing === undefined ? '' : readCapped(fd, GITCONFIG_MAX_BYTES)
    if (current === undefined || /proxyAuthMethod/i.test(current)) return
    writeSync(fd, `${current && !current.endsWith('\n') ? '\n' : ''}[http]\n\tproxyAuthMethod = basic\n`)
  } catch {
    // Sem a linha, o git do agente pelo proxy falha como antes; o comando segue.
  } finally {
    closeSync(fd)
  }
}

/**
 * ⛔ PONTOS DE MONTAGEM: o bwrap (o srt, e o CLI do Claude com o dele, que nega `.env*`, `.npmrc`, `bunfig.toml`, `package.json`,
 * `.claude`, `node_modules/.bin`… na pasta onde roda) cria um arquivo vazio, ou uma pasta, para cada caminho negado que não
 * existe, como destino do bind de /dev/null. Se o processo cai ou reinicia no meio, o ponto fica: o `package.json` vazio
 * quebrava a resolução de módulos de tudo abaixo ("Invalid package config"). Esta é a lista EXATA do que se varre.
 * ⚖️ O modo do CLI que cercava assim saiu (ver `CLI_PROCESS_ENV`): a lista dele fica para varrer o que sobrou de antes.
 */
export const MOUNT_POINT_FILES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
  '.env.production',
  '.env.production.local',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  '.bunfig.toml',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.gitmodules',
  '.gitconfig',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
]
/** As pastas-ponto, de dentro para fora (`node_modules/.bin` antes de `node_modules`): só saem VAZIAS. */
export const MOUNT_POINT_DIRS: readonly string[] = ['node_modules/.bin', '.claude/commands', '.claude/agents', 'node_modules', '.claude']

/** Dos candidatos, os que o git rastreia (num repositório): esses nunca saem. Sem resposta do git, todos contam como rastreados. */
function trackedByGit(dir: string, names: readonly string[]): Set<string> {
  if (!names.length || !existsSync(join(dir, '.git'))) return new Set()
  // ⛔ O `.git` da pasta pode ser do agente: o git que pergunta por ele vai travado (`discoveredGitSync`).
  const out = discoveredGitSync(dir, ['ls-files', '-z', '--', ...names])
  return out === undefined ? new Set(names) : new Set(out.split('\0').filter(Boolean))
}

/**
 * ⛔ Varre os pontos de montagem que sobraram em `dir` (a raiz do projeto, a pasta de trabalho): SÓ arquivo de tamanho 0 e
 * pasta vazia da lista exata acima, sem seguir link (um link fica, e o alvo também) e nunca arquivo que o git rastreia
 * (dentro de repositório confere com `git ls-files`; na raiz do projeto não há repositório). Quem chama garante que nenhum
 * comando cercado roda. Registra no log o que apagou; devolve os caminhos. Falha de apagar não derruba o comando.
 */
export function sweepMountPoints(dir: string, log: (message: string) => void = (message) => console.warn(message)): string[] {
  if (!isRealDirectory(dir)) return []
  const removed: string[] = []
  const empties = MOUNT_POINT_FILES.filter((name) => {
    try {
      const stat = lstatSync(join(dir, name))
      return stat.isFile() && stat.size === 0
    } catch {
      return false
    }
  })
  const tracked = trackedByGit(dir, empties)
  for (const name of empties) {
    if (tracked.has(name)) continue
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {
      // Fica para a próxima varredura.
    }
  }
  for (const name of MOUNT_POINT_DIRS) {
    const path = join(dir, name)
    try {
      if (!isRealDirectory(path) || readdirSync(path).length) continue
      rmdirSync(path)
      removed.push(name)
    } catch {
      // Cheia (ou sem permissão): não é ponto de montagem.
    }
  }
  const paths = removed.map((name) => join(dir, name))
  if (paths.length) log(`[sandbox] sobra de ponto de montagem apagada: ${paths.join(', ')}`)
  return paths
}

/** Os projetos e os repositórios deles em `<dados>/projects`: a varredura do boot (o que um processo anterior deixou). */
export function sweepProjectMountPoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const base = join(dataDir(env), 'projects')
  const swept: string[] = []
  for (const project of listDir(base)) {
    const dir = join(base, project)
    swept.push(...sweepMountPoints(dir))
    for (const repository of listDir(join(dir, 'repositories'))) swept.push(...sweepMountPoints(join(dir, 'repositories', repository)))
    // As pastas de conversa (o `cwd` do CLI do Claude) que um processo anterior deixou.
    const conversations = join(dir, CONVERSATIONS_DIR)
    for (const conversation of listDir(conversations)) swept.push(...releaseConversationWorkspace(join(conversations, conversation)))
  }
  return swept
}

/**
 * ⛔ A conversa largou a pasta dela (`conversationWorkspace`, o `cwd` do CLI do Claude): varre os pontos de montagem que o
 * sandbox do CLI criou ali e apaga a pasta, SÓ se ficou vazia — o que o agente gravou nela fica. Devolve o que varreu.
 */
export function releaseConversationWorkspace(dir: string, log?: (message: string) => void): string[] {
  const swept = sweepMountPoints(dir, log)
  try {
    if (isRealDirectory(dir) && !readdirSync(dir).length) rmdirSync(dir)
  } catch {
    // Em uso ou sem permissão: fica para a próxima.
  }
  return swept
}

/**
 * A varredura do boot dos logs de comando (`<dados>/run/logs`): a lista de processos vive na memória, então depois de um
 * reinício ninguém mais lê esses arquivos (saída crua, até 20 MB cada) e eles ficavam no disco para sempre.
 */
export function sweepCommandLogs(env: NodeJS.ProcessEnv = process.env): void {
  try {
    rmSync(join(dataDir(env), 'run', 'logs'), { recursive: true, force: true })
  } catch {
    // Sem permissão ou em uso: fica para o próximo boot.
  }
}

let sweepOnExit: Set<string> | undefined
/**
 * No desligamento do gateway (saída normal ou SIGTERM/SIGINT) varre as pastas onde houve comando cercado. Sem o sinal tratado o
 * processo morria sem rodar nada. O sinal é reenviado depois da varredura: o fim é o de sempre.
 */
function trackSweepOnExit(dirs: Set<string>): void {
  if (sweepOnExit) return
  sweepOnExit = dirs
  const sweep = () => {
    for (const dir of dirs) sweepMountPoints(dir)
  }
  process.once('exit', sweep)
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      sweep()
      process.kill(process.pid, signal)
    })
}

/** A marca da limpeza dos restos de antes da correção M4 (dentro do `.cache` do projeto). */
const LEGACY_CLEANUP_MARK = '.gateway-limpeza-m4'
const cleanedProjects = new Set<string>()

/** `true` se o caminho é uma pasta de verdade (nem link, nem arquivo). */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * ⛔ Restos de ANTES da correção M4, que ficaram no rascunho do projeto: `.home/.accounts/*` (chaves SSH de comandos antigos),
 * `.cache/logs/*` e `.cache/proxychains-*.conf` (o token de rede). Uma vez por projeto (marca no `.cache` + memória), idempotente,
 * só estes caminhos exatos. Não segue link: se `.home` ou `.cache` não é pasta de verdade, nada se apaga; um link dentro deles
 * sai como link (o alvo fica). Falha de apagar não derruba o comando.
 */
export function cleanLegacyScratch(base: string): void {
  if (cleanedProjects.has(base)) return
  cleanedProjects.add(base)
  try {
    const home = join(base, '.home')
    const cache = join(base, '.cache')
    const mark = join(cache, LEGACY_CLEANUP_MARK)
    if (!isRealDirectory(cache) || existsSync(mark)) return
    if (isRealDirectory(home)) rmSync(join(home, '.accounts'), { recursive: true, force: true })
    const logs = join(cache, 'logs')
    if (isRealDirectory(logs)) for (const entry of readdirSync(logs)) rmSync(join(logs, entry), { recursive: true, force: true })
    for (const entry of readdirSync(cache)) if (/^proxychains-.*\.conf$/.test(entry)) rmSync(join(cache, entry), { force: true })
    writeFileSync(mark, `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch {
    // Fica para o próximo comando: a memória só guarda o que deu certo.
    cleanedProjects.delete(base)
  }
}

/**
 * O auxiliar de ProxyCommand do SSH: abre um CONNECT na porta do gateway (com o token do `HTTPS_PROXY`) e liga a
 * entrada e a saída do ssh ao túnel. Escrito na HOME do comando (dentro do cerco), que ele pode ler.
 */
// O nome muda com a versão do auxiliar: o arquivo é gravado uma vez só (`O_EXCL`), e a casa do comando guarda o antigo.
export const CONNECTOR_NAME = '.gateway-connect-v2.cjs'
const CONNECTOR_SOURCE = [
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
  "  const head = buffer.toString('utf8', 0, end)",
  '  if (!/^HTTP\\/1\\.[01] 200/.test(head)) {',
  // ⛔ O MOTIVO da recusa vem no corpo (o portão o escreve): antes só o cabeçalho saía, e o agente via "403" sem saber por
  // quê — achava que era o app e pedia reinício (24/11). Agora sai a linha que ele precisa ("rede local: só com regra exata").
  "    let body = buffer.subarray(end + 4).toString('utf8')",
  "    const status = head.split('\\r\\n')[0]",
  "    const done = () => { process.stderr.write('gateway: conexão a ' + host + ':' + port + ' recusada (' + status + '): ' + (body.trim() || 'sem motivo') + '\\n'); process.exit(1) }",
  "    socket.on('data', (more) => { body += more.toString('utf8') })",
  "    socket.on('end', done)",
  '    setTimeout(done, 1000)',
  '    return',
  '  }',
  '  const rest = buffer.subarray(end + 4)',
  '  if (rest.length) process.stdout.write(rest)',
  '  socket.pipe(process.stdout)',
  '  process.stdin.pipe(socket)',
  '}',
  "socket.on('data', onHead)",
  "socket.on('error', (error) => { process.stderr.write(String(error) + '\\n'); process.exit(1) })",
  '',
].join('\n')

/**
 * Grava o auxiliar na casa do comando, uma vez (o que já existe fica), e devolve o caminho dele. ⛔ Só pelo `openInHome`,
 * e criando com `O_EXCL`: um link plantado no lugar não leva o servidor a gravar noutro arquivo. O auxiliar só roda
 * DENTRO do cerco: a cópia que o agente trocou não alcança nada além do que ele já alcança.
 */
export function writeConnector(home: string): string {
  const fd = openInHome(home, CONNECTOR_NAME, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL)
  if (fd !== undefined) {
    try {
      writeSync(fd, CONNECTOR_SOURCE)
    } catch {
      // Sem o auxiliar, o ssh do agente pelo proxy falha; o comando segue.
    } finally {
      closeSync(fd)
    }
  }
  return join(home, CONNECTOR_NAME)
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * As pastas em que um comando cercado no Mac pode abrir e alcançar Unix socket: a dos projetos (`<dados>/projects`) e a das
 * conversas sem projeto (`<tmp>/gateway-sub`), pelo caminho REAL (o `/var` do Mac é link para `/private/var`).
 */
export function macSocketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [join(dataDir(env), 'projects'), join(tmpdir(), 'gateway-sub')].map((dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return realpathSync(dir)
  })
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

/**
 * 🖥️ O que o agente de máquina NUNCA alcança, mesmo no cerco aberto: o banco, as chaves e os backups do gateway (as regras
 * da instalação fazem o mesmo pelo padrão), a pasta privada de cada comando (a chave SSH e o token de rede dos outros), a
 * configuração do gateway (no Mac, `~/Library/Application Support/Agents Gateway`, com o `config.env`), o LaunchAgent dele,
 * a pasta de onde ele roda (o app, ou o repositório com o `.env`) e as pastas privadas dos outros agentes.
 */
export function machineDenied(env: NodeJS.ProcessEnv = process.env, others: readonly string[] = [], execPath: string = process.execPath): string[] {
  const data = dataDir(env)
  const app = /^(.*?\.app)\//.exec(execPath)?.[1]
  return [
    ...['*.db', '*.db-*', 'secrets*', 'backup*', '*-home', 'run'].map((name) => join(data, name)),
    join(homedir(), 'Library', 'Application Support', 'Agents Gateway'),
    join(homedir(), 'Library', 'LaunchAgents', 'com.agents-gateway.server.plist'),
    process.cwd(),
    ...(app ? [app] : []),
    ...others,
  ]
}
