import { IExecutionContext } from '@domain/models/ExecutionContext.Model'

/**
 * JSON Schema de entrada de uma tool.
 *
 * ⚠️ `properties` é ABERTO de propósito. A versão anterior declarava
 * `{ type: string; description: string }` e dizia ser "o subconjunto que os três SDKs aceitam" —
 * mas nada validava isso, e o que chega de um MCP server é JSON Schema inteiro: `items`, `enum`,
 * `minimum`, `$schema`, `additionalProperties`. O tipo estreito não impedia nada; só escondia que
 * as chaves extras existiam, e é por isso que elas chegavam intactas na API do Gemini.
 *
 * Quem precisa do subconjunto é o Gemini, e quem o aplica é `sanitizeProperty` no `Adk.ToolBridge`
 * — em código, contra a API real, não numa declaração de tipo que ninguém checa.
 */
export interface IToolSchema {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
  additionalProperties: false
}

export interface IToolDefinition {
  name: string
  description: string
  inputSchema: IToolSchema
  /** `local` = executada em processo pelo gateway; `mcp` = descoberta num MCP server. */
  origin: 'local' | 'mcp'
}

export interface IToolResult {
  status: 'success' | 'error'
  result: string
}

export interface ILocalTool extends IToolDefinition {
  origin: 'local'
  /** `context` = quem chamou e de que turno (a delegação precisa; as outras ignoram). */
  execute(args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult>
}
