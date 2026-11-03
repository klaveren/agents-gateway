/** Como o turno de fundo terminou (o mesmo `status` do `POST /sessions/:id/turns`). */
export interface IImportTurnResult {
  status: 'ok' | 'error' | 'aborted'
  error?: string
}

/** O andamento do construtor numa conversa da migração. */
export interface IImportRun {
  state: 'queued' | 'running' | 'ok' | 'error' | 'aborted'
  error?: string
  at: string
}

export interface IImportRunDeps {
  /**
   * ⛔ Prepara o turno NO CONTEXTO DE QUEM PEDIU (a identidade da requisição) e devolve quem o roda depois: a fila
   * chama na vez dele, e o turno passa pelas mesmas regras do `POST /sessions/:id/turns` (dono, audiência, teto).
   */
  prepareTurn: (conversationId: string, message: string) => () => Promise<IImportTurnResult>
  now?: () => Date
}

export const RUN_CONCURRENCY_DEFAULT = 3
export const RUN_CONCURRENCY_MAX = 5

/** A mensagem do turno de fundo: ninguém acompanha, então o construtor não espera resposta. */
export function importRunMessage(keys: readonly string[]): string {
  return (
    `Prepare ${keys.length === 1 ? 'este item' : `estes ${keys.length} itens`} do trabalho de importação: ${keys.join(', ')}. ` +
    'Comece por list_import_items, leia as fontes, confira no repositório só o necessário e proponha o rascunho de cada item (o que tem ajuste pedido traz o pedido na lista). ' +
    'Esta conversa roda sem ninguém acompanhando: não espere resposta. O que for ambíguo, fique com o mais fiel à fonte, ' +
    'siga para o próximo e diga no fim o que ficou em dúvida. Item que não é do tipo desta conversa: não reclassifique, diga no fim qual tipo serve.'
  )
}

/**
 * O CONSTRUTOR EM SEGUNDO PLANO, para o "Preparar tudo" da migração: cada conversa entra numa fila e roda um turno no
 * servidor, sem aba aberta, no máximo `concurrency` de cada vez. O andamento fica na memória (reiniciar o gateway
 * esquece: a conversa com itens pendentes volta a "parada" e pode ser retomada).
 *
 * ⛔ Só roda turno: propor, aprovar e gravar seguem com o construtor e com a pessoa.
 */
export class ImportRunService {
  private readonly runs = new Map<string, IImportRun>()
  private readonly waiting: Array<{ conversationId: string; run: () => Promise<IImportTurnResult> }> = []
  private active = 0
  private limit = RUN_CONCURRENCY_DEFAULT

  constructor(private readonly deps: IImportRunDeps) {}

  private stamp(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString()
  }

  /** O andamento de cada conversa pedida (as que nunca rodaram aqui ficam de fora). */
  statusOf(conversationIds: readonly string[]): Record<string, IImportRun> {
    return Object.fromEntries(conversationIds.flatMap((id) => (this.runs.has(id) ? [[id, this.runs.get(id)!]] : [])))
  }

  /** A conversa está na fila ou rodando. */
  busy(conversationId: string): boolean {
    const state = this.runs.get(conversationId)?.state
    return state === 'queued' || state === 'running'
  }

  /** Põe as conversas na fila (as que já estão nela ou rodando ficam como estão) e ajusta quantas rodam juntas. */
  start(entries: ReadonlyArray<{ conversationId: string; keys: readonly string[] }>, concurrency = this.limit): string[] {
    this.limit = Math.min(RUN_CONCURRENCY_MAX, Math.max(1, Math.trunc(concurrency)))
    const queued: string[] = []
    for (const entry of entries) {
      if (!entry.keys.length || this.busy(entry.conversationId)) continue
      this.waiting.push({ conversationId: entry.conversationId, run: this.deps.prepareTurn(entry.conversationId, importRunMessage(entry.keys)) })
      this.runs.set(entry.conversationId, { state: 'queued', at: this.stamp() })
      queued.push(entry.conversationId)
    }
    this.pump()
    return queued
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift()!
      this.active += 1
      this.runs.set(next.conversationId, { state: 'running', at: this.stamp() })
      void Promise.resolve()
        .then(next.run)
        .then(
          (result) => this.runs.set(next.conversationId, { state: result.status, ...(result.error ? { error: result.error } : {}), at: this.stamp() }),
          (error: unknown) => this.runs.set(next.conversationId, { state: 'error', error: error instanceof Error ? error.message : String(error), at: this.stamp() }),
        )
        .finally(() => {
          this.active -= 1
          this.pump()
        })
    }
  }
}
