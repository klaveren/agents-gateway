import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { aggregateTurn } from './Turn.Aggregator'

const at = new Date(0)
const ev = <T extends IAgentEvent['type']>(type: T, payload?: unknown): IAgentEvent => ({ type, sessionId: 's1', timestamp: at, payload }) as IAgentEvent

describe('aggregateTurn', () => {
  it('joins the text deltas and separates the reasoning', () => {
    const turn = aggregateTurn('s1', [
      ev('message.started'),
      ev('reasoning.delta', { text: 'pensando' }),
      ev('text.delta', { text: 'Olá' }),
      ev('text.delta', { text: ', mundo' }),
      ev('message.completed'),
    ])

    assert.strictEqual(turn.text, 'Olá, mundo')
    assert.strictEqual(turn.reasoning, 'pensando')
    assert.strictEqual(turn.aborted, false)
    assert.strictEqual(turn.error, undefined)
  })

  it('pairs each tool result with the call it answers', () => {
    const turn = aggregateTurn('s1', [
      ev('tool.started', { tool: 'search_web', args: { query: 'selic' } }),
      ev('tool.result', { tool: 'search_web', result: '14%' }),
      ev('tool.started', { tool: 'run_bash', args: { command: 'ls' } }),
      ev('tool.error', { tool: 'run_bash', message: 'refused' }),
    ])

    assert.deepStrictEqual(turn.toolCalls, [
      { tool: 'search_web', args: { query: 'selic' }, result: '14%' },
      { tool: 'run_bash', args: { command: 'ls' }, error: 'refused' },
    ])
  })

  it('pairs repeated calls of the same tool in order', () => {
    const turn = aggregateTurn('s1', [
      ev('tool.started', { tool: 'search_web', args: { query: 'um' } }),
      ev('tool.started', { tool: 'search_web', args: { query: 'dois' } }),
      ev('tool.result', { tool: 'search_web', result: 'primeiro' }),
      ev('tool.result', { tool: 'search_web', result: 'segundo' }),
    ])

    assert.deepStrictEqual(
      turn.toolCalls.map((call) => [call.args.query, call.result]),
      [
        ['um', 'primeiro'],
        ['dois', 'segundo'],
      ],
    )
  })

  it('keeps a result that arrives with no matching call instead of dropping it', () => {
    const turn = aggregateTurn('s1', [ev('tool.result', { tool: 'mystery', result: 'x' })])

    assert.deepStrictEqual(turn.toolCalls, [{ tool: 'mystery', args: {}, result: 'x' }])
  })

  it('sums usage across the turn', () => {
    const turn = aggregateTurn('s1', [ev('usage', { inputTokens: 10 }), ev('usage', { outputTokens: 4, reasoningTokens: 2 }), ev('usage', { outputTokens: 6 })])

    assert.deepStrictEqual(turn.usage, { inputTokens: 10, outputTokens: 10, reasoningTokens: 2 })
  })

  it('collects warnings and marks an aborted turn', () => {
    const turn = aggregateTurn('s1', [ev('warning', { message: 'anexo ignorado' }), ev('text.delta', { text: 'parcial' }), ev('message.aborted')])

    assert.deepStrictEqual(turn.warnings, ['anexo ignorado'])
    assert.strictEqual(turn.aborted, true)
    assert.strictEqual(turn.text, 'parcial')
  })

  it('carries the error message out', () => {
    const turn = aggregateTurn('s1', [ev('error', { message: 'API down' })])

    assert.strictEqual(turn.error, 'API down')
  })
})
