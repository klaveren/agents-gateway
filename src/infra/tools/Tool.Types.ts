/** JSON Schema de entrada de uma tool, no subconjunto que os três SDKs aceitam. */
export interface IToolSchema {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
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
  execute(args: Record<string, unknown>): Promise<IToolResult>
}
