import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { IToolDefinition, IToolResult } from '@infra/tools/Tool.Types'

export interface IManualToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface IManualToolResult {
  call: IManualToolCall
  outcome: IToolResult
}

/** O que uma volta no modelo produziu. */
export interface IManualTurnOutcome {
  text: string
  calls: IManualToolCall[]
}

/**
 * A parte do loop que é irredutivelmente de cada provider.
 *
 * É exatamente isto que o Agents SDK faz por você na lane `agent`: declarar as tools no
 * dialeto do provider, achar a chamada no meio do stream, e escrever chamada e resultado
 * de volta no formato de history daquele SDK.
 */
export interface IManualLoopProvider<TMessage> {
  /** Uma volta: manda o history, emite os eventos do turno e devolve o que o modelo pediu. */
  runTurn(history: TMessage[], tools: IToolDefinition[], signal: AbortSignal): AsyncGenerator<IAgentEvent, IManualTurnOutcome>
  appendAssistant(history: TMessage[], outcome: IManualTurnOutcome): void
  appendToolResults(history: TMessage[], results: IManualToolResult[]): void
}

export interface IManualLoopParams<TMessage> {
  sessionId: string
  history: TMessage[]
  tools: IToolDefinition[]
  provider: IManualLoopProvider<TMessage>
  catalog: ToolCatalog | undefined
  signal: AbortSignal
  maxTurns: number
}

/**
 * O loop agêntico escrito à mão, sobre o SDK normal do provider.
 *
 * Existe para ser comparado: na lane `agent` este arquivo inteiro é substituído por uma
 * chamada ao SDK oficial. Com `tools` vazio ele dá exatamente uma volta, que é o caminho
 * padrão da lane `chat`.
 *
 * Devolve o texto acumulado do turno.
 */
export async function* runManualToolLoop<TMessage>(params: IManualLoopParams<TMessage>): AsyncGenerator<IAgentEvent, string> {
  const { sessionId, history, tools, provider, catalog, signal, maxTurns } = params
  let answer = ''

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const outcome = yield* provider.runTurn(history, tools, signal)
    answer += outcome.text
    provider.appendAssistant(history, outcome)

    if (outcome.calls.length === 0) return answer
    if (signal.aborted) return answer

    const results: IManualToolResult[] = []

    for (const call of outcome.calls) {
      yield {
        type: 'tool.started',
        sessionId,
        timestamp: new Date(),
        payload: { tool: call.name, args: call.args },
      }

      const executed = await execute(catalog, call)
      results.push({ call, outcome: executed })

      yield executed.status === 'error'
        ? { type: 'tool.error', sessionId, timestamp: new Date(), payload: { tool: call.name, message: executed.result } }
        : { type: 'tool.result', sessionId, timestamp: new Date(), payload: { tool: call.name, result: executed.result } }
    }

    // O resultado volta para o modelo mesmo quando a tool falhou: é assim que ele tem
    // chance de corrigir o rumo em vez de ficar esperando.
    provider.appendToolResults(history, results)

    if (signal.aborted) return answer
  }

  yield {
    type: 'warning',
    sessionId,
    timestamp: new Date(),
    payload: { message: `Stopped after ${maxTurns} tool turns; raise MAX_TOOL_TURNS if this was too soon.` },
  }

  return answer
}

async function execute(catalog: ToolCatalog | undefined, call: IManualToolCall): Promise<IToolResult> {
  if (!catalog) {
    return { status: 'error', result: `No tool catalog is wired; cannot run "${call.name}".` }
  }

  // O catálogo já aplica a política do run_bash: deny-list, timeout, cwd e corte de saída.
  return catalog.invoke(call.name, call.args)
}
