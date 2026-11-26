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

  it('⛔ oneOf (e outras palavras que o estrito recusa) vai sem estrito, em vez de derrubar o turno; anyOf segue estrito', () => {
    const withOneOf = {
      type: 'object',
      properties: { status: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: [],
      additionalProperties: false,
    }
    const withAnyOf = {
      type: 'object',
      properties: { status: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: [],
      additionalProperties: false,
    }
    assert.equal(strictable(withOneOf), false)
    assert.equal(strictable(withAnyOf), true)
    const execute = async () => ({ status: 'success' as const, result: 'ok' })
    const tools = buildOpenAITools([{ name: 'com_oneof', description: 'x', origin: 'local', inputSchema: withOneOf as IToolSchema, execute }]) as Array<{ strict: boolean }>
    assert.equal(tools[0]!.strict, false)
  })

  it('o board (o caso real): todas as ferramentas locais, com o board, montam no estrito sem lançar erro', async () => {
    const { makeLocalTools } = await import('../Local.Tools')
    const all = makeLocalTools({ panels: {} as never })
    assert.ok(all.some((item) => item.name === 'board'))
    assert.doesNotThrow(() => buildOpenAITools(all))
    const board = (buildOpenAITools(all.filter((item) => item.name === 'board')) as Array<{ strict: boolean }>)[0]!
    assert.equal(board.strict, true)
  })
})
