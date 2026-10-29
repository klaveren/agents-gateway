import { CronSchedule } from '@domain/Cron.Schedule'
import { IAgentSchedule } from '@domain/models/AgentSchedule.Model'
import { AgentSchedulesService } from './AgentSchedules.Service'

/** Roda um agendamento: abre (ou continua) a conversa e manda o texto. Devolve a conversa e o erro, se houve. */
export type TScheduleExecutor = (schedule: IAgentSchedule) => Promise<{ sessionId?: string; error?: string }>

/** O horário que passou há mais que isto, sem ter rodado, conta como PERDIDO (o gateway estava fora do ar). */
const MISSED_AFTER_MS = 2 * 60_000
/** Até quantas perdidas se contam uma a uma; acima disso o relógio salta para perto de agora. */
const MISSED_COUNTED = 200
/** De quanto em quanto tempo o relógio confere o que venceu. O cron tem resolução de minuto. */
const TICK_MS = 20_000

/**
 * O RELÓGIO dos agendamentos: a cada `TICK_MS` confere, para cada agendamento ligado, o próximo horário depois do
 * último que passou (`lastScheduledFor`) e dispara o que venceu.
 *
 * ⚖️ UMA REGRA SÓ PARA O BOOT E PARA O DIA A DIA: horário vencido há pouco roda; vencido há mais que
 * `MISSED_AFTER_MS` (o gateway estava fora do ar, ou o processo dormiu) é registrado como perdido e NÃO roda — vários
 * perdidos viram um registro só. ⛔ Não sobrepõe: com a execução anterior ainda rodando, a nova é registrada como pulada.
 * ⚠️ Pressupõe UMA réplica do gateway (o caso do pod hoje): duas réplicas disparariam duas vezes.
 */
export class ScheduleRunner {
  private readonly running = new Set<string>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly service: AgentSchedulesService,
    private readonly execute: TScheduleExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Uma conferência: dispara o que venceu e registra o que se perdeu. Devolve as execuções que começaram. */
  async tick(): Promise<Array<Promise<void>>> {
    const started: Array<Promise<void>> = []
    const now = this.now()
    for (const schedule of this.service.list()) {
      if (!schedule.enabled || !this.service.nextRun(schedule, now)) continue
      let cron: CronSchedule
      try {
        cron = new CronSchedule(schedule.cron, schedule.timezone)
      } catch {
        continue
      }
      let due = cron.next(schedule.lastScheduledFor ?? schedule.createdAt)
      let missed = 0
      let lastDue: Date | undefined
      while (due && due.getTime() <= now.getTime()) {
        lastDue = due
        if (now.getTime() - due.getTime() > MISSED_AFTER_MS) missed += 1
        else break
        // Fora do ar por muito tempo: pula direto para perto de agora, sem contar uma a uma (o número fica "mais de").
        due = missed >= MISSED_COUNTED ? cron.next(new Date(now.getTime() - MISSED_AFTER_MS)) : cron.next(due)
      }
      if (!lastDue) continue
      this.service.markScheduled(schedule, lastDue)
      if (missed && now.getTime() - lastDue.getTime() > MISSED_AFTER_MS) {
        this.service.recordRun(schedule, {
          trigger: 'cron',
          scheduledFor: lastDue,
          status: 'missed',
          error: `${missed} execução(ões) perdida(s): o gateway estava fora do ar no horário.`,
        })
        continue
      }
      if (missed)
        this.service.recordRun(schedule, {
          trigger: 'cron',
          scheduledFor: lastDue,
          status: 'missed',
          error: `${missed} execução(ões) perdida(s) antes desta: o gateway estava fora do ar.`,
        })
      started.push(this.fire(schedule, 'cron', lastDue))
    }
    return started
  }

  /** "Rodar agora": a mesma execução, fora do horário (não mexe no relógio). */
  runNow(schedule: IAgentSchedule): Promise<void> {
    return this.fire(schedule, 'manual', this.now())
  }

  private async fire(schedule: IAgentSchedule, trigger: 'cron' | 'manual', scheduledFor: Date): Promise<void> {
    const key = `${schedule.agentId}/${schedule.name}`
    if (this.running.has(key)) {
      this.service.recordRun(schedule, { trigger, scheduledFor, status: 'skipped', error: 'A execução anterior ainda estava rodando.' })
      return
    }
    this.running.add(key)
    const run = this.service.recordRun(schedule, { trigger, scheduledFor, status: 'running' })
    try {
      const outcome = await this.execute(schedule)
      this.service.finishRun(schedule, run.id, outcome)
    } catch (error: unknown) {
      this.service.finishRun(schedule, run.id, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running.delete(key)
    }
  }
}
