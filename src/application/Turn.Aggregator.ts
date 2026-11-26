import { addUsage, IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'

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
  /** As mensagens que entraram no meio do turno, com a posição no texto (ver `Interjection.Policy`). */
  interjections: Array<{ at: number; text: string }>
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
    interjections: [],
    aborted: false,
  }
  // A chamada de cada id, quando o provedor manda o id (o passo do Antigravity): o resultado vai para ELA, nunca por ordem.
  const byId = new Map<string, ITurnToolCall>()

  for (const event of events) {
    switch (event.type) {
      case 'text.delta':
        turn.text += event.payload.text
        break

      case 'reasoning.delta':
        turn.reasoning += event.payload.text
        break

      case 'tool.started': {
        const call: ITurnToolCall = { tool: event.payload.tool, args: event.payload.args }
        turn.toolCalls.push(call)
        if (event.payload.callId !== undefined) byId.set(event.payload.callId, call)
        break
      }

      case 'tool.result':
        attachToCall(turn, byId, event.payload, (call) => (call.result = event.payload.result))
        break

      case 'tool.error':
        attachToCall(turn, byId, event.payload, (call) => (call.error = event.payload.message))
        break

      case 'usage':
        turn.usage = addUsage(turn.usage, event.payload)
        break

      case 'warning':
        turn.warnings.push(event.payload.message)
        break

      case 'message.aborted':
        turn.aborted = true
        break

      case 'message.injected':
        turn.interjections.push({ at: turn.text.length, text: event.payload.text })
        break

      case 'error':
        turn.error = event.payload.message
        break
    }
  }

  return turn
}

/**
 * Pelo id, quando o evento o traz: a chamada dele, ou avulso (nunca a "mais antiga em aberto": um passo que não fechou
 * empurrava cada resultado seguinte para a chamada de antes). Sem id, pela ordem (ver `attachToPendingCall`).
 */
function attachToCall(turn: ITurnResult, byId: Map<string, ITurnToolCall>, payload: { tool: string; callId?: string }, apply: (call: ITurnToolCall) => void): void {
  if (payload.callId === undefined) return attachToPendingCall(turn, payload.tool, apply)
  const call = byId.get(payload.callId)
  if (call) return apply(call)
  const orphan: ITurnToolCall = { tool: payload.tool, args: {} }
  apply(orphan)
  turn.toolCalls.push(orphan)
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
