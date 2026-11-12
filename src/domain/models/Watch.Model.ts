/**
 * A VIGIA: o que o agente arma numa conversa para o gateway conferir (ou esperar) por ele e ACORDAR a conversa quando
 * acontecer. Existe porque o agente não volta sozinho: "quando o servidor voltar eu te aviso" sem nada conferindo era
 * promessa vazia, e a pessoa tinha de perguntar de novo.
 *
 * ⚖️ Duas formas: `command` (o gateway roda o comando de tempos em tempos; saiu com 0 = aconteceu) e `timer` (o
 * `wake_me`: só o horário — para o que apenas uma ferramenta enxerga; o agente acorda, confere e rearma). Enquanto
 * espera, nenhuma gasta token.
 */
export const WATCH_START_TOOL = 'watch_start'
export const WAKE_ME_TOOL = 'wake_me'
export const WATCH_LIST_TOOL = 'watch_list'
export const WATCH_STOP_TOOL = 'watch_stop'
export const WATCH_TOOLS: readonly string[] = [WATCH_START_TOOL, WAKE_ME_TOOL, WATCH_LIST_TOOL, WATCH_STOP_TOOL]

export type TWatchKind = 'command' | 'timer'
/** `met` = aconteceu (ou o horário do `wake_me` chegou); `expired` = o prazo passou; `failed` = a conferência não roda. */
export type TWatchStatus = 'active' | 'met' | 'expired' | 'failed' | 'cancelled'

export interface IWatch {
  id: string
  sessionId: string
  agentId: string
  /** A conta dona da conversa: é em nome dela que a conversa retoma. */
  runAs: string
  kind: TWatchKind
  label: string
  command?: string
  everySeconds?: number
  /** O que o agente anotou para fazer quando acontecer: volta a ele no aviso. */
  then: string
  status: TWatchStatus
  createdAt: Date
  /** A próxima conferência (ativa) ou a próxima tentativa de entrega (encerrada e ainda não entregue). */
  nextCheckAt?: Date
  /** O prazo da vigia por comando; no `wake_me`, o horário de acordar. */
  deadlineAt: Date
  checks: number
  /** Conferências seguidas que não rodaram (recusa, tempo esgotado). */
  failures: number
  /** A saída da última conferência, já mascarada e cortada. */
  lastOutput?: string
  endedAt?: Date
  endReason?: string
  /** O aviso já entrou na conversa (ou não há mais a quem entregar). */
  delivered: boolean
  /** Quantas vezes a entrega foi tentada sem entrar. */
  deliveryAttempts: number
}

export const WATCH_LIMITS = {
  minEverySeconds: 15,
  defaultEverySeconds: 60,
  defaultDeadlineMinutes: 60,
  /** O teto do prazo e do `wake_me`: 7 dias. */
  maxMinutes: 7 * 24 * 60,
  minWakeMinutes: 5,
  perSession: 5,
  /** Conferências seguidas sem rodar que encerram a vigia como falha. */
  maxFailures: 5,
  checkTimeoutSeconds: 30,
  outputChars: 2000,
  labelChars: 80,
  thenChars: 1000,
  commandChars: 2000,
  /** Tentativas de entrega antes de desistir (a espera entre elas cresce até 10 min). */
  maxDeliveryAttempts: 30,
} as const

/** O disparo que sai mais atrasado que isto diz que atrasou (o gateway estava fora do ar ou reiniciando). */
export const WATCH_LATE_AFTER_MS = 2 * 60_000

/** O teto de vigias ativas no gateway inteiro (`WATCH_MAX_ACTIVE`). */
export function watchMaxActive(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.WATCH_MAX_ACTIVE)
  return Number.isInteger(value) && value > 0 ? value : 50
}

/** O mínimo do `wake_me`, em minutos. ⚠️ `WATCH_MIN_WAKE_MINUTES` existe para o teste de ponta a ponta: aceita fração. */
export function watchMinWakeMinutes(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const value = Number(env.WATCH_MIN_WAKE_MINUTES)
  return Number.isFinite(value) && value > 0 ? value : WATCH_LIMITS.minWakeMinutes
}

export interface IWatchStartInput {
  label: string
  command: string
  everySeconds: number
  deadlineMinutes: number
  then: string
}

export interface IWakeInput {
  label: string
  afterMinutes: number
  then: string
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

function commonIssues(label: string, then: string): string[] {
  const issues: string[] = []
  if (!label) issues.push('label: diga em poucas palavras o que está sendo esperado (a pessoa lê na tela)')
  else if (label.length > WATCH_LIMITS.labelChars) issues.push(`label: até ${WATCH_LIMITS.labelChars} caracteres`)
  if (!then) issues.push('then: anote o que você vai fazer quando acontecer (volta para você no aviso)')
  else if (then.length > WATCH_LIMITS.thenChars) issues.push(`then: até ${WATCH_LIMITS.thenChars} caracteres`)
  return issues
}

/** Os argumentos do `watch_start` conferidos: o valor pronto, ou o que corrigir. */
export function watchStartInput(args: Record<string, unknown>): { value: IWatchStartInput } | { issues: string[] } {
  const label = text(args.label)
  const then = text(args.then)
  const command = text(args.command)
  const issues = commonIssues(label, then)
  if (!command) issues.push('command: o comando que confere (sai com 0 quando aconteceu)')
  else if (command.length > WATCH_LIMITS.commandChars) issues.push(`command: até ${WATCH_LIMITS.commandChars} caracteres`)
  const everySeconds = args.everySeconds === undefined ? WATCH_LIMITS.defaultEverySeconds : Number(args.everySeconds)
  if (!Number.isFinite(everySeconds) || everySeconds < WATCH_LIMITS.minEverySeconds) issues.push(`everySeconds: no mínimo ${WATCH_LIMITS.minEverySeconds}`)
  const deadlineMinutes = args.deadlineMinutes === undefined ? WATCH_LIMITS.defaultDeadlineMinutes : Number(args.deadlineMinutes)
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes < 1 || deadlineMinutes > WATCH_LIMITS.maxMinutes)
    issues.push(`deadlineMinutes: de 1 a ${WATCH_LIMITS.maxMinutes} (7 dias)`)
  else if (Number.isFinite(everySeconds) && everySeconds > deadlineMinutes * 60) issues.push('everySeconds: maior que o prazo, a vigia nunca conferiria')
  if (issues.length) return { issues }
  return { value: { label, command, everySeconds: Math.round(everySeconds), deadlineMinutes, then } }
}

/** Os argumentos do `wake_me` conferidos. */
export function wakeInput(args: Record<string, unknown>, minMinutes: number = watchMinWakeMinutes()): { value: IWakeInput } | { issues: string[] } {
  const label = text(args.label)
  const then = text(args.then)
  const issues = commonIssues(label, then)
  const afterMinutes = Number(args.afterMinutes)
  if (!Number.isFinite(afterMinutes) || afterMinutes < minMinutes || afterMinutes > WATCH_LIMITS.maxMinutes)
    issues.push(`afterMinutes: de ${minMinutes} a ${WATCH_LIMITS.maxMinutes} (7 dias); para esperar menos, espere dentro do turno`)
  if (issues.length) return { issues }
  return { value: { label, afterMinutes, then } }
}

/** O que uma conferência deu. `refused`/`timeout` não dizem se aconteceu: contam como conferência que não rodou. */
export type TWatchCheckVerdict = 'met' | 'unmet' | 'timeout' | 'refused'

export interface IWatchCheck {
  verdict: TWatchCheckVerdict
  output: string
}

/** A saída guardada de uma conferência: o fim dela (onde está o erro), no teto. */
export function clipWatchOutput(output: string): string {
  const clean = output.trim()
  return clean.length > WATCH_LIMITS.outputChars ? `…${clean.slice(-WATCH_LIMITS.outputChars)}` : clean
}

/** "2 h 5 min", "40 s": a duração para a mensagem e para a lista. */
export function watchSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return `${Math.round(hours / 24)} dias`
}

/**
 * O AVISO que entra na conversa quando a vigia encerra. ⚖️ No formato dos outros avisos do gateway: diz logo que não é a
 * pessoa falando, o que aconteceu, a saída da última conferência e o que o próprio agente anotou para fazer.
 */
export function watchNotice(watch: IWatch, now: Date): string {
  const lateMs = now.getTime() - watch.deadlineAt.getTime()
  const late = lateMs > WATCH_LATE_AFTER_MS ? ` Este aviso sai com ${watchSpan(lateMs)} de atraso: o gateway esteve fora do ar.` : ''
  const waited = watchSpan((watch.endedAt ?? now).getTime() - watch.createdAt.getTime())
  const what =
    watch.kind === 'timer'
      ? `chegou a hora de "${watch.label}", que você pediu para ser acordado (${waited} depois).${late}`
      : watch.status === 'met'
        ? `a vigia "${watch.label}" que você armou nesta conversa disparou: a conferência passou depois de ${waited} (${watch.checks} conferência${watch.checks === 1 ? '' : 's'}).`
        : watch.status === 'expired'
          ? `a vigia "${watch.label}" que você armou nesta conversa chegou ao prazo (${waited}) SEM a condição acontecer.${late}`
          : `a vigia "${watch.label}" que você armou nesta conversa parou: ${watch.endReason ?? 'a conferência não roda'}.`
  const lines = [`[Aviso do gateway, não é mensagem da pessoa: ${what}]`]
  if (watch.command) lines.push(`Comando conferido: ${watch.command}`)
  if (watch.lastOutput) lines.push('Saída da última conferência:', watch.lastOutput)
  lines.push(`O que você anotou para fazer agora: ${watch.then}`)
  lines.push(
    watch.kind === 'timer'
      ? 'Confira o que esperava e siga de onde parou. Se ainda não aconteceu, arme de novo (wake_me) e diga à pessoa em uma linha.'
      : watch.status === 'met'
        ? 'Confira o resultado e siga de onde parou.'
        : 'Diga à pessoa o que houve; se ainda vale esperar, arme outra vigia.',
  )
  return lines.join('\n')
}

/** Uma linha da vigia para o agente (`watch_list`, a resposta de armar). */
export function watchLine(watch: IWatch, now: Date): string {
  const head = `${watch.id} · ${watch.label}`
  if (watch.status !== 'active') return `${head} · ${STATUS_LABEL[watch.status]}${watch.endReason ? ` (${watch.endReason})` : ''}`
  const left = watchSpan(watch.deadlineAt.getTime() - now.getTime())
  return watch.kind === 'timer' ? `${head} · acorda em ${left}` : `${head} · confere a cada ${watch.everySeconds} s · prazo em ${left} · ${watch.checks} conferência(s)`
}

const STATUS_LABEL: Record<Exclude<TWatchStatus, 'active'>, string> = {
  met: 'disparou',
  expired: 'prazo esgotado',
  failed: 'parou com falha',
  cancelled: 'cancelada',
}
