import { callSignature, ILoopLimits, loopLimits, loopRefusal } from '@domain/Loop.Policy'

/** O que o turno tem de contagem: as chamadas por assinatura e os erros seguidos. */
interface ITurnCount {
  /** Contadas na hora de executar (o envoltório das locais, o `PreToolUse` do Claude). */
  checked: Map<string, number>
  /** Vistas no fluxo de eventos do turno (todas as lanes, inclusive as nativas do Codex). */
  seen: Map<string, number>
  errors: number
  stop?: string
}

/**
 * ⚖️ O REGISTRO DO DETECTOR DE LAÇO (ver `Loop.Policy`), por conversa, aberto e fechado pelo `AgentProvider` a cada turno.
 *
 * A mesma chamada é vista por DOIS caminhos: na execução (`check`, que pode recusar) e no fluxo de eventos (`observe`,
 * que cobre o que não passa por execução nossa). Cada caminho conta à parte e vale o MAIOR: somar contaria duas vezes a
 * chamada que passa pelos dois.
 */
export class LoopGuard {
  private readonly turns = new Map<string, ITurnCount>()

  constructor(private readonly limits: () => ILoopLimits = loopLimits) {}

  open(sessionId: string): void {
    this.turns.set(sessionId, { checked: new Map(), seen: new Map(), errors: 0 })
  }

  close(sessionId: string): void {
    this.turns.delete(sessionId)
  }

  /** Antes de executar: o motivo da recusa, ou nada. Fora de um turno aberto, não conta (e não recusa). */
  check(sessionId: string | undefined, tool: string, args: unknown): string | undefined {
    const turn = sessionId ? this.turns.get(sessionId) : undefined
    if (!turn) return undefined
    const signature = callSignature(tool, args)
    const times = (turn.checked.get(signature) ?? 0) + 1
    turn.checked.set(signature, times)
    const limits = this.limits()
    this.stopIfRepeated(turn, tool, signature, limits)
    return times >= limits.refuseAt ? loopRefusal(times - 1) : undefined
  }

  /** Um evento do turno: `tool.started` conta a chamada; `tool.error` soma um erro seguido; `tool.result` zera. */
  observe(sessionId: string, event: { type: 'tool.started'; tool: string; args: unknown } | { type: 'tool.error' | 'tool.result' }): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    const limits = this.limits()
    if (event.type === 'tool.started') {
      const signature = callSignature(event.tool, event.args)
      turn.seen.set(signature, (turn.seen.get(signature) ?? 0) + 1)
      this.stopIfRepeated(turn, event.tool, signature, limits)
    } else if (event.type === 'tool.error') {
      turn.errors += 1
      if (turn.errors >= limits.maxErrors) turn.stop ??= `Laço: ${turn.errors} erros de ferramenta seguidos; turno parado.`
    } else turn.errors = 0
  }

  /** O motivo de parar o turno, quando um limite foi alcançado. */
  stopReason(sessionId: string): string | undefined {
    return this.turns.get(sessionId)?.stop
  }

  private stopIfRepeated(turn: ITurnCount, tool: string, signature: string, limits: ILoopLimits): void {
    const times = Math.max(turn.checked.get(signature) ?? 0, turn.seen.get(signature) ?? 0)
    if (times < limits.stopAt) return
    const args = signature.slice(tool.length + 1)
    turn.stop ??= `Laço: ${tool} ${args.length > 120 ? `${args.slice(0, 120)}…` : args} repetido ${times} vezes; turno parado.`
  }
}
