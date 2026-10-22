import assert from 'node:assert'
import { describe, it } from 'node:test'
import { buildAdkRemoteTools, sanitizeProperty } from './Adk.ToolBridge'
import { IToolDefinition } from '../Tool.Types'

/**
 * O que estes testes protegem não é formato: é um HTTP 400 da API do Gemini que chega ao chamador
 * disfarçado de `MALFORMED_FUNCTION_CALL` — como se o MODELO tivesse gerado uma chamada torta.
 * Cada chave abaixo foi medida contra a API real, uma por vez. Sem isto, a próxima pessoa que
 * "simplificar" a sanitização reintroduz um erro que aponta para o lugar errado.
 */
describe('Adk.ToolBridge — Gemini schema sanitization', () => {
  it('drops the JSON Schema keys the API rejects', () => {
    const clean = sanitizeProperty({
      type: 'string',
      description: 'código do SKU',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      exclusiveMinimum: 1,
      const: 'x',
    })

    assert.deepStrictEqual(clean, { type: 'STRING', description: 'código do SKU' })
  })

  it('keeps what Gemini accepts', () => {
    const clean = sanitizeProperty({ type: 'integer', description: 'quantidade', minimum: 1, maximum: 200, enum: [1, 2] })

    assert.deepStrictEqual(clean, { type: 'INTEGER', description: 'quantidade', minimum: 1, maximum: 200, enum: [1, 2] })
  })

  it('descends into `items`, or the rejected key survives one level down', () => {
    const clean = sanitizeProperty({ type: 'array', items: { type: 'string', $schema: 'x', additionalProperties: false } })

    assert.deepStrictEqual(clean, { type: 'ARRAY', items: { type: 'STRING' } })
  })

  it('descends into nested `properties`', () => {
    const clean = sanitizeProperty({
      type: 'object',
      properties: { code: { type: 'string', exclusiveMinimum: 0 }, nested: { type: 'object', properties: { deep: { type: 'number', $ref: '#/x' } } } },
    })

    assert.deepStrictEqual(clean, {
      type: 'OBJECT',
      properties: { code: { type: 'STRING' }, nested: { type: 'OBJECT', properties: { deep: { type: 'NUMBER' } } } },
    })
  })
})

describe('Adk.ToolBridge — remote tools', () => {
  const definition: IToolDefinition = {
    origin: 'mcp',
    name: 'seller_sku_resolve',
    description: 'resolve códigos',
    inputSchema: { type: 'object', properties: { codes: { type: 'array', items: { type: 'string' } } }, required: ['codes'], additionalProperties: false },
  }

  it('declares the tool with the schema already sanitized', () => {
    const [tool] = buildAdkRemoteTools([definition], async () => ({}))

    assert.strictEqual(tool.name, 'seller_sku_resolve')
    assert.deepStrictEqual((tool as unknown as { parameters: unknown }).parameters, {
      type: 'OBJECT',
      properties: { codes: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['codes'],
    })
  })

  it('executes through the catalog rather than its own connection', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const [tool] = buildAdkRemoteTools([definition], async (name, args) => {
      calls.push({ name, args })
      return { status: 'success' }
    })

    await (tool as unknown as { execute: (args: unknown) => Promise<unknown> }).execute({ codes: ['A1'] })

    assert.deepStrictEqual(calls, [{ name: 'seller_sku_resolve', args: { codes: ['A1'] } }])
  })
})
