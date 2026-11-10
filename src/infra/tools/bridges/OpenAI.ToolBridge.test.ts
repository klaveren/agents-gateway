import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IToolSchema } from '../Tool.Types'
import { buildOpenAITools, strictable } from './OpenAI.ToolBridge'

const closed: IToolSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }
const open: IToolSchema = { type: 'object', properties: { linhas: { type: 'array', items: { type: 'object' } } }, required: [], additionalProperties: false }

describe('OpenAI.ToolBridge', () => {
  it('schema fechado vai estrito; com objeto aberto (o 400 da OpenAI), vai sem estrito', () => {
    assert.equal(strictable(closed), true)
    assert.equal(strictable(open), false)
    assert.equal(strictable({ type: 'object', additionalProperties: { type: 'integer' } }), false)

    const execute = async () => ({ status: 'success' as const, result: 'ok' })
    const [strict, loose] = buildOpenAITools([
      { name: 'fechada', description: 'f', origin: 'local', inputSchema: closed, execute },
      { name: 'aberta', description: 'a', origin: 'local', inputSchema: open, execute },
    ]) as Array<{ strict: boolean }>
    assert.deepEqual([strict!.strict, loose!.strict], [true, false])
  })
})
