/**
 * ⚖️ O USO POR FERRAMENTA é ESTIMATIVA: o provedor cobra por chamada ao modelo, nunca por ferramenta. O que o gateway
 * grava de cada chamada (os argumentos e o resultado) dá o tamanho dela, e o tamanho dá os tokens (`CHARS_PER_TOKEN`).
 *
 * - **Diretos:** os argumentos (o modelo os escreveu) mais o resultado (o modelo o leu uma vez).
 * - **No contexto:** o resultado fica na conversa e é relido a cada passo seguinte do turno — é onde o cache lido vem.
 *   Cada chamada depois dela no turno conta como um passo que a releu. A soma do turno nunca passa da entrada que o
 *   provedor informou para ele (a entrada nova, o cache lido e o gravado): o que sobra é do resto da conversa.
 */
export interface IToolUsage {
  tool: string
  calls: number
  errors: number
  /** Argumentos + resultado, uma vez. */
  directTokens: number
  /** O resultado relido nos passos seguintes do turno. */
  contextTokens: number
}

/** Uma chamada como o turno a grava (`tool_calls`). */
export interface IStoredToolCall {
  tool?: string
  args?: unknown
  result?: unknown
  error?: unknown
}

/** A régua de sempre para texto misto (português, JSON, código). */
export const CHARS_PER_TOKEN = 4

const tokensOf = (value: unknown): number => {
  if (value === undefined || value === null) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** O texto do resultado: os blocos `{type:'text', text}` pelo texto; o resto, pelo JSON. */
const resultText = (result: unknown): unknown =>
  Array.isArray(result)
    ? result.map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : JSON.stringify(block))).join('')
    : result

/** O que cada ferramenta pesou NUM turno. `inputTokens`: a entrada que o provedor informou para o turno (o teto do contexto). */
export function toolUsageOfTurn(calls: readonly IStoredToolCall[], inputTokens: number): IToolUsage[] {
  const by = new Map<string, IToolUsage>()
  const reread: Array<{ entry: IToolUsage; tokens: number }> = []
  calls.forEach((call, index) => {
    const tool = typeof call.tool === 'string' && call.tool ? call.tool : 'desconhecida'
    const entry = by.get(tool) ?? by.set(tool, { tool, calls: 0, errors: 0, directTokens: 0, contextTokens: 0 }).get(tool)!
    const result = tokensOf(call.error ?? resultText(call.result))
    entry.calls += 1
    if (call.error) entry.errors += 1
    entry.directTokens += tokensOf(call.args) + result
    reread.push({ entry, tokens: result * (calls.length - 1 - index) })
  })
  const total = reread.reduce((sum, item) => sum + item.tokens, 0)
  const scale = total > inputTokens && total > 0 ? Math.max(0, inputTokens) / total : 1
  for (const item of reread) item.entry.contextTokens += Math.round(item.tokens * scale)
  return [...by.values()]
}

/** As ferramentas de vários turnos somadas, da que mais pesou à que menos. */
export function sumToolUsage(parts: Iterable<readonly IToolUsage[]>): IToolUsage[] {
  const by = new Map<string, IToolUsage>()
  for (const part of parts)
    for (const item of part) {
      const entry = by.get(item.tool) ?? by.set(item.tool, { tool: item.tool, calls: 0, errors: 0, directTokens: 0, contextTokens: 0 }).get(item.tool)!
      entry.calls += item.calls
      entry.errors += item.errors
      entry.directTokens += item.directTokens
      entry.contextTokens += item.contextTokens
    }
  return [...by.values()].sort((a, b) => b.directTokens + b.contextTokens - (a.directTokens + a.contextTokens))
}
