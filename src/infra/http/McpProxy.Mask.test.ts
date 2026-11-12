import assert from 'node:assert'
import { describe, it } from 'node:test'
import { maskToolResult } from './McpProxy.Controller'

describe('maskToolResult', () => {
  it('⛔ o valor secreto sai trocado no texto e no structuredContent; imagem passa como veio', () => {
    const mask = (text: string) => text.replaceAll('tok-123', '[segredo:FX_TOKEN]')
    const image = { type: 'image', data: 'tok-123', mimeType: 'image/png' }
    const result = maskToolResult({ content: [{ type: 'text', text: '{"token":"tok-123"}' }, image], structuredContent: { token: 'tok-123' }, isError: false }, mask)
    assert.deepStrictEqual(result, {
      content: [{ type: 'text', text: '{"token":"[segredo:FX_TOKEN]"}' }, image],
      structuredContent: { token: '[segredo:FX_TOKEN]' },
      isError: false,
    })
    assert.deepStrictEqual(maskToolResult({ content: [] }, mask), { content: [] })
  })
})
