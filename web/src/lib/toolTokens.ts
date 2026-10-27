/**
 * O PESO de uma ferramenta: a definição dela (nome, descrição e esquema dos parâmetros) vai junto em TODA chamada
 * ao modelo de um agente que a tem — é entrada paga, turno a turno, mesmo quando a ferramenta não é usada.
 * ⚖️ Estimativa (≈ 4 caracteres por token, sobre o JSON que o provider recebe): serve para comparar e escolher, não
 * para fechar a conta — cada provider embrulha a definição do seu jeito.
 */
export interface IToolShape {
  name: string
  description?: string
  inputSchema?: unknown
}

export function toolTokens(tool: IToolShape): number {
  return Math.ceil(JSON.stringify({ name: tool.name, description: tool.description ?? '', input_schema: tool.inputSchema ?? {} }).length / 4)
}

export function toolsTokens(tools: readonly IToolShape[]): number {
  return tools.reduce((sum, tool) => sum + toolTokens(tool), 0)
}
