import { FunctionTool, MCPToolset } from '@google/adk'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { ILocalTool, IToolDefinition, IToolSchema } from '../Tool.Types'

type TAdkTool = ConstructorParameters<typeof FunctionTool>[0]
type TAdkSchema = NonNullable<TAdkTool['parameters']>

/**
 * O ADK aceita o `Schema` do `@google/genai`, cujos tipos são MAIÚSCULOS — `OBJECT`,
 * `STRING` — e não os do JSON Schema. Daí a conversão.
 */
/** `context` é lido NA EXECUÇÃO: o runtime do ADK vive a sessão inteira, e o contexto muda a cada turno. */
export function buildAdkTools(local: ILocalTool[], context: () => IExecutionContext | undefined = () => undefined): FunctionTool[] {
  return local.map(
    (item) =>
      new FunctionTool({
        name: item.name,
        description: item.description,
        parameters: toGenAiSchema(item.inputSchema),
        async execute(args: unknown) {
          return item.execute(typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}, context())
        },
      }),
  )
}

/**
 * ⛔ NÃO USE PARA O GEMINI. Mantido porque o `MCPToolset` é o caminho nativo do ADK e volta a ser
 * o certo no dia em que ele sanitizar o schema — mas hoje ele repassa o JSON Schema do MCP como
 * veio, e a API do Gemini recusa `$schema`, `additionalProperties`, `exclusiveMinimum` e outras
 * com HTTP 400. Ver `GEMINI_UNSUPPORTED`.
 */
export function buildAdkMcpToolset(remoteUrl?: string): MCPToolset | undefined {
  if (!remoteUrl) return undefined
  return new MCPToolset({ type: 'StreamableHTTPConnectionParams', url: remoteUrl })
}

/**
 * As tools do MCP como `FunctionTool` do ADK — declaração sanitizada, execução pelo catálogo.
 *
 * ⚖️ POR QUE NÃO O `MCPToolset`. Ele conecta ao MCP sozinho e repassa o schema cru; o Gemini
 * devolve 400, e o ADK entrega isso ao chamador como `MALFORMED_FUNCTION_CALL` — erro que aponta
 * para o modelo, não para o schema. Montando aqui, a declaração passa por `toGenAiSchema` (que
 * remove o que o Gemini recusa) e a execução continua indo pelo mesmo caminho de sempre, o
 * `ToolCatalog`, que já sabe encaminhar para o MCP.
 */
export function buildAdkRemoteTools(tools: IToolDefinition[], execute: (name: string, args: Record<string, unknown>) => Promise<unknown>): FunctionTool[] {
  return tools.map(
    (tool) =>
      new FunctionTool({
        name: tool.name,
        description: tool.description,
        parameters: toGenAiSchema(tool.inputSchema),
        async execute(args: unknown) {
          return execute(tool.name, typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {})
        },
      }),
  )
}

function toGenAiSchema(schema: IToolSchema): TAdkSchema {
  const properties: Record<string, unknown> = {}

  for (const [key, property] of Object.entries(schema.properties)) {
    properties[key] = sanitizeProperty(property as Record<string, unknown>)
  }

  return { type: 'OBJECT', properties, required: schema.required } as unknown as TAdkSchema
}

/**
 * Chaves de JSON Schema que a API do Gemini RECUSA numa declaração de função.
 *
 * ⚖️ Não é preciosismo de formato: a requisição volta **HTTP 400** com
 * `Unknown name "$schema" ... Cannot find field`. Medido contra a API real, uma chave por vez.
 *
 * ⚠️ E o sintoma que isso produz é enganoso. Quando o schema inválido vai pelo `MCPToolset` do
 * ADK, o 400 não chega ao chamador: o turno termina com `finishReason: MALFORMED_FUNCTION_CALL`,
 * como se o MODELO tivesse gerado uma chamada torta. Fui atrás do nome da tool e do dois-pontos do
 * prefixo antes de reproduzir o 400 com o schema real — nenhum dos dois era o problema.
 */
const GEMINI_UNSUPPORTED = new Set([
  '$schema',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'examples',
  '$ref',
  '$defs',
  'definitions',
  'patternProperties',
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'oneOf',
])

/** Copia a propriedade sem as chaves que o Gemini recusa, descendo em objetos e arrays. */
function sanitizeProperty(property: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(property)) {
    if (GEMINI_UNSUPPORTED.has(key)) continue

    if (key === 'type' && typeof value === 'string') {
      clean[key] = value.toUpperCase()
      continue
    }

    // `items` (array) e `properties` (objeto aninhado) carregam schema dentro: precisam do mesmo
    // tratamento, ou a chave proibida sobrevive um nível abaixo.
    if (key === 'items' && value && typeof value === 'object') {
      clean[key] = sanitizeProperty(value as Record<string, unknown>)
      continue
    }

    if (key === 'properties' && value && typeof value === 'object') {
      clean[key] = Object.fromEntries(Object.entries(value as Record<string, Record<string, unknown>>).map(([name, nested]) => [name, sanitizeProperty(nested)]))
      continue
    }

    clean[key] = value
  }

  return clean
}

export { sanitizeProperty }
