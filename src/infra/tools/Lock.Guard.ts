import type { IPermissionAsker, IPermissionChecker } from '@application/Permissions.Service'
import { commandMatches, type IPermissionRule } from '@domain/Permission.Policy'
import { analyzeShell, type IShellAnalysis, type IShellCommand } from '@infra/permissions/Shell.Parse'
import { posix } from 'node:path'
import {
  COMMAND_REASONS,
  deniedReasons,
  type IRemote,
  privilegedOf,
  PRIVILEGE_ESCALATION,
  realReasons,
  remoteOf,
  remoteReasons,
  sshRemoteStart,
  textLockCited,
  textLockHits,
} from './Bash.Guard'

/**
 * ⚖️ REGRA EXATA LIBERA. As travas do terminal (as de texto, `rm -rf`, `mkfs`…; o privilegiado local ou remoto, `sudo`, `reboot`;
 * a linha remota que o gateway não lê, `ssh h bash -s < script`) valem por padrão, e cedem a uma regra de terminal `allow`
 * aprovada pelo admin que CASE o comando e CITE a parte travada. O curinga genérico (`*`, `bash *`, `rm *`) nunca libera.
 * O gateway não decide por cima do admin: o que a regra exata habilita, roda. A negação (`deny`) vence sempre.
 */

/** Um trecho travado: o motivo, o trecho e por que não passa (com a regra que o liberaria). */
export interface ILockGap {
  reason: string
  text: string
  why: string
}

/** As regras de terminal que LIBERAM, do agente e do projeto (as do sistema são o piso, não liberam trava). */
export function allowTerminalRules(permissions: IPermissionChecker, asker: IPermissionAsker): IPermissionRule[] {
  const layers = permissions.layers?.(asker)
  return [...(layers?.agent ?? []), ...(layers?.project ?? [])].filter((rule) => rule.category === 'terminal' && rule.decision === 'allow')
}

/** A regra CITA o privilegiado: a palavra dele (`sudo`, `reboot`) como palavra do padrão, e não só um curinga. */
export function cites(pattern: string, word: string): boolean {
  return pattern.split(/\s+/).some((part) => part.replace(/\*/g, ' ').split(/\s+/).includes(word))
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A palavra remota que o shell de lá lê como está. */
export const REMOTE_PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

const endsWith = (whole: readonly string[], tail: readonly string[]) => tail.every((word, index) => whole[whole.length - tail.length + index] === word)

/** A negação explícita (de qualquer camada) contra esta forma do comando, ou nada. */
function denialOf(permissions: IPermissionChecker, asker: IPermissionAsker, argv: readonly string[]): string | undefined {
  const verdict = permissions.check(asker, { category: 'terminal', value: argv.join(' '), argv: [...argv] }, { log: false })
  return !verdict.allowed && verdict.rule?.decision === 'deny' ? verdict.reason : undefined
}

/** A linha como o shell a lê, para comparar: sem aspas nem barra, os espaços repetidos não contam. */
const normalized = (text: string) => (/['"\\]/.test(text) ? text.trim() : text.trim().split(/\s+/).join(' '))
const unquoted = (text: string) => text.replace(/^(["'])(.*)\1$/, '$2')

/** A linha remota em palavras, logo depois do prefixo do ssh (`ssh -o X h bash -s`): a forma que a regra exata casa. */
export function remoteShape(argv: readonly string[], remote: IRemote): string[] {
  return [...argv.slice(0, sshRemoteStart(argv)), ...remote.line.trim().split(/\s+/)]
}

/**
 * ⚖️ A LINHA REMOTA OPACA (`ssh h bash -s < script`, `ssh h "eval …"`): o gateway não vê o que roda lá, e só a regra EXATA cobre —
 * a que casa as opções e o host (o `*` vale ali: `ssh * 10.10.0.4 bash -s`) e tem a parte remota IGUAL à linha, palavra por
 * palavra, sem `*` nem `?`. Aspas em volta da parte remota da regra não contam (`"bash -s"` ≡ `bash -s`). ⛔ A linha montada pelo
 * shell LOCAL (`$x`, `$(…)`) nunca: o texto que a regra viu não é o que o ssh recebe.
 */
export function exactRemoteRule(argv: readonly string[], remote: IRemote, rules: readonly IPermissionRule[]): IPermissionRule | undefined {
  if (!remote.opaque || remote.dynamic) return undefined
  const prefix = argv.slice(0, sshRemoteStart(argv))
  const line = normalized(remote.line)
  if (/[*?]/.test(line)) return undefined
  return rules.find((rule) => {
    const words = rule.pattern.trim().split(/\s+/)
    for (let at = 1; at < words.length; at += 1) {
      const tail = unquoted(words.slice(at).join(' '))
      if (/[*?]/.test(tail) || normalized(tail) !== line) continue
      if (commandMatches(words.slice(0, at).join(' '), prefix)) return true
    }
    return false
  })
}

/** Por que a linha remota opaca não passa, e a regra exata que a libera (ou por que a regra que existe não serve). */
function opaqueGap(part: IShellCommand, remote: IRemote, rules: readonly IPermissionRule[]): ILockGap {
  const at = sshRemoteStart(part.argv)
  const host = part.argv[at - 1] ?? 'host'
  if (remote.dynamic)
    return {
      reason: PRIVILEGE_ESCALATION,
      text: part.text,
      why: 'linha remota montada pelo shell local (`$x`, `$(…)`): o texto não é o que o ssh recebe, e nenhuma regra cobre. Escreva a linha remota por extenso',
    }
  const what = remote.reasons.includes('shell-stdin')
    ? 'script por stdin no host remoto (o gateway não vê o conteúdo)'
    : `linha remota que o gateway não consegue analisar (${remote.reasons.join('; ') || 'opaca'})`
  const example = `\`ssh * ${host} ${clip(remote.line, 100)}\``
  const shape = remoteShape(part.argv, remote)
  const near = rules.filter((rule) => commandMatches(rule.pattern, shape) || commandMatches(rule.pattern, part.argv)).map((rule) => `\`${clip(rule.pattern, 80)}\``)
  const unlike = near.length ? `; ${near.join(', ')} não cobre: com a linha opaca, a parte remota da regra tem de ser IGUAL à linha, sem curinga` : ''
  return { reason: PRIVILEGE_ESCALATION, text: part.text, why: `${what}: só passa com regra exata, ex. ${example}${unlike}` }
}

/**
 * A regra contra o `ssh` com o comando remoto em PALAVRAS (`ssh * sudo k3s kubectl *`). O comando remoto vem logo depois do
 * host, entre aspas (`ssh h "sudo systemctl …; sudo journalctl …"`) ou solto (`ssh h sudo systemctl …`).
 * ⛔ Entre aspas, cada privilegiado da linha remota precisa da SUA regra, que o CITE (o `*` de uma não engole o outro); sem
 * crase, `$(` nem quebra de linha. Linha opaca: só a regra exata (`exactRemoteRule`). ⛔ Solto, o ssh junta as palavras com
 * espaço e o shell remoto relê a linha: só palavras sem nada que ele interprete (aspas, `$`, `*`, `\\`, espaço), e o primeiro tem
 * de ser o próprio privilegiado, para a linha remota ser exatamente a que a regra viu.
 */
function sshCovered(argv: readonly string[], remote: IRemote, rules: readonly IPermissionRule[]): boolean {
  if (remote.opaque) return !!exactRemoteRule(argv, remote, rules)
  const at = sshRemoteStart(argv)
  const first = argv[at]
  if (first === undefined) return false
  const words = argv.slice(at)
  if (words.length > 1) {
    if (!words.every((word) => REMOTE_PLAIN_WORD.test(word))) return false
    if (!privilegedOf({ name: posix.basename(first), argv: words })) return false
  } else if (/[`\n]|\$\(/.test(first)) return false
  const prefix = argv.slice(0, at)
  return outerPrivileged(remote.privileged).every(({ command, kind }) =>
    rules.some((rule) => cites(rule.pattern, kind.cite) && commandMatches(rule.pattern, [...prefix, ...command.argv])),
  )
}

/** O privilegiado de fora: o que o `sudo` embrulha (`sudo systemctl reboot`) é coberto pela regra do sudo. */
function outerPrivileged<T extends { command: IShellCommand }>(items: readonly T[]): T[] {
  return items.filter(
    ({ command }) => !items.some((other) => other.command !== command && other.command.argv.length > command.argv.length && endsWith(other.command.argv, command.argv)),
  )
}

/** Os comandos de fora: o que um embrulho (`sudo X`, `timeout 5 X`) roda fica com a regra do de fora. */
function outerCommands(commands: readonly IShellCommand[]): IShellCommand[] {
  return commands.filter((command) => !commands.some((other) => other !== command && other.argv.length > command.argv.length && endsWith(other.argv, command.argv)))
}

/** O privilegiado REMOTO sem regra que o cubra: os trechos, com o porquê. */
async function remoteGaps(analysis: IShellAnalysis, command: string, rules: readonly IPermissionRule[]): Promise<ILockGap[]> {
  const gaps: ILockGap[] = []
  for (const part of analysis.commands) {
    const remote = await remoteOf(part, command)
    if (!remote || !(remote.opaque || remote.privileged.length)) continue
    if (sshCovered(part.argv, remote, rules)) continue
    if (remote.opaque) {
      gaps.push(opaqueGap(part, remote, rules))
      continue
    }
    const prefix = part.argv.slice(0, sshRemoteStart(part.argv))
    const missing = remote.privileged.filter(
      ({ command: inner, kind }) => !rules.some((rule) => cites(rule.pattern, kind.cite) && commandMatches(rule.pattern, [...prefix, ...inner.argv])),
    )
    for (const { command: inner, kind } of missing.length ? missing : remote.privileged.slice(0, 1)) {
      const shape = [...prefix, ...inner.argv]
      const near = rules.filter((rule) => commandMatches(rule.pattern, shape)).map((rule) => `\`${clip(rule.pattern, 80)}\``)
      gaps.push({
        reason: kind.reason,
        text: missing.length ? inner.text : part.text,
        why: near.length ? `${near.join(', ')} casa, mas não cita \`${kind.cite}\`: só a regra que o cita libera` : `sem regra que libere e cite \`${kind.cite}\``,
      })
    }
  }
  return gaps
}

/** O privilegiado LOCAL (`sudo x`, `reboot`): passa com a regra que o casa e o cita. */
function localGaps(analysis: IShellAnalysis, rules: readonly IPermissionRule[]): ILockGap[] {
  const items = analysis.commands.flatMap((command) => {
    const kind = privilegedOf(command)
    return kind ? [{ command, kind }] : []
  })
  return outerPrivileged(items)
    .filter(({ command, kind }) => !rules.some((rule) => cites(rule.pattern, kind.cite) && commandMatches(rule.pattern, command.argv)))
    .map(({ command, kind }) => {
      const near = rules.filter((rule) => commandMatches(rule.pattern, command.argv)).map((rule) => `\`${clip(rule.pattern, 80)}\``)
      return {
        reason: kind.reason,
        text: command.text,
        why: near.length
          ? `${near.join(', ')} casa, mas não cita \`${kind.cite}\`: só passa com regra exata que o cite, ex. \`${clip(command.text, 100)}\``
          : `só passa com regra exata que o cite, ex. \`${clip(command.text, 100)}\``,
      }
    })
}

/**
 * Os trechos da linha que disparam a trava de texto, cada um na forma que a regra casa: o comando local; no `ssh`, cada comando
 * remoto com o prefixo (`ssh h rm -rf /x`), ou a linha remota inteira quando a trava não cabe num comando só. Nenhum trecho
 * sozinho (a trava atravessa o pipe): a linha inteira, em palavras.
 */
async function lockUnits(reason: string, analysis: IShellAnalysis, command: string): Promise<Array<{ text: string; shape: string[] }>> {
  const units: Array<{ text: string; shape: string[] }> = []
  for (const part of analysis.commands) {
    if (!textLockHits(reason, part.text)) continue
    const remote = await remoteOf(part, command)
    if (!remote || remote.dynamic) {
      units.push({ text: part.text, shape: part.argv })
      continue
    }
    const prefix = part.argv.slice(0, sshRemoteStart(part.argv))
    const inner = remote.opaque ? [] : remote.commands.filter((one) => textLockHits(reason, one.text))
    if (inner.length) units.push(...inner.map((one) => ({ text: one.text, shape: [...prefix, ...one.argv] })))
    else units.push({ text: part.text, shape: remoteShape(part.argv, remote) })
  }
  // Na linha local, o que o `sudo` embrulha (`sudo rm -rf x` → `rm -rf x`) é coberto pela regra do de fora.
  const outer = units.filter((unit) => !units.some((other) => other !== unit && other.shape.length > unit.shape.length && endsWith(other.shape, unit.shape)))
  return outer.length ? outer : [{ text: command.trim(), shape: command.trim().split(/\s+/) }]
}

/** A trava de texto sem a regra exata que a libere. */
async function textGaps(reason: string, analysis: IShellAnalysis, command: string, permissions: IPermissionChecker, asker: IPermissionAsker): Promise<ILockGap[]> {
  const rules = allowTerminalRules(permissions, asker)
  const gaps: ILockGap[] = []
  for (const unit of await lockUnits(reason, analysis, command)) {
    if (rules.some((rule) => textLockCited(reason, rule.pattern) && commandMatches(rule.pattern, unit.shape))) {
      // ⛔ A negação vence a regra que libera.
      const denied = denialOf(permissions, asker, unit.shape)
      if (denied) gaps.push({ reason, text: unit.text, why: denied })
      continue
    }
    const near = rules.filter((rule) => commandMatches(rule.pattern, unit.shape)).map((rule) => `\`${clip(rule.pattern, 80)}\``)
    const example = `\`${clip(unit.shape.join(' '), 100)}\``
    gaps.push({
      reason,
      text: unit.text,
      why: near.length
        ? `${near.join(', ')} casa, mas não cita a parte travada (curinga não libera trava): só passa com regra exata, ex. ${example}`
        : `só passa com regra exata que a cite, ex. ${example}`,
    })
  }
  return gaps
}

/**
 * ⚖️ A TRAVA DO TERMINAL, com a regra exata do admin: o motivo da recusa (já com o porquê e a regra que a libera), ou nada se
 * passa. Sem quem decida as regras (`permissions` ausente), as travas valem como estão. `localPrivilege: false` (o agente de
 * máquina, cujo sudo local vai ao cartão da pessoa, com a senha) deixa o privilegiado local recusado aqui.
 */
export async function lockRefusal(
  command: string,
  permissions: IPermissionChecker | undefined,
  asker: IPermissionAsker,
  options: { localPrivilege?: boolean } = {},
): Promise<string | undefined> {
  const textual = deniedReasons(command)
  const analysis = await analyzeShell(command)
  const plain = textual.filter((reason) => !COMMAND_REASONS.has(reason))
  // A linha que a análise não vê por inteiro, ou sem regras: as travas valem como estão (o terminal recusa a opaca de qualquer jeito).
  if (plain.length && (!permissions || analysis.opaque.length || plain.includes('empty command'))) return plain[0]
  for (const reason of plain) {
    const gap = (await textGaps(reason, analysis, command, permissions!, asker))[0]
    if (gap) return render(gap)
  }
  const real = [...new Set([...realReasons(analysis, analysis.opaque.length ? textual : [...COMMAND_REASONS]), ...(await remoteReasons(analysis, command))])]
  if (!real.length) return undefined
  if (!permissions || analysis.opaque.length) return real[0]
  const rules = allowTerminalRules(permissions, asker)
  const own = options.localPrivilege === false ? analysis.commands.map((part) => privilegedOf(part)).find(Boolean) : undefined
  if (own) return own.reason
  const local = localGaps(analysis, rules)
  const gaps = [...local, ...(await remoteGaps(analysis, command, rules))]
  if (!gaps.length) {
    // ⛔ A negação vence a regra que libera: o comando como roda, local ou remoto.
    for (const part of outerCommands(analysis.commands)) {
      const denied = denialOf(permissions, asker, part.argv)
      if (denied) return `${real[0]}: ${denied}`
    }
    return undefined
  }
  return render(gaps[0]!, gaps.length > 1 ? gaps.slice(1).map((gap) => gap.text) : [])
}

function render(gap: ILockGap, more: readonly string[] = []): string {
  const rest = more.length ? `; também sem regra: ${[...new Set(more)].map((text) => `\`${clip(text, 120)}\``).join(', ')}` : ''
  return `${gap.reason} em \`${clip(gap.text, 120)}\` — ${gap.why}${rest}`
}

/**
 * O que falta para o privilegiado REMOTO passar: nada (`undefined`) se passa; senão, os trechos sem regra que os cubra. Vazio = a
 * recusa não é de regra remota (local, opaca na linha local).
 */
export async function remoteSudoGap(command: string, permissions: IPermissionChecker, asker: IPermissionAsker): Promise<string[] | undefined> {
  const analysis = await analyzeShell(command)
  if (analysis.opaque.length) return []
  if (analysis.commands.some((part) => privilegedOf(part) || /^\s*(sudo|doas)\b/.test(part.text))) return []
  const rules = allowTerminalRules(permissions, asker)
  const withPrivilege = (await Promise.all(analysis.commands.map((part) => remoteOf(part, command)))).filter((remote) => remote && (remote.opaque || remote.privileged.length))
  if (!withPrivilege.length) return []
  const gaps = await remoteGaps(analysis, command, rules)
  return gaps.length ? [...new Set(gaps.map((gap) => gap.text))] : undefined
}
