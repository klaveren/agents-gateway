/**
 * Um AGENDAMENTO de agente: o agente executa um texto em determinados momentos (expressão cron, num fuso).
 *
 * ⚖️ É O HOOK DISPARADO PELO RELÓGIO: roda em nome de quem criou (as permissões e a caixa de entrada são dela), numa
 * conversa nova a cada vez ou sempre na mesma, e o texto aceita o mesmo que o chat — `/command args`, `/skill pedido`,
 * `/spec:<id>`. Só quem administra cria: roda sozinho e gasta tokens sem ninguém olhando.
 */
export type TScheduleSession = 'new' | 'continuous'

export interface IAgentSchedule {
  agentId: string
  name: string
  /** Cron de 5 campos (minuto hora dia mês dia-da-semana). */
  cron: string
  /** IANA ("America/Sao_Paulo"). */
  timezone: string
  /** O que o agente recebe a cada execução — como uma mensagem digitada no chat. */
  prompt: string
  session: TScheduleSession
  /** A conversa de um agendamento `continuous`. */
  sessionId?: string
  /** O projeto da conversa, para agente global (o de projeto já tem o dele). */
  projectId?: string
  enabled: boolean
  /** ⛔ Em nome de quem o agente roda: a conta que criou o agendamento. */
  runAs: string
  /** Falhas seguidas: no limite (`SCHEDULE_MAX_FAILURES`) o agendamento se pausa sozinho. */
  failures: number
  /** Por que está pausado, quando foi o sistema que pausou. */
  pausedReason?: string
  /** O último horário em que deveria ter rodado (rodando ou não): é com ele que se acham as execuções perdidas. */
  lastScheduledFor?: Date
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/**
 * Uma execução, para o histórico. `skipped`: a anterior ainda rodava. `missed`: o gateway estava fora do ar na hora —
 * não roda depois (decisão: pula e registra).
 */
export interface IScheduleRun {
  id: string
  agentId: string
  scheduleName: string
  trigger: 'cron' | 'manual'
  scheduledFor: Date
  startedAt?: Date
  finishedAt?: Date
  status: 'running' | 'ok' | 'error' | 'skipped' | 'missed'
  sessionId?: string
  error?: string
}

export const SCHEDULE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const SCHEDULE_RUNS_KEPT = 20
/** O menor intervalo entre duas execuções: abaixo disso um agendamento vira uma conta de tokens sem freio. */
export const SCHEDULE_MIN_INTERVAL_MS = 5 * 60_000
/** Falhas seguidas até pausar sozinho. */
export const SCHEDULE_MAX_FAILURES = 5
export const SCHEDULE_DEFAULT_TIMEZONE = 'America/Sao_Paulo'
