/**
 * O PESO estimado, em tokens, do que vai para o modelo (≈ 4 caracteres por token).
 * ⚖️ Para comparar e escolher — o que pesa num agente, o que cortar —, não para fechar a conta: cada provider conta
 * e embrulha do seu jeito. A tela usa a mesma conta (`web/src/lib/toolTokens.ts`).
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4)

/** A definição de uma ferramenta, como o provider a recebe em TODA chamada: nome, descrição e esquema. */
export function toolTokens(tool: { name: string; description?: string; inputSchema?: unknown }): number {
  return estimateTokens(JSON.stringify({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema ?? {} }))
}
