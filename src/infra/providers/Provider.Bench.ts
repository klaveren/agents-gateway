/**
 * O BANCO DE RESERVAS: o provedor cuja cota acabou fica de lado até ela voltar (o `resetsAt` do erro) ou por um tempo
 * fixo. Vale para todas as conversas: a próxima já nasce no provedor seguinte, em vez de bater no mesmo limite.
 *
 * ⚖️ Em memória: o reinício esquece, e o primeiro turno descobre de novo — um erro a mais, nunca um provedor preso de
 * lado por um registro velho.
 */
export class ProviderBench {
  private readonly until = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  bench(provider: string, untilMs: number): void {
    this.until.set(provider, Math.max(untilMs, this.until.get(provider) ?? 0))
  }

  isBenched(provider: string): boolean {
    const until = this.until.get(provider)
    if (until === undefined) return false
    if (until > this.now()) return true
    this.until.delete(provider)
    return false
  }

  /** Os que estão de lado agora, com quando voltam (para a tela). */
  list(): Array<{ provider: string; until: Date }> {
    return [...this.until.keys()].filter((provider) => this.isBenched(provider)).map((provider) => ({ provider, until: new Date(this.until.get(provider)!) }))
  }
}
