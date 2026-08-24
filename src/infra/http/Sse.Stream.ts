import { Response } from 'express'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'

const DEFAULT_HEARTBEAT_MS = 15_000

export interface ISseStreamOptions {
  /** Intervalo do comentário de keep-alive. `0` desliga. */
  heartbeatMs?: number
}

/**
 * Um stream SSE que sobrevive a proxy e a conexão ociosa.
 *
 * Três detalhes que faltavam: `flushHeaders`, para o navegador começar a ler antes do
 * primeiro evento; `X-Accel-Buffering: no`, para o nginx não segurar o corpo; e um
 * heartbeat, porque proxies derrubam conexão parada — e um turno agêntico passa
 * bastante tempo em silêncio enquanto uma tool roda.
 */
export class SseStream {
  private heartbeat?: NodeJS.Timeout
  private sequence = 0
  private closed = false

  constructor(
    private readonly res: Response,
    private readonly options: ISseStreamOptions = {},
  ) {}

  open(): void {
    this.res.setHeader('Content-Type', 'text/event-stream')
    this.res.setHeader('Cache-Control', 'no-cache, no-transform')
    this.res.setHeader('Connection', 'keep-alive')
    this.res.setHeader('X-Accel-Buffering', 'no')
    this.res.flushHeaders?.()

    const interval = this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (interval > 0) {
      this.heartbeat = setInterval(() => this.comment('ping'), interval)
      this.heartbeat.unref?.()
    }
  }

  send(event: IAgentEvent): void {
    if (this.closed) return
    this.sequence += 1
    this.res.write(`id: ${this.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  comment(text: string): void {
    if (this.closed) return
    this.res.write(`: ${text}\n\n`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.res.end()
  }
}
