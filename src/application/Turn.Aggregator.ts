import { IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'

export interface ITurnToolCall {
  tool: string
  args: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface ITurnResult {
  sessionId: string
  text: string
  reasoning: string
  toolCalls: ITurnToolCall[]
  usage: IUsage
  warnings: string[]
  aborted: boolean
  error?: string
}

/**
 * Reduz o stream de eventos de um turno a um objeto único.
 *
 * É o que permite consumir a API sem falar SSE — e, mais útil para o experimento, rodar as
 * duas lanes em lote e comparar por número em vez de por impressão.
 */
export function aggregateTurn(sessionId: string, events: Iterable<IAgentEvent>): ITurnResult {
  const turn: ITurnResult = {
    sessionId,
    text: '',
    reasoning: '',
    toolCalls: [],
    usage: {},
    warnings: [],
    aborted: false,
  }

  for (const event of events) {
    switch (event.type) {
      case 'text.delta':
        turn.text += event.payload.text
        break

      case 'reasoning.delta':
        turn.reasoning += event.payload.text
        break

      case 'tool.started':
        turn.toolCalls.push({ tool: event.payload.tool, args: event.payload.args })
        break

      case 'tool.result':
        attachToPendingCall(turn, event.payload.tool, (call) => (call.result = event.payload.result))
        break

      case 'tool.error':
        attachToPendingCall(turn, event.payload.tool, (call) => (call.error = event.payload.message))
        break

      case 'usage':
        turn.usage = {
          inputTokens: sum(turn.usage.inputTokens, event.payload.inputTokens),
          outputTokens: sum(turn.usage.outputTokens, event.payload.outputTokens),
          reasoningTokens: sum(turn.usage.reasoningTokens, event.payload.reasoningTokens),
        }
        break

      case 'warning':
        turn.warnings.push(event.payload.message)
        break

      case 'message.aborted':
        turn.aborted = true
        break

      case 'error':
        turn.error = event.payload.message
        break
    }
  }

  return turn
}

/**
 * O evento de resultado não carrega o id da chamada, então casamos pela ordem: os providers
 * entregam os resultados na sequência em que as tools foram chamadas, e o resultado vai para
 * a chamada mais antiga ainda em aberto daquela tool. Sem correspondência, o resultado é
 * registrado avulso em vez de ser perdido.
 */
function attachToPendingCall(turn: ITurnResult, tool: string, apply: (call: ITurnToolCall) => void): void {
  const pending = turn.toolCalls.find((call) => call.tool === tool && call.result === undefined && call.error === undefined)

  if (pending) return apply(pending)

  const orphan: ITurnToolCall = { tool, args: {} }
  apply(orphan)
  turn.toolCalls.push(orphan)
}

function sum(current: number | undefined, addition: number | undefined): number | undefined {
  if (current === undefined && addition === undefined) return undefined
  return (current ?? 0) + (addition ?? 0)
}
