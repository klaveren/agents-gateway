import { liveLimit } from '@domain/models/Limits.Model'
import path from 'node:path'
import { analyzeShell, type IShellCommand } from '@infra/permissions/Shell.Parse'

export interface IBashPolicy {
  /** Tempo máximo por comando. */
  timeoutMs: number
  /** Corte do stdout/stderr devolvido ao modelo. */
  maxOutputChars: number
  /** Diretório onde o comando roda. */
  cwd: string
}

const DEFAULT_TIMEOUT_MS = 120_000
/** O motivo do `sudo` (ver `remoteSudoAllowed`: dentro do `ssh`, com regra que o cite, passa). */
export const PRIVILEGE_ESCALATION = 'privilege escalation'
/** O motivo de desligar ou reiniciar a máquina. Como o sudo, decidido pelos comandos que rodam (ver `realReasons`). */
export const HOST_POWER = 'host power control'
const DEFAULT_MAX_OUTPUT_CHARS = 4_000

/**
 * Padrões que negamos sempre.
 *
 * Não é um sandbox e não pretende ser: é uma trava contra o comando catastrófico
 * digitado por engano — ou alucinado pelo modelo. Contenção de verdade é isolar o
 * processo (container, usuário sem privilégio), não filtrar string.
 */
const DENIED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // ⚖️ Só as OPÇÕES do `rm` (`-rf`, `-r -f`, `--recursive --force`), nunca o texto do caminho: "-surf" em
  // `mcp-tool-surface.md` casava e recusava um `git rm` inocente.
  {
    pattern: /\brm\b(?=[^|;&\n]*\s(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$))(?=[^|;&\n]*\s(?:-[a-z]*f[a-z]*|--force)(?=\s|$))/i,
    reason: 'recursive force delete',
  },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem format' },
  { pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//i, reason: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: 'redirect into a block device' },
  { pattern: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: 'fork bomb' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/i, reason: 'pipe from network straight into a shell' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: HOST_POWER },
  { pattern: /\bchmod\b[^|;&\n]*-[a-z]*R[a-z]*\s+777\s+\//i, reason: 'recursive world-writable on a root path' },
  { pattern: /\bsudo\b/i, reason: PRIVILEGE_ESCALATION },
]

export function bashPolicy(): IBashPolicy {
  return {
    timeoutMs: liveLimit('bashTimeoutMs') ?? readPositiveInt(process.env.BASH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputChars: liveLimit('bashMaxOutputChars') ?? readPositiveInt(process.env.BASH_MAX_OUTPUT_CHARS, DEFAULT_MAX_OUTPUT_CHARS),
    // ⛔ Sem `BASH_CWD`, o diretório vazio da conversa (ver `run_bash`) — nunca a pasta do gateway.
    cwd: process.env.BASH_CWD ? path.resolve(process.env.BASH_CWD) : '',
  }
}

/** Devolve o motivo da recusa, ou `undefined` se o comando passa. */
export function denyReason(command: string): string | undefined {
  return deniedReasons(command)[0]
}

/** Todos os motivos que o TEXTO do comando casa, na ordem da lista. */
export function deniedReasons(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return ['empty command']
  return DENIED.filter((rule) => rule.pattern.test(trimmed)).map((rule) => rule.reason)
}

/** Os motivos que o texto acusa mas só valem se o COMANDO roda (o sudo, o reboot): a palavra num grep ou num texto não conta. */
export const COMMAND_REASONS: ReadonlySet<string> = new Set([PRIVILEGE_ESCALATION, HOST_POWER])

const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff'])
const ESCALATE = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0'])
const SYSTEMCTL_POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'kexec', 'soft-reboot'])

/** Um comando que exige regra própria para rodar no host (ou nem isso, no local): o motivo e a palavra que a regra tem de citar. */
export interface IPrivileged {
  reason: string
  cite: string
}

/**
 * ⛔ O comando PRIVILEGIADO: a escalada (`sudo`, `doas`, `su`, `pkexec`, `run0`, `machinectl shell`) e o que desliga ou reinicia a
 * máquina (`reboot`, `shutdown`, `poweroff`, `halt`, `init 0|6`, `systemctl reboot|poweroff|halt|kexec`). `name` é a base do argv[0].
 */
export function privilegedOf(command: { name: string; argv: readonly string[] }): IPrivileged | undefined {
  const { name, argv } = command
  const rest = argv.slice(1)
  if (ESCALATE.has(name)) return { reason: PRIVILEGE_ESCALATION, cite: name }
  if (name === 'machinectl' && rest.some((word) => word === 'shell' || word === 'login')) return { reason: PRIVILEGE_ESCALATION, cite: 'machinectl' }
  if (POWER.has(name)) return { reason: HOST_POWER, cite: name }
  if ((name === 'init' || name === 'telinit') && rest.some((word) => word === '0' || word === '6')) return { reason: HOST_POWER, cite: name }
  if (name === 'systemctl') {
    const verb = rest.find((word) => SYSTEMCTL_POWER.has(word))
    if (verb) return { reason: HOST_POWER, cite: verb }
  }
  return undefined
}

/** Tem o sudo e o reboot pelo texto; e os de fora da lista literal (`su''do`) só a análise vê. */
const BOTH_REASONS: readonly string[] = [PRIVILEGE_ESCALATION, HOST_POWER]

/**
 * ⚖️ O sudo e o reboot pelos comandos que RODAM (a análise do shell), não pelo texto: `grep "sudo"` e um script que só
 * cita "reboot" passavam por escalada. Comando que a análise não vê por inteiro: vale o texto (falha fechada). Sem
 * opacidade o texto não filtra: `su''do id` não tem a palavra, mas roda. O comando REMOTO do `ssh` é outra análise
 * (ver `remoteReasons`).
 */
export function realReasons(analysis: { commands: ReadonlyArray<{ name: string; argv: readonly string[] }>; opaque: readonly string[] }, textual: readonly string[]): string[] {
  if (analysis.opaque.length) return textual.filter((reason) => COMMAND_REASONS.has(reason))
  const found = new Set<string>()
  for (const command of analysis.commands) {
    const privileged = privilegedOf(command)
    if (privileged) found.add(privileged.reason)
  }
  return BOTH_REASONS.filter((reason) => found.has(reason))
}

/** Onde começa o comando remoto do `ssh`: depois das opções e do host. */
export function sshRemoteStart(argv: readonly string[]): number {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith('-')) {
    if (argv[i] === '--') {
      i += 1
      break
    }
    i += SSH_VALUE_OPTIONS.test(argv[i]!) ? 2 : 1
  }
  return i + 1
}

/** As opções do `ssh` que levam valor na palavra seguinte (`-o BatchMode=yes`, `-p 22`). */
const SSH_VALUE_OPTIONS = /^-[BbcDEeFIiJLlmOoPpQRSWw]$/

export interface IRemote {
  /** A linha que o shell REMOTO vai ler (as palavras depois do host, juntas por espaço, como o ssh faz). */
  line: string
  /** O que a análise não vê por inteiro (expansão no nome do comando, `eval`, erro de sintaxe…) ou o que o shell local monta antes. */
  opaque: boolean
  commands: IShellCommand[]
  /** Os comandos privilegiados da linha remota. */
  privileged: Array<{ command: IShellCommand; kind: IPrivileged }>
}

/**
 * ⛔ O COMANDO REMOTO DE UM `ssh`, analisado como shell (o de lá relê a linha): `ssh h "su''do id"`, `'x=sud; ${x}o id'`, `doas`,
 * `su -c`, `pkexec` e o `reboot` montado por aspas passavam pelo regex do texto. Falha fechada: palavra montada pelo shell
 * LOCAL (`$x`, `$(…)`) ou linha que a análise não vê por inteiro = opaca. Sem comando remoto (login), não há o que analisar.
 */
export async function remoteOf(ssh: IShellCommand, full: string = ssh.text): Promise<IRemote | undefined> {
  if (ssh.name !== 'ssh') return undefined
  const at = sshRemoteStart(ssh.argv)
  const words = ssh.argv.slice(at)
  if (!words.length) return undefined
  const line = words.join(' ')
  // Palavra que o shell local monta em execução: o texto resolvido não é o que o ssh recebe. Ssh embrulhado (`nohup ssh`) perde a marca: vale o texto.
  const dynamic = ssh.dynamicArgs ? ssh.dynamicArgs.filter((index) => index >= at).some((index) => localExpansionRisky(ssh.argv[index]!, full)) : /[$`]/.test(line)
  const analysis = await analyzeShell(line)
  const commands = analysis.commands
  const privileged = commands.flatMap((command) => {
    const kind = privilegedOf(command)
    return kind ? [{ command, kind }] : []
  })
  return { line, opaque: dynamic || analysis.opaque.length > 0, commands, privileged }
}

/**
 * ⛔ A palavra que o shell LOCAL expande antes do ssh. `$VAR` de uma variável que a própria linha NÃO atribui (o ambiente do
 * gateway: `ssh h "ls $HOME"`) segue; substituição de comando, expansão que não é um nome simples, ou variável que a linha
 * atribui (`y="; sudo id"; ssh h "echo $y"`) pode trazer outro comando: opaca.
 */
function localExpansionRisky(word: string, full: string): boolean {
  const simple = word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `$${name}`)
  if (/\$\(|`|\$\{|\$[^A-Za-z_]|\*|\?|\[/.test(simple)) return true
  const names = [...word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!)
  return names.some((name) => new RegExp(`(^|[\\s;&|(])((export|local|declare|readonly)\\s+)?${name}\\+?=|\\b(read|for|select)\\s+(-\\w+\\s+)*${name}\\b`).test(full))
}

/** Os motivos do `ssh` pela linha REMOTA: o privilegiado que roda lá, ou a linha opaca (conta como escalada). */
export async function remoteReasons(analysis: { commands: readonly IShellCommand[]; opaque: readonly string[] }, full?: string): Promise<string[]> {
  if (analysis.opaque.length) return []
  const found = new Set<string>()
  for (const command of analysis.commands) {
    const remote = await remoteOf(command, full)
    if (!remote) continue
    if (remote.opaque) found.add(PRIVILEGE_ESCALATION)
    for (const item of remote.privileged) found.add(item.kind.reason)
  }
  return BOTH_REASONS.filter((reason) => found.has(reason))
}

// ⛔ O COMANDO QUE O SSH (e quem o chama) RODA FORA DA ANÁLISE: `ssh -o ProxyCommand=…`, `scp -S prog`, `rsync -e prog`,
// `GIT_SSH_COMMAND=…`, `git -c core.sshCommand=…`. O programa que eles lançam não passa pelas regras de terminal; só vale o
// `ssh` simples (com opções), analisado de novo por dentro. Falha fechada.

/** As opções que levam valor (na palavra seguinte ou grudado), para ler os aglomerados `-vo X` como o getopt lê. */
const CLIENT_VALUE_OPTIONS: Record<string, string> = { ssh: 'BbcDEeFIiJLlmOoPpQRSWw', scp: 'cFiJloPS', sftp: 'BbcDFiJloPRSsX' }
/** As opções do ssh que lançam programa. */
const SSH_PROGRAM_OPTIONS = new Set(['proxycommand', 'localcommand', 'knownhostscommand'])
const PLAIN_SSH_PROGRAMS = ['ssh', '/usr/bin/ssh', '/bin/ssh']

/** Separa uma linha em palavras com aspas simples e duplas; `undefined` se as aspas não fecham. */
function splitWords(text: string): string[] | undefined {
  const words: string[] = []
  let current = ''
  let quote = ''
  let started = false
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) words.push(current)
      current = ''
      started = false
    } else {
      current += char
    }
  }
  if (quote) return undefined
  if (started || current) words.push(current)
  return words
}

/**
 * ⛔ `ssh` SIMPLES com opções: o programa é o `ssh` (sem caminho próprio), sem nada que o shell interprete (`;|&$`<>()\`) e sem
 * opção que lance outro programa. É o que se aceita num `ProxyCommand`, `core.sshCommand`, `GIT_SSH_COMMAND` e `rsync -e`.
 */
function plainSshCommand(text: string): boolean {
  if (/[;&|`$<>()\\\n]/.test(text)) return false
  const words = splitWords(text.trim())
  if (!words?.length || !PLAIN_SSH_PROGRAMS.includes(words[0]!)) return false
  return !clientRefusal(words, 'ssh')
}

/** A opção `-o` do ssh: as que lançam programa só valem com `ssh` simples (ou `none`). */
function sshOptionRefusal(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = value.trim().split(/[=\s]/, 1)[0] ?? ''
  if (/[$`]/.test(name)) return 'opção do ssh montada em execução (-o)'
  const key = name.toLowerCase()
  if (key === 'include') return 'ssh -o Include carrega um arquivo de configuração que pode lançar programa'
  if (!SSH_PROGRAM_OPTIONS.has(key)) return undefined
  const argument = value
    .trim()
    .slice(name.length)
    .replace(/^\s*=?\s*/, '')
  const bare = argument.replace(/^(["'])(.*)\1$/, '$2')
  if (bare.toLowerCase() === 'none' || (key === 'knownhostscommand' && !bare)) return undefined
  return plainSshCommand(bare) ? undefined : `ssh -o ${name}: só vale um \`ssh\` simples com opções`
}

/** `ssh`, `scp` e `sftp` pelas palavras: `-o` com programa, `-F` (arquivo de configuração) e `-S` do scp/sftp. */
function clientRefusal(argv: readonly string[], tool: 'ssh' | 'scp' | 'sftp'): string | undefined {
  const valued = CLIENT_VALUE_OPTIONS[tool]!
  let hostSeen = tool !== 'ssh'
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i]!
    if (word === '--') {
      if (tool === 'ssh' && !hostSeen) {
        i += 1
        hostSeen = true
        continue
      }
      break
    }
    // O ssh relê as opções depois do host (`ssh h -o X cmd`) até a primeira palavra solta, que já é o comando remoto.
    if (!word.startsWith('-') || word === '-') {
      if (hostSeen && tool === 'ssh') break
      hostSeen = true
      continue
    }
    for (let j = 1; j < word.length; j += 1) {
      const letter = word[j]!
      if (!valued.includes(letter)) continue
      const rest = word.slice(j + 1)
      const value = rest || argv[i + 1]
      if (!rest) i += 1
      if (letter === 'o') {
        const refused = sshOptionRefusal(value)
        if (refused) return refused
      } else if (letter === 'F' && value !== '/dev/null') return `${tool} -F: arquivo de configuração do ssh pode lançar programa (ProxyCommand, Match exec)`
      else if (letter === 'S' && tool !== 'ssh' && !PLAIN_SSH_PROGRAMS.includes(value ?? '')) return `${tool} -S: só o \`ssh\``
      break
    }
  }
  return undefined
}

/** `rsync -e CMD` / `--rsh=CMD` / `--rsync-path=CMD`: o programa de transporte tem de ser o `ssh` simples. */
function rsyncRefusal(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i]!
    if (word === '--') break
    if (word.startsWith('--')) {
      const flag = word.split('=', 1)[0]!
      const inline = word.includes('=') ? word.slice(word.indexOf('=') + 1) : undefined
      if (flag !== '--rsh' && flag !== '--rsync-path') continue
      const value = inline ?? argv[i + 1]
      if (inline === undefined) i += 1
      if (flag === '--rsh' && !plainSshCommand(value ?? '')) return 'rsync --rsh: só vale um `ssh` simples com opções'
      if (flag === '--rsync-path' && !/^[A-Za-z0-9_./-]+$/.test(value ?? '')) return 'rsync --rsync-path: só o caminho do rsync remoto (o comando remoto passa por regra própria)'
      continue
    }
    if (!word.startsWith('-') || word === '-') continue
    for (let j = 1; j < word.length; j += 1) {
      if (!'eBfTM'.includes(word[j]!)) continue
      const rest = word.slice(j + 1)
      const value = rest || argv[i + 1]
      if (!rest) i += 1
      if (word[j] === 'e' && !plainSshCommand(value ?? '')) return 'rsync -e: só vale um `ssh` simples com opções'
      break
    }
  }
  return undefined
}

/** `git -c core.sshCommand=…`, `git config core.sshCommand …`, `--config-env=core.sshCommand=VAR`. */
function gitSshRefusal(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i += 1) {
    const word = argv[i]!
    const at = word.toLowerCase().indexOf('core.sshcommand')
    if (at < 0) continue
    if (word.startsWith('--config-env')) return 'git --config-env=core.sshCommand: o programa vem de uma variável'
    const equals = word.indexOf('=', at)
    const value = equals >= 0 ? word.slice(equals + 1) : argv[i + 1]
    if (value !== undefined && value !== '' && !plainSshCommand(value)) return 'git core.sshCommand: só vale um `ssh` simples com opções'
  }
  return undefined
}

/**
 * ⛔ A variável de ambiente que troca o programa de transporte, vista no TEXTO da linha (`GIT_SSH_COMMAND=… git pull`, `export …`,
 * `env …`): o valor tem de ser o `ssh` simples. `GIT_CONFIG_KEY_n=core.sshCommand` e `GIT_CONFIG_PARAMETERS` pelo mesmo caminho.
 */
function transportEnvRefusal(full: string): string | undefined {
  for (const match of full.matchAll(/\b(GIT_SSH_COMMAND|GIT_SSH|RSYNC_RSH)\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]*)/g)) {
    const value = match[2]!.replace(/^(["'])(.*)\1$/, '$2')
    if (value && !plainSshCommand(value)) return `${match[1]}: só vale um \`ssh\` simples com opções`
  }
  if (/\bGIT_CONFIG_(?:KEY_\d+|PARAMETERS)\s*=[^\n;&|]*core\.sshcommand/i.test(full)) return 'GIT_CONFIG_*: core.sshCommand não vem por variável de ambiente'
  return undefined
}

/**
 * ⛔ O motivo de recusar uma linha que lança outro programa pelo transporte do ssh, ou nada. `scp` e `rsync` comuns (cópia), e o
 * `ssh` sem essas opções, seguem as regras de terminal e de rede de sempre.
 */
export function transportRefusal(commands: ReadonlyArray<{ name: string; argv: readonly string[] }>, full: string): string | undefined {
  const fromEnv = transportEnvRefusal(full)
  if (fromEnv) return fromEnv
  for (const { name, argv } of commands) {
    const refused =
      name === 'ssh' || name === 'scp' || name === 'sftp' ? clientRefusal(argv, name) : name === 'rsync' ? rsyncRefusal(argv) : name === 'git' ? gitSshRefusal(argv) : undefined
    if (refused) return refused
  }
  return undefined
}

export function truncate(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  return `${output.substring(0, maxChars)}\n...[truncated at ${maxChars} characters]`
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
