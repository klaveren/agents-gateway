import { WatchService } from './Watch.Service'

/** De quanto em quanto tempo o relógio confere o que venceu. A vigia mais rápida confere a cada 15 s. */
const TICK_MS = 5_000
const PURGE_EVERY_MS = 60 * 60_000

/**
 * O RELÓGIO das vigias: a cada `TICK_MS` pega o que venceu (conferência, prazo, entrega pendente) e processa, até
 * `maxParallel` de cada vez.
 *
 * ⛔ Drenando para um deploy, nada roda: a vigia vencida fica para o processo novo, que a dispara ATRASADA, avisando do
 * atraso. Ao contrário do agendamento, que marca "perdido", a vigia é uma promessa feita a alguém e não se perde.
 * ⚠️ Pressupõe UMA réplica do gateway, como o `ScheduleRunner`.
 */
export class WatchRunner {
  private readonly running = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private purgedAt = 0

  constructor(
    private readonly service: WatchService,
    private readonly now: () => Date = () => new Date(),
    private readonly draining: () => boolean = () => false,
    private readonly maxParallel = 4,
  ) {}

  start(): void {
    if (this.timer) return
    this.safeTick()
    this.timer = setInterval(() => this.safeTick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** ⛔ O ciclo do relógio nunca derruba o processo: a falha vai ao log e o próximo ciclo tenta de novo. */
  private safeTick(): void {
    try {
      this.tick()
    } catch (error) {
      console.error(`[vigia] o ciclo falhou: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Uma conferência do relógio. Devolve o que começou a rodar (cada uma nunca lança). */
  tick(): Array<Promise<void>> {
    const started: Array<Promise<void>> = []
    if (this.draining()) return started
    const now = this.now()
    if (now.getTime() - this.purgedAt >= PURGE_EVERY_MS) {
      this.purgedAt = now.getTime()
      this.service.purge()
    }
    for (const watch of this.service.due(now)) {
      if (this.running.size >= this.maxParallel) break
      if (this.running.has(watch.id)) continue
      this.running.add(watch.id)
      started.push(
        this.service
          .process(watch)
          .catch((error: unknown) => console.error(`[vigia] ${watch.id} falhou: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => this.running.delete(watch.id)),
      )
    }
    return started
  }
}
