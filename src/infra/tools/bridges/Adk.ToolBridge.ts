import { FunctionTool, MCPToolset } from '@google/adk'
import { ILocalTool, IToolSchema } from '../Tool.Types'

type TAdkTool = ConstructorParameters<typeof FunctionTool>[0]
type TAdkSchema = NonNullable<TAdkTool['parameters']>

/**
 * O ADK aceita o `Schema` do `@google/genai`, cujos tipos são MAIÚSCULOS — `OBJECT`,
 * `STRING` — e não os do JSON Schema. Daí a conversão.
 */
export function buildAdkTools(local: ILocalTool[]): FunctionTool[] {
  return local.map(
    (item) =>
      new FunctionTool({
        name: item.name,
        description: item.description,
        parameters: toGenAiSchema(item.inputSchema),
        async execute(args: unknown) {
          return item.execute(typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {})
        },
      }),
  )
}

export function buildAdkMcpToolset(remoteUrl?: string): MCPToolset | undefined {
  if (!remoteUrl) return undefined
  return new MCPToolset({ type: 'StreamableHTTPConnectionParams', url: remoteUrl })
}

function toGenAiSchema(schema: IToolSchema): TAdkSchema {
  const properties: Record<string, { type: string; description: string }> = {}

  for (const [key, property] of Object.entries(schema.properties)) {
    properties[key] = { type: property.type.toUpperCase(), description: property.description }
  }

  return { type: 'OBJECT', properties, required: schema.required } as unknown as TAdkSchema
}
